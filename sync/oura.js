// Oura -> observations. Runs as a Render cron job next to the database.
//   env: DATABASE_URL, OURA_TOKEN (personal access token), OURA_USER_EMAIL (which pdayminder user),
//        OURA_DAYS (lookback, default 3; set 365 once for a backfill)
// Metrics written (source = 'oura'):
//   per night (ts = local midnight of the day the sleep ended):
//     sleep_score, total_sleep_h, deep_h, rem_h, light_h, awake_h, efficiency, latency_min,
//     avg_hrv, lowest_hr, avg_hr, avg_breath, bedtime_start_hour, bedtime_end_hour
//   per day (ts = local midnight):
//     readiness_score, temperature_deviation, resting_hr (readiness contributors), activity_score,
//     steps, active_cal, total_cal, inactive_h, stress_high_min, recovery_high_min, spo2_avg
//   5-minute HR samples are skipped (too many rows); HAE already covers hourly HR.

const { pool } = require("../db");

const TZ = process.env.TZ_NAME || "America/Los_Angeles";
const DAYS = Number(process.env.OURA_DAYS || 3);
const API = process.env.OURA_API || "https://api.ouraring.com/v2/usercollection";
const TOKEN_URL = process.env.OURA_TOKEN_URL || "https://api.ouraring.com/oauth/token";
let TOKEN = process.env.OURA_TOKEN || null; // legacy PAT fallback; OAuth tokens from the db take precedence

// Load the OAuth token for the user; refresh if it expires within the hour. Refresh tokens rotate, so save the new one.
async function loadToken(userId) {
  const { rows } = await pool.query("select * from oauth_tokens where user_id = $1 and provider = 'oura'", [userId]);
  const t = rows[0];
  if (!t) return TOKEN;
  const fresh = t.expires_at && new Date(t.expires_at) - Date.now() > 3600 * 1000;
  if (fresh) return t.access_token;
  if (!t.refresh_token) return t.access_token;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: t.refresh_token,
    client_id: process.env.OURA_CLIENT_ID || "",
    client_secret: process.env.OURA_CLIENT_SECRET || "",
  });
  const r = await fetch(TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  const tok = await r.json();
  if (!r.ok || !tok.access_token) throw new Error("token refresh failed: " + JSON.stringify(tok));
  await pool.query(
    `update oauth_tokens set access_token = $2, refresh_token = coalesce($3, refresh_token),
       expires_at = now() + ($4 || ' seconds')::interval, updated_at = now() where user_id = $1 and provider = 'oura'`,
    [userId, tok.access_token, tok.refresh_token || null, String(tok.expires_in || 86400)]
  );
  console.log("oura token refreshed");
  return tok.access_token;
}

function localMidnightIso(dateStr) {
  const guess = new Date(dateStr + "T00:00:00Z");
  const offsetMin =
    (new Date(guess.toLocaleString("en-US", { timeZone: TZ })) -
      new Date(guess.toLocaleString("en-US", { timeZone: "UTC" }))) / 60000;
  return new Date(guess.getTime() - offsetMin * 60000).toISOString();
}

function hourOfLocal(iso) {
  if (!iso) return null;
  const parts = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "numeric", hour12: false, timeZone: TZ }).formatToParts(new Date(iso));
  const h = Number(parts.find((p) => p.type === "hour").value) % 24;
  const m = Number(parts.find((p) => p.type === "minute").value);
  return h + m / 60;
}

async function fetchAll(path, params) {
  const out = [];
  let next = null;
  do {
    const url = new URL(`${API}/${path}`);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    if (next) url.searchParams.set("next_token", next);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${await res.text()}`);
    const json = await res.json();
    out.push(...(json.data || []));
    next = json.next_token || null;
  } while (next);
  return out;
}

async function upsert(client, userId, ts, metric, value, raw) {
  if (value == null || Number.isNaN(Number(value))) return 0;
  await client.query(
    `insert into observations (user_id, ts, source, metric, value, raw) values ($1,$2,'oura',$3,$4,$5)
     on conflict (user_id, source, metric, ts) do update set value = excluded.value, raw = excluded.raw`,
    [userId, ts, metric, Number(value), raw || null]
  );
  return 1;
}

async function main() {
  const email = (process.env.OURA_USER_EMAIL || "").toLowerCase();
  const u = email
    ? await pool.query("select id from users where email = $1", [email])
    : await pool.query("select id from users order by id limit 1");
  if (!u.rows[0]) throw new Error("no pdayminder user found");
  const userId = u.rows[0].id;
  TOKEN = await loadToken(userId);
  if (!TOKEN) throw new Error("Oura not connected: open pdayminder > Settings > Connect Oura");

  // Oura treats end_date as exclusive on several endpoints, so ask through tomorrow.
  const end = new Date(Date.now() + 86400000);
  const start = new Date(Date.now() - DAYS * 86400000);
  const fmt = (d) => d.toLocaleDateString("en-CA", { timeZone: TZ });
  const range = { start_date: fmt(start), end_date: fmt(end) };
  console.log(`oura sync ${range.start_date}..${range.end_date} for user ${userId}`);

  const [sleep, dailySleep, readiness, activity, stress, spo2] = await Promise.all([
    fetchAll("sleep", range),
    fetchAll("daily_sleep", range),
    fetchAll("daily_readiness", range),
    fetchAll("daily_activity", range),
    fetchAll("daily_stress", range).catch(() => []),
    fetchAll("daily_spo2", range).catch(() => []),
  ]);

  const client = await pool.connect();
  let n = 0;
  try {
    await client.query("begin");
    // Long sleep sessions only (skip naps/rest); one per day, keyed on the day it ended.
    const nights = {};
    for (const s of sleep) {
      if (s.type && s.type !== "long_sleep") continue;
      const prev = nights[s.day];
      if (!prev || (s.total_sleep_duration || 0) > (prev.total_sleep_duration || 0)) nights[s.day] = s;
    }
    for (const [day, s] of Object.entries(nights)) {
      const ts = localMidnightIso(day);
      const h = (sec) => (sec == null ? null : sec / 3600);
      const slim = { id: s.id, day, bedtime_start: s.bedtime_start, bedtime_end: s.bedtime_end, type: s.type };
      n += await upsert(client, userId, ts, "total_sleep_h", h(s.total_sleep_duration), slim);
      n += await upsert(client, userId, ts, "deep_h", h(s.deep_sleep_duration), slim);
      n += await upsert(client, userId, ts, "rem_h", h(s.rem_sleep_duration), slim);
      n += await upsert(client, userId, ts, "light_h", h(s.light_sleep_duration), slim);
      n += await upsert(client, userId, ts, "awake_h", h(s.awake_time), slim);
      n += await upsert(client, userId, ts, "time_in_bed_h", h(s.time_in_bed), slim);
      n += await upsert(client, userId, ts, "efficiency", s.efficiency, slim);
      n += await upsert(client, userId, ts, "latency_min", s.latency == null ? null : s.latency / 60, slim);
      n += await upsert(client, userId, ts, "avg_hrv", s.average_hrv, slim);
      n += await upsert(client, userId, ts, "lowest_hr", s.lowest_heart_rate, slim);
      n += await upsert(client, userId, ts, "avg_hr", s.average_heart_rate, slim);
      n += await upsert(client, userId, ts, "avg_breath", s.average_breath, slim);
      n += await upsert(client, userId, ts, "bedtime_start_hour", hourOfLocal(s.bedtime_start), slim);
      n += await upsert(client, userId, ts, "bedtime_end_hour", hourOfLocal(s.bedtime_end), slim);
    }
    for (const d of dailySleep) {
      n += await upsert(client, userId, localMidnightIso(d.day), "sleep_score", d.score, { contributors: d.contributors });
    }
    for (const d of readiness) {
      const ts = localMidnightIso(d.day);
      n += await upsert(client, userId, ts, "readiness_score", d.score, { contributors: d.contributors });
      n += await upsert(client, userId, ts, "temperature_deviation", d.temperature_deviation, null);
      n += await upsert(client, userId, ts, "temperature_trend_deviation", d.temperature_trend_deviation, null);
    }
    for (const d of activity) {
      const ts = localMidnightIso(d.day);
      n += await upsert(client, userId, ts, "activity_score", d.score, { contributors: d.contributors });
      n += await upsert(client, userId, ts, "steps", d.steps, null);
      n += await upsert(client, userId, ts, "active_cal", d.active_calories, null);
      n += await upsert(client, userId, ts, "total_cal", d.total_calories, null);
      n += await upsert(client, userId, ts, "inactive_h", d.sedentary_time == null ? null : d.sedentary_time / 3600, null);
      n += await upsert(client, userId, ts, "high_activity_min", d.high_activity_time == null ? null : d.high_activity_time / 60, null);
      n += await upsert(client, userId, ts, "medium_activity_min", d.medium_activity_time == null ? null : d.medium_activity_time / 60, null);
    }
    for (const d of stress) {
      const ts = localMidnightIso(d.day);
      n += await upsert(client, userId, ts, "stress_high_min", d.stress_high == null ? null : d.stress_high / 60, { summary: d.day_summary });
      n += await upsert(client, userId, ts, "recovery_high_min", d.recovery_high == null ? null : d.recovery_high / 60, null);
    }
    for (const d of spo2) {
      n += await upsert(client, userId, localMidnightIso(d.day), "spo2_avg", d.spo2_percentage && d.spo2_percentage.average, null);
    }
    await client.query(
      "insert into ingest_log (user_id, route, status, rows, bytes, summary) values ($1,'oura-sync',200,$2,0,$3)",
      [userId, n, { range, sleep: sleep.length, nights: Object.keys(nights).length, readiness: readiness.length, activity: activity.length }]
    );
    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
  console.log(`oura sync wrote ${n} rows (${Object.keys(sleep).length} sleep sessions, ${readiness.length} readiness, ${activity.length} activity)`);
}

main()
  .then(() => pool.end())
  .catch(async (e) => {
    console.error("oura sync failed:", e.message);
    try {
      await pool.query("insert into ingest_log (route, status, rows, bytes, summary) values ('oura-sync', 500, 0, 0, $1)", [{ error: e.message }]);
    } catch {}
    await pool.end();
    process.exit(1);
  });
