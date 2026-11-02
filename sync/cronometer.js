// Cronometer -> observations. Runs as a Render cron job next to the database.
//   env: DATABASE_URL, CRONOMETER_EMAIL, CRONOMETER_PASSWORD, CRONOMETER_USER_EMAIL (which pdayminder user),
//        CRONOMETER_DAYS (lookback, default 3), TZ_NAME
//
// Cronometer has no public API. This uses the web app's login + "Export Data" endpoints (the same calls the
// browser makes when you export a CSV), via the GWT-RPC handshake documented by the gocronometer and
// cronometer-mcp projects. The GWT hashes are discovered from the app's own JS each run, with fallbacks.
// The session cookie is kept in oauth_tokens (provider 'cronometer') so most runs skip the login, which
// Cronometer rate-limits.
//
// Written (source = 'cronometer'), one row per local hour that has entries:
//   every nutrient column of the servings export, name normalised ("Protein (g)" -> protein, "Vitamin B12 (µg)"
//   -> vitamin_b12, "Energy (kcal)" -> energy, "Fiber (g)" -> fiber, "Omega-3 (g)" -> omega_3 ...), summed per hour.
//   supp_<slug> for each supplement entry (Category or Group mentions supplements, or the name matches a supplement
//   keyword such as creatine): value = numeric part of the Amount, raw = {name, amount, group}.
// Entries with no Time get a nominal time by Group (Breakfast 08:00, Lunch 12:30, Dinner 18:30, otherwise 15:00).
// The lookback window is rewritten wholesale each run, so edits and deletions in Cronometer propagate.

const { pool } = require("../db");

const TZ = process.env.TZ_NAME || "America/Los_Angeles";
const DAYS = Number(process.env.CRONOMETER_DAYS || 3);
const BASE = process.env.CRONOMETER_BASE || "https://cronometer.com";
const GWT = {
  contentType: "text/x-gwt-rpc; charset=UTF-8",
  moduleBase: `${BASE}/cronometer/`,
  permutation: process.env.CRONOMETER_GWT_PERMUTATION || "CBC38FBB0A1527BD5E68722DD9DABD27",
  header: process.env.CRONOMETER_GWT_HEADER || "76FC4464E20E53D16663AC9A96A486B3",
};
const GROUP_TIME = { breakfast: "08:00", lunch: "12:30", dinner: "18:30" };
const SUPPLEMENT_RE = /creatine|vitamin|omega|fish oil|magnesium|zinc|supplement|probiotic|coq10|coenzyme|melatonin|nac\b|glycine|taurine|ashwagandha|turmeric|curcumin|electrolyte|multivit|b12|d3\b|glutathione|citicoline|lion'?s mane|mucuna|nicotinamide|nmn\b|nr\b|urolithin/i;

// ---------- tiny cookie jar ----------
class Jar {
  constructor() { this.c = {}; }
  absorb(res) { (res.headers.getSetCookie ? res.headers.getSetCookie() : []).forEach((sc) => { const [kv] = sc.split(";"); const i = kv.indexOf("="); if (i > 0) this.c[kv.slice(0, i).trim()] = kv.slice(i + 1).trim(); }); }
  header() { return Object.entries(this.c).map(([k, v]) => `${k}=${v}`).join("; "); }
}
async function req(jar, url, opts = {}) {
  const headers = { "user-agent": "Mozilla/5.0 (pdayminder cronometer-sync)", ...(opts.headers || {}) };
  if (jar.header()) headers.cookie = jar.header();
  const res = await fetch(url, { ...opts, headers, redirect: "manual" });
  jar.absorb(res);
  return res;
}

// ---------- Cronometer client ----------
async function discoverHashes(jar) {
  try {
    const boot = await (await req(jar, `${BASE}/cronometer/cronometer.nocache.js`)).text();
    const perm = boot.match(/='([A-F0-9]{32})'/);
    if (!perm) return;
    GWT.permutation = perm[1];
    const app = await (await req(jar, `${BASE}/cronometer/${perm[1]}.cache.js`)).text();
    const hdr = app.match(/'app','([A-F0-9]{32})'/);
    if (hdr) GWT.header = hdr[1];
    console.log(`gwt hashes: permutation=${GWT.permutation} header=${GWT.header}`);
  } catch (e) {
    console.warn("gwt hash discovery failed, using defaults:", e.message);
  }
}
async function gwtPost(jar, body) {
  const res = await req(jar, `${BASE}/cronometer/app`, {
    method: "POST", body,
    headers: { "content-type": GWT.contentType, "x-gwt-module-base": GWT.moduleBase, "x-gwt-permutation": GWT.permutation },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`gwt ${res.status}: ${text.slice(0, 200)}`);
  return text;
}
async function login(jar, email, password) {
  const page = await (await req(jar, `${BASE}/login/`)).text();
  const m = page.match(/name="anticsrf"\s+value="([^"]+)"/);
  if (!m) throw new Error("no anticsrf on login page");
  const res = await req(jar, `${BASE}/login`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ anticsrf: m[1], username: email, password }),
  });
  const j = await res.json().catch(() => ({}));
  if (j.error) throw new Error("login failed: " + j.error);
  if (!jar.c.sesnonce) throw new Error("login gave no sesnonce cookie");
  const auth = await gwtPost(jar, `7|0|5|${GWT.moduleBase}|${GWT.header}|com.cronometer.shared.rpc.CronometerService|authenticate|java.lang.Integer/3438268394|1|2|3|4|1|5|5|-300|`);
  const uid = auth.match(/OK\[(\d+),/);
  if (!uid) throw new Error("gwt authenticate failed: " + auth.slice(0, 200));
  return uid[1];
}
async function exportToken(jar, userId) {
  const body = `7|0|8|${GWT.moduleBase}|${GWT.header}|com.cronometer.shared.rpc.CronometerService|generateAuthorizationToken|java.lang.String/2004016611|I|com.cronometer.shared.user.AuthScope/2065601159|${jar.c.sesnonce}|1|2|3|4|4|5|6|6|7|8|${userId}|3600|7|2|`;
  const text = await gwtPost(jar, body);
  if (text.trim().startsWith("//EX")) throw Object.assign(new Error("session expired: " + text.slice(0, 120)), { expired: true });
  const t = text.match(/"([^"]+)"/);
  if (!t) throw new Error("no export token: " + text.slice(0, 200));
  return t[1];
}
async function exportCsv(jar, token, generate, start, end) {
  const u = new URL(`${BASE}/export`);
  u.searchParams.set("nonce", token); u.searchParams.set("generate", generate); u.searchParams.set("start", start); u.searchParams.set("end", end);
  const res = await req(jar, u, { headers: { "sec-fetch-dest": "document", "sec-fetch-mode": "navigate", "sec-fetch-site": "same-origin" } });
  const text = await res.text();
  if (!res.ok) throw new Error(`export ${generate} ${res.status}: ${text.slice(0, 200)}`);
  return text;
}

// ---------- CSV ----------
function parseCsv(text) {
  const rows = []; let row = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(field); rows.push(row); row = []; field = ""; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  const [head, ...body] = rows.filter((r) => r.length > 1 || (r[0] || "").trim());
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), (r[i] || "").trim()])));
}
const META = new Set(["Day", "Date", "Time", "Group", "Food Name", "Amount", "Unit", "Category", "Completed"]);
function metricName(col) {
  return col.replace(/\(.*?\)/g, "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}
function unitOf(col) { const m = col.match(/\(([^)]*)\)/); return m ? m[1] : null; }
function localIso(day, hhmm) {
  // Interpret day + time in TZ and return an ISO instant.
  const guess = new Date(`${day}T${hhmm}:00Z`);
  const off = (d) => (new Date(d.toLocaleString("en-US", { timeZone: TZ })) - new Date(d.toLocaleString("en-US", { timeZone: "UTC" }))) / 60000;
  let t = new Date(guess.getTime() - off(guess) * 60000);
  t = new Date(guess.getTime() - off(t) * 60000); // second pass handles DST transition days
  return t.toISOString();
}
function hourKey(row) {
  const day = row.Day || row.Date; if (!/^\d{4}-\d{2}-\d{2}$/.test(day || "")) return null;
  let t = (row.Time || "").match(/^(\d{1,2}):(\d{2})\s*([AaPp][Mm])?/);
  let hh = t ? Number(t[1]) : null;
  if (t && t[3]) { const pm = /p/i.test(t[3]); if (pm && hh < 12) hh += 12; if (!pm && hh === 12) hh = 0; }
  if (hh == null) { const g = (row.Group || "").toLowerCase(); const nominal = Object.keys(GROUP_TIME).find((k) => g.includes(k)); hh = Number((nominal ? GROUP_TIME[nominal] : "15:00").slice(0, 2)); }
  return { day, ts: localIso(day, String(hh).padStart(2, "0") + ":00"), entryTs: localIso(day, t ? `${String(hh).padStart(2, "0")}:${t[2]}` : String(hh).padStart(2, "0") + ":00") };
}
function isSupplement(row) {
  return /supplement/i.test(row.Category || "") || /supplement/i.test(row.Group || "") || SUPPLEMENT_RE.test(row["Food Name"] || "");
}
function slug(s) { return s.toLowerCase().replace(/\(.*?\)/g, "").replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40); }

// ---------- main ----------
async function main() {
  const email = (process.env.CRONOMETER_EMAIL || "").trim(), password = process.env.CRONOMETER_PASSWORD || "";
  if (!email || !password) throw new Error("CRONOMETER_EMAIL and CRONOMETER_PASSWORD are required");
  const who = (process.env.CRONOMETER_USER_EMAIL || "").toLowerCase();
  const u = who ? await pool.query("select id from users where email = $1", [who]) : await pool.query("select id from users order by id limit 1");
  if (!u.rows[0]) throw new Error("no pdayminder user found");
  const userId = u.rows[0].id;

  const jar = new Jar();
  await discoverHashes(jar);
  // Reuse a saved session when possible.
  let cronUser = null;
  const saved = await pool.query("select * from oauth_tokens where user_id = $1 and provider = 'cronometer'", [userId]);
  if (saved.rows[0]) { jar.c.sesnonce = saved.rows[0].access_token; cronUser = saved.rows[0].refresh_token; }
  let token;
  try { if (!cronUser) throw Object.assign(new Error("no session"), { expired: true }); token = await exportToken(jar, cronUser); }
  catch (e) {
    if (!e.expired) throw e;
    cronUser = await login(jar, email, password);
    token = await exportToken(jar, cronUser);
    await pool.query(
      `insert into oauth_tokens (user_id, provider, access_token, refresh_token, scope, updated_at) values ($1,'cronometer',$2,$3,$4,now())
       on conflict (user_id, provider) do update set access_token = excluded.access_token, refresh_token = excluded.refresh_token, scope = excluded.scope, updated_at = now()`,
      [userId, jar.c.sesnonce, cronUser, JSON.stringify(GWT)]
    );
    console.log("cronometer: logged in");
  }

  const fmt = (d) => d.toLocaleDateString("en-CA", { timeZone: TZ });
  const end = fmt(new Date()), start = fmt(new Date(Date.now() - (DAYS - 1) * 86400000));
  // Two exports: servings (entry names, times, amounts; nutrients per entry only on accounts whose export includes
  // them) and the daily summary (every nutrient, one row per day). Nutrients come from servings per hour when
  // present, otherwise from the daily summary keyed to local midnight; never both.
  const csv = await exportCsv(jar, token, "servings", start, end);
  const rows = parseCsv(csv);
  const cols = rows.length ? Object.keys(rows[0]) : [];
  const servingsHasNutrients = cols.some((c) => !META.has(c) && rows.some((r) => r[c] !== "" && isFinite(Number(r[c]))));
  console.log(`cronometer servings ${start}..${end}: ${rows.length} entries, ${cols.length} columns${servingsHasNutrients ? " (with nutrients)" : ""}`);
  // The export nonce is single-use: mint a fresh one for the second export.
  const dailyCsv = await exportCsv(jar, await exportToken(jar, cronUser), "dailySummary", start, end);
  const daily = parseCsv(dailyCsv);
  console.log(`cronometer daily summary: ${daily.length} days, ${daily.length ? Object.keys(daily[0]).length : 0} columns`);

  // Aggregate per hour; collect supplements.
  const hours = {}; const supps = []; const units = {};
  for (const r of rows) {
    const k = hourKey(r); if (!k) continue;
    const h = (hours[k.ts] = hours[k.ts] || { day: k.day, sums: {}, n: 0 }); h.n++;
    h.sums.entries = (h.sums.entries || 0) + 1;
    if (servingsHasNutrients) for (const [col, val] of Object.entries(r)) {
      if (META.has(col) || val === "") continue;
      const v = Number(val); if (!isFinite(v)) continue;
      const m = metricName(col); if (!m) continue;
      h.sums[m] = (h.sums[m] || 0) + v; units[m] = unitOf(col);
    }
    if (isSupplement(r)) {
      const amt = Number(String(r.Amount || "").match(/[\d.]+/)?.[0]) || 1;
      supps.push({ ts: k.entryTs, metric: "supp_" + slug(r["Food Name"] || "supplement"), value: amt, raw: { name: r["Food Name"], amount: r.Amount, group: r.Group, category: r.Category } });
    }
  }

  // Daily totals from the summary export, at local midnight (skipped when servings already carried nutrients).
  const dailyRows = [];
  if (!servingsHasNutrients) for (const r of daily) {
    const day = r.Date || r.Day; if (!/^\d{4}-\d{2}-\d{2}$/.test(day || "")) continue;
    const ts = localIso(day, "00:00");
    for (const [col, val] of Object.entries(r)) {
      if (META.has(col) || val === "") continue;
      const v = Number(val); if (!isFinite(v)) continue;
      const m = metricName(col); if (!m || m === "entries") continue;
      dailyRows.push({ ts, metric: m, value: v, raw: { units: unitOf(col), granularity: "day" } });
    }
  }

  const client = await pool.connect(); let n = 0;
  try {
    await client.query("begin");
    await client.query(
      `delete from observations where user_id = $1 and source = 'cronometer' and (ts at time zone $2)::date between $3::date and $4::date`,
      [userId, TZ, start, end]
    );
    for (const [ts, h] of Object.entries(hours)) {
      for (const [m, v] of Object.entries(h.sums)) {
        await client.query(
          `insert into observations (user_id, ts, source, metric, value, raw) values ($1,$2,'cronometer',$3,$4,$5)
           on conflict (user_id, source, metric, ts) do update set value = excluded.value, raw = excluded.raw`,
          [userId, ts, m, Number(v.toFixed(4)), { units: units[m], entries: h.n }]
        ); n++;
      }
    }
    for (const d of dailyRows) {
      await client.query(
        `insert into observations (user_id, ts, source, metric, value, raw) values ($1,$2,'cronometer',$3,$4,$5)
         on conflict (user_id, source, metric, ts) do update set value = excluded.value, raw = excluded.raw`,
        [userId, d.ts, d.metric, Number(d.value.toFixed(4)), d.raw]
      ); n++;
    }
    for (const s of supps) {
      await client.query(
        `insert into observations (user_id, ts, source, metric, value, raw) values ($1,$2,'cronometer',$3,$4,$5)
         on conflict (user_id, source, metric, ts) do update set value = observations.value + excluded.value, raw = excluded.raw`,
        [userId, s.ts, s.metric, s.value, s.raw]
      ); n++;
    }
    await client.query(
      "insert into ingest_log (user_id, route, status, rows, bytes, summary) values ($1,'cronometer-sync',200,$2,$3,$4)",
      [userId, n, Buffer.byteLength(csv) + Buffer.byteLength(dailyCsv), { range: { start, end }, entries: rows.length, days: daily.length, hours: Object.keys(hours).length, dailyMetrics: dailyRows.length, supplements: supps.map((s) => s.raw.name).slice(0, 20) }]
    );
    await client.query("commit");
  } catch (e) { await client.query("rollback"); throw e; } finally { client.release(); }
  console.log(`cronometer sync wrote ${n} rows (${Object.keys(hours).length} hours of entries, ${dailyRows.length} daily nutrient values, ${supps.length} supplement entries)`);
}

if (require.main === module) {
  main().then(() => pool.end()).catch(async (e) => {
    console.error("cronometer sync failed:", e.message);
    try { await pool.query("insert into ingest_log (route, status, rows, bytes, summary) values ('cronometer-sync', 500, 0, 0, $1)", [{ error: e.message }]); } catch {}
    await pool.end(); process.exit(1);
  });
}
module.exports = { parseCsv, metricName, hourKey, isSupplement };
