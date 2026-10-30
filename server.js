const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { pool, migrate } = require("./db");

const app = express();
const PORT = process.env.PORT || 3000;
const SESSION_DAYS = 90;
const TZ = process.env.TZ_NAME || "America/Los_Angeles";
const IS_PROD = process.env.NODE_ENV === "production" || Boolean(process.env.RENDER);

app.set("trust proxy", 1);
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: false }));

// ---------- helpers ----------
function sha256(s) {
  return crypto.createHash("sha256").update(s).digest("hex");
}

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || "").split(";").forEach((part) => {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

function setSessionCookie(res, id) {
  const attrs = [
    `pdm_session=${id}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${SESSION_DAYS * 86400}`,
  ];
  if (IS_PROD) attrs.push("Secure");
  res.setHeader("Set-Cookie", attrs.join("; "));
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", "pdm_session=; Path=/; HttpOnly; Max-Age=0");
}

// Resolve the user from a session cookie or a bearer API key.
async function authenticate(req) {
  // Accept: "Authorization: Bearer <key>", "Authorization: <key>", "Authorization: Bearer Bearer <key>"
  // (some apps add the prefix themselves), or "X-API-Key: <key>".
  let key = (req.get("x-api-key") || req.query.api_key || "").trim();
  const header = (req.get("authorization") || "").trim();
  if (!key && header) key = header.replace(/^(bearer\s+)+/i, "").trim();
  req.authDiag = {
    headers: Object.keys(req.headers).filter((h) => !["cookie"].includes(h)),
    authHeaderLen: header.length,
    keyLen: key.length,
    keyPrefix: key.slice(0, 6),
    looksLikeKey: key.startsWith("pdm_"),
    via: req.get("x-api-key") ? "x-api-key" : req.query.api_key ? "query" : header ? "authorization" : "none",
  };
  if (key && key.startsWith("pdm_")) {
    const { rows } = await pool.query(
      `select u.id, u.email, k.id as key_id from api_keys k
       join users u on u.id = k.user_id
       where k.key_hash = $1 and k.revoked_at is null`,
      [sha256(key)]
    );
    if (rows[0]) {
      pool.query("update api_keys set last_used = now() where id = $1", [rows[0].key_id]).catch(() => {});
      return { id: rows[0].id, email: rows[0].email, via: "api_key" };
    }
    return null;
  }
  const sid = parseCookies(req).pdm_session;
  if (!sid) return null;
  const { rows } = await pool.query(
    `select u.id, u.email from sessions s join users u on u.id = s.user_id
     where s.id = $1 and s.expires_at > now()`,
    [sid]
  );
  return rows[0] ? { id: rows[0].id, email: rows[0].email, via: "session" } : null;
}

async function requireAuth(req, res, next) {
  try {
    const user = await authenticate(req);
    if (!user) {
      if (req.path.startsWith("/api/")) {
        await logIngest(null, `${req.method} ${req.path}`, 401, 0, req.authDiag);
        return res.status(401).json({ error: "unauthorized", hint: "send the pdm_ API key as 'Authorization: Bearer <key>', 'X-API-Key: <key>', or ?api_key=<key>" });
      }
      return res.redirect("/login");
    }
    req.user = user;
    next();
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "auth failure" });
  }
}

// ---------- bootstrap ----------
async function ensureFirstUser() {
  const { rows } = await pool.query("select count(*)::int as n from users");
  if (rows[0].n > 0) return;
  const email = process.env.PDAYMINDER_USER;
  const password = process.env.PDAYMINDER_PASSWORD;
  if (!email || !password) {
    console.warn("No users and PDAYMINDER_USER/PDAYMINDER_PASSWORD not set; nobody can log in.");
    return;
  }
  const hash = await bcrypt.hash(password, 12);
  const ins = await pool.query(
    "insert into users (email, password_hash) values ($1, $2) returning id",
    [email.toLowerCase(), hash]
  );
  console.log(`Created first user ${email}`);
  await importLegacyJson(ins.rows[0].id);
}

// One-time import of the old JSON file (disk copy first, then the committed seed).
async function importLegacyJson(userId) {
  const candidates = [
    process.env.DATA_DIR && path.join(process.env.DATA_DIR, "pdayminder-data.json"),
    path.join(__dirname, "pdayminder-data.json"),
  ].filter(Boolean);
  for (const file of candidates) {
    try {
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      await saveClientPayload(userId, data);
      console.log(`Imported legacy data from ${file} (${Object.keys(data.days || {}).length} days)`);
      return;
    } catch {
      // try next
    }
  }
}

// ---------- client payload <-> tables ----------
// The web app speaks {settings, days: {YYYY-MM-DD: {segments:[{type,rating}x12], meds:["HH:MM"]}}}.
async function loadClientPayload(userId) {
  const [s, q, m] = await Promise.all([
    pool.query("select data from settings where user_id = $1", [userId]),
    pool.query(
      "select to_char(day,'YYYY-MM-DD') as day, seg, type, rating from qol_ratings where user_id = $1 order by day, seg",
      [userId]
    ),
    pool.query(
      "select to_char(day,'YYYY-MM-DD') as day, to_char(taken_at,'HH24:MI') as t from med_doses where user_id = $1 and source = 'pdayminder' order by day, taken_at",
      [userId]
    ),
  ]);
  const days = {};
  const dayFor = (d) => {
    if (!days[d]) {
      days[d] = {
        dateKey: d,
        segments: Array.from({ length: 12 }, () => ({ type: "empty", rating: 3 })),
        meds: [],
      };
    }
    return days[d];
  };
  q.rows.forEach((r) => (dayFor(r.day).segments[r.seg] = { type: r.type, rating: r.rating }));
  m.rows.forEach((r) => dayFor(r.day).meds.push(r.t));
  return { settings: s.rows[0] ? s.rows[0].data : null, days };
}

async function saveClientPayload(userId, body) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    if (body.settings) {
      await client.query(
        `insert into settings (user_id, data) values ($1, $2)
         on conflict (user_id) do update set data = excluded.data`,
        [userId, body.settings]
      );
    }
    for (const [day, d] of Object.entries(body.days || {})) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
      for (let seg = 0; seg < Math.min(12, (d.segments || []).length); seg++) {
        const s = d.segments[seg];
        if (!s || !Number.isInteger(s.rating)) continue;
        await client.query(
          `insert into qol_ratings (user_id, day, seg, type, rating) values ($1,$2,$3,$4,$5)
           on conflict (user_id, day, seg) do update
             set type = excluded.type, rating = excluded.rating, updated_at = now()`,
          [userId, day, seg, s.type || "rating", Math.max(1, Math.min(5, s.rating))]
        );
      }
      if (Array.isArray(d.meds)) {
        // App-entered doses for the day are replaced wholesale to match the UI's edit semantics.
        await client.query(
          "delete from med_doses where user_id = $1 and day = $2 and source = 'pdayminder'",
          [userId, day]
        );
        for (const t of d.meds) {
          if (!/^\d{2}:\d{2}$/.test(t)) continue;
          await client.query(
            `insert into med_doses (user_id, day, taken_at, source) values ($1,$2,$3,'pdayminder')
             on conflict do nothing`,
            [userId, day, t]
          );
        }
      }
    }
    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

// Body parser errors (payload too large, bad JSON) -> logged
app.use((err, req, res, next) => {
  if (!err) return next();
  const status = err.status || 500;
  logIngest(null, `${req.method} ${req.path}`, status, 0, { error: err.type || err.message, length: req.get("content-length") });
  res.status(status).json({ error: err.type || "bad request", limit: "50mb" });
});

// ---------- public routes ----------
app.get("/api/health", async (req, res) => {
  try {
    const { rows } = await pool.query("select count(distinct day)::int as days from qol_ratings");
    res.json({ ok: true, db: true, days: rows[0].days });
  } catch (e) {
    res.status(500).json({ ok: false, db: false, error: String(e.message) });
  }
});

const LOGIN_HTML = (msg = "") => `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>PDayMinder – sign in</title>
<style>
body{font-family:system-ui,-apple-system,sans-serif;background:#0f172a;color:#e2e8f0;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
form{background:#1e293b;padding:28px;border-radius:14px;width:min(360px,90vw);box-shadow:0 10px 30px rgba(0,0,0,.4)}
h1{font-size:20px;margin:0 0 16px}label{display:block;font-size:13px;margin:12px 0 4px;color:#94a3b8}
input{width:100%;box-sizing:border-box;padding:10px;border-radius:8px;border:1px solid #334155;background:#0f172a;color:#e2e8f0;font-size:16px}
button{margin-top:18px;width:100%;padding:11px;border:0;border-radius:8px;background:#38bdf8;color:#0f172a;font-weight:600;font-size:16px}
.err{color:#f87171;font-size:13px;margin-top:10px}
</style></head><body>
<form method="post" action="/login">
<h1>PDayMinder</h1>
<label>Email</label><input name="email" type="email" autocomplete="username" required>
<label>Password</label><input name="password" type="password" autocomplete="current-password" required>
<button type="submit">Sign in</button>
${msg ? `<div class="err">${msg}</div>` : ""}
</form></body></html>`;

app.get("/login", (req, res) => res.type("html").send(LOGIN_HTML()));

app.post("/login", async (req, res) => {
  const email = String(req.body.email || "").toLowerCase().trim();
  const password = String(req.body.password || "");
  const { rows } = await pool.query("select id, password_hash from users where email = $1", [email]);
  const ok = rows[0] && (await bcrypt.compare(password, rows[0].password_hash));
  if (!ok) {
    await new Promise((r) => setTimeout(r, 500));
    return res.status(401).type("html").send(LOGIN_HTML("Wrong email or password."));
  }
  const sid = crypto.randomBytes(32).toString("base64url");
  await pool.query(
    "insert into sessions (id, user_id, expires_at) values ($1, $2, now() + ($3 || ' days')::interval)",
    [sid, rows[0].id, String(SESSION_DAYS)]
  );
  setSessionCookie(res, sid);
  res.redirect("/");
});

app.post("/logout", async (req, res) => {
  const sid = parseCookies(req).pdm_session;
  if (sid) await pool.query("delete from sessions where id = $1", [sid]);
  clearSessionCookie(res);
  res.redirect("/login");
});

// ---------- authenticated routes ----------
app.get("/api/me", requireAuth, (req, res) => res.json(req.user));

app.get("/api/pdayminder/data", requireAuth, async (req, res) => {
  res.json(await loadClientPayload(req.user.id));
});

app.post("/api/pdayminder/data", requireAuth, async (req, res) => {
  await saveClientPayload(req.user.id, req.body || {});
  res.json({ ok: true });
});

// API keys: session-only management (an API key can't mint more keys).
function requireSession(req, res, next) {
  if (req.user.via !== "session") return res.status(403).json({ error: "session required" });
  next();
}

app.get("/api/keys", requireAuth, requireSession, async (req, res) => {
  const { rows } = await pool.query(
    "select id, name, prefix, created_at, last_used, revoked_at from api_keys where user_id = $1 order by id",
    [req.user.id]
  );
  res.json(rows);
});

app.post("/api/keys", requireAuth, requireSession, async (req, res) => {
  const name = String((req.body && req.body.name) || "").trim() || "unnamed";
  const key = "pdm_" + crypto.randomBytes(24).toString("base64url");
  await pool.query(
    "insert into api_keys (user_id, name, key_hash, prefix) values ($1,$2,$3,$4)",
    [req.user.id, name, sha256(key), key.slice(0, 10)]
  );
  res.json({ name, key, note: "Shown once. Store it now." });
});

app.delete("/api/keys/:id", requireAuth, requireSession, async (req, res) => {
  await pool.query("update api_keys set revoked_at = now() where id = $1 and user_id = $2", [
    req.params.id,
    req.user.id,
  ]);
  res.json({ ok: true });
});

// Generic ingest for agents and wearables: [{ts, source, metric, value, raw}]
app.post("/api/observations", requireAuth, async (req, res) => {
  const items = Array.isArray(req.body) ? req.body : req.body && req.body.items;
  if (!Array.isArray(items)) return res.status(400).json({ error: "expected array" });
  let n = 0;
  for (const o of items) {
    if (!o || !o.ts || !o.source || !o.metric) continue;
    await pool.query(
      `insert into observations (user_id, ts, source, metric, value, raw) values ($1,$2,$3,$4,$5,$6)
       on conflict (user_id, source, metric, ts) do update set value = excluded.value, raw = excluded.raw`,
      [req.user.id, o.ts, o.source, o.metric, o.value ?? null, o.raw ?? null]
    );
    n++;
  }
  res.json({ ok: true, inserted: n });
});

app.get("/api/observations", requireAuth, async (req, res) => {
  const { source, metric, from, to, limit = 1000 } = req.query;
  const where = ["user_id = $1"];
  const args = [req.user.id];
  if (source) args.push(source), where.push(`source = $${args.length}`);
  if (metric) args.push(metric), where.push(`metric = $${args.length}`);
  if (from) args.push(from), where.push(`ts >= $${args.length}`);
  if (to) args.push(to), where.push(`ts < $${args.length}`);
  args.push(Math.min(10000, Number(limit) || 1000));
  const { rows } = await pool.query(
    `select ts, source, metric, value, raw from observations where ${where.join(" and ")} order by ts desc limit $${args.length}`,
    args
  );
  res.json(rows);
});

// Med doses from any source (e.g. an agent reading a reminder app)
app.post("/api/med-doses", requireAuth, async (req, res) => {
  const items = Array.isArray(req.body) ? req.body : [req.body];
  let n = 0;
  for (const d of items) {
    if (!d || !d.day || !d.taken_at) continue;
    await pool.query(
      `insert into med_doses (user_id, day, taken_at, drug, dose, source) values ($1,$2,$3,$4,$5,$6)
       on conflict do nothing`,
      [req.user.id, d.day, d.taken_at, d.drug || "sinemet", d.dose || null, d.source || "api"]
    );
    n++;
  }
  res.json({ ok: true, inserted: n });
});

// ---------- Health Auto Export ingest ----------
// HAE "REST API" automation posts {data:{metrics:[{name,units,data:[{date,qty|Avg|...}]}], workouts:[...]}}.
// Every numeric field of every point becomes an observation: qty -> <name>, other fields -> <name>_<field>.
function parseHaeDate(d) {
  if (!d) return null;
  // "2026-10-26 07:00:00 -0700" -> "2026-10-26T07:00:00-07:00"
  const m = String(d).match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})\s*([+-]\d{2}):?(\d{2})?$/);
  const iso = m ? `${m[1]}T${m[2]}${m[3]}:${m[4] || "00"}` : String(d);
  const t = new Date(iso);
  return isNaN(t) ? null : t.toISOString();
}

// Shape summary of a JSON body, for debugging integrations without storing the whole payload.
function describe(v, depth = 0) {
  if (depth > 3) return "…";
  if (Array.isArray(v)) return { array: v.length, first: v.length ? describe(v[0], depth + 1) : null };
  if (v && typeof v === "object") {
    const out = {};
    Object.keys(v).slice(0, 25).forEach((k) => (out[k] = describe(v[k], depth + 1)));
    return out;
  }
  return typeof v === "string" ? "str:" + v.slice(0, 40) : v;
}
async function logIngest(userId, route, status, rows, body) {
  try {
    const bytes = Buffer.byteLength(JSON.stringify(body || {}));
    await pool.query(
      "insert into ingest_log (user_id, route, status, rows, bytes, summary) values ($1,$2,$3,$4,$5,$6)",
      [userId, route, status, rows, bytes, describe(body)]
    );
  } catch (e) {
    console.error("ingest log failed", e.message);
  }
}

// Cumulative-per-day metrics. Overlapping HAE automation windows send partial sums for the
// same local day, so these are keyed to local midnight and the largest value wins.
const CUMULATIVE = new Set([
  "step_count", "walking_running_distance", "flights_climbed", "active_energy", "basal_energy_burned",
  "apple_exercise_time", "apple_stand_time", "apple_stand_hour", "cycling_distance", "swimming_distance",
  "physical_effort", "time_in_daylight",
]);
const isCumulative = (base) => CUMULATIVE.has(base) || base.startsWith("sleep_analysis");

function localMidnightIso(tsIso) {
  const d = new Date(tsIso);
  const day = d.toLocaleDateString("en-CA", { timeZone: TZ });
  // find the UTC instant of local midnight for that date
  const guess = new Date(day + "T00:00:00Z");
  const offsetMin = (new Date(guess.toLocaleString("en-US", { timeZone: TZ })) - new Date(guess.toLocaleString("en-US", { timeZone: "UTC" }))) / 60000;
  return new Date(guess.getTime() - offsetMin * 60000).toISOString();
}

app.post("/api/ingest/hae", requireAuth, async (req, res) => {
  const body = req.body || {};
  const data = body.data && typeof body.data === "object" ? body.data : body;
  const metrics = Array.isArray(data.metrics) ? data.metrics : [];
  const workouts = Array.isArray(data.workouts) ? data.workouts : [];
  let rows = 0, skipped = 0;
  const client = await pool.connect();
  try {
    await client.query("begin");
    for (const m of metrics) {
      const base = String(m.name || "").toLowerCase().replace(/[^a-z0-9]+/g, "_");
      if (!base) continue;
      for (const pt of m.data || []) {
        let ts = parseHaeDate(pt.date);
        if (!ts) { skipped++; continue; }
        const isSleep = base.startsWith("sleep_analysis");
        const cumulative = !isSleep && isCumulative(base);
        if (isSleep) {
          // one row per night, keyed on the local date the sleep ended; drop merged multi-night windows
          const start = parseHaeDate(pt.sleepStart), end = parseHaeDate(pt.sleepEnd);
          const span = start && end ? (new Date(end) - new Date(start)) / 36e5 : null;
          const total = pt.totalSleep ?? pt.asleep ?? pt.inBed;
          if ((span != null && span > 14) || (typeof total === "number" && total > 14)) { skipped++; continue; }
          ts = localMidnightIso(end || ts);
        }
        if (cumulative) ts = localMidnightIso(ts);
        for (const [k, v] of Object.entries(pt)) {
          if (k === "date" || typeof v !== "number" || !isFinite(v)) continue;
          const metric = k === "qty" ? base : `${base}_${k.toLowerCase()}`;
          await client.query(
            cumulative
              ? `insert into observations (user_id, ts, source, metric, value, raw) values ($1,$2,'hae',$3,$4,$5)
                 on conflict (user_id, source, metric, ts) do update
                   set value = greatest(observations.value, excluded.value),
                       raw = case when excluded.value >= observations.value then excluded.raw else observations.raw end`
              : `insert into observations (user_id, ts, source, metric, value, raw) values ($1,$2,'hae',$3,$4,$5)
                 on conflict (user_id, source, metric, ts) do update set value = excluded.value, raw = excluded.raw`,
            [req.user.id, ts, metric, v, { units: m.units || null, ...pt }]
          );
          rows++;
        }
      }
    }
    for (const w of workouts) {
      const ts = parseHaeDate(w.start);
      if (!ts) { skipped++; continue; }
      const end = parseHaeDate(w.end);
      const minutes = end ? (new Date(end) - new Date(ts)) / 60000 : null;
      await client.query(
        `insert into observations (user_id, ts, source, metric, value, raw) values ($1,$2,'hae','workout',$3,$4)
         on conflict (user_id, source, metric, ts) do update set value = excluded.value, raw = excluded.raw`,
        [req.user.id, ts, minutes, w]
      );
      rows++;
    }
    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    console.error("hae ingest failed", e);
    await logIngest(req.user.id, "hae", 500, 0, body);
    return res.status(500).json({ error: "ingest failed" });
  } finally {
    client.release();
  }
  await logIngest(req.user.id, "hae", 200, rows, body);
  res.json({ ok: true, rows, skipped, metrics: metrics.length, workouts: workouts.length });
});

app.get("/api/ingest-log", requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    "select ts, route, status, rows, bytes, summary from ingest_log where user_id = $1 or user_id is null order by id desc limit 30",
    [req.user.id]
  );
  res.json(rows);
});

// ---------- summaries for the UI ----------

app.get("/api/sources", requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `select source, count(*)::int as rows, max(ts) as last_ts, min(ts) as first_ts,
            count(distinct metric)::int as metrics
     from observations where user_id = $1 group by source order by source`,
    [req.user.id]
  );
  res.json(rows);
});

app.get("/api/metrics", requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `select source, metric, count(*)::int as rows, max(ts) as last_ts
     from observations where user_id = $1 group by source, metric order by source, metric`,
    [req.user.id]
  );
  res.json(rows);
});

// Per-day rollup: mean QoL, dose count, and the daily mean of one chosen metric.
app.get("/api/daily", requireAuth, async (req, res) => {
  const days = Math.min(365, Number(req.query.days) || 30);
  const source = req.query.source || null;
  const metric = req.query.metric || null;
  const { rows } = await pool.query(
    `with span as (
       select generate_series((current_date at time zone $2)::date - ($3::int - 1), (current_date at time zone $2)::date, '1 day')::date as day
     ),
     qol as (
       select day, round(avg(rating)::numeric, 2) as qol, count(*) filter (where type = 'rating')::int as rated
       from qol_ratings where user_id = $1 and type = 'rating' group by day
     ),
     meds as (
       select day, count(*)::int as doses from med_doses where user_id = $1 group by day
     ),
     obs as (
       select (ts at time zone $2)::date as day, avg(value) as v, count(*)::int as n
       from observations where user_id = $1 and $4::text is not null and source = $4 and metric = $5
       group by 1
     )
     select to_char(s.day,'YYYY-MM-DD') as day, q.qol, coalesce(q.rated,0) as rated,
            coalesce(m.doses,0) as doses, o.v as metric_value, coalesce(o.n,0) as metric_n
     from span s left join qol q on q.day = s.day left join meds m on m.day = s.day left join obs o on o.day = s.day
     order by s.day`,
    [req.user.id, TZ, days, source, metric]
  );
  res.json(rows);
});

// Everything for one day: hourly series, daily values, QoL segments, doses, workouts.
app.get("/api/day", requireAuth, async (req, res) => {
  const day = String(req.query.day || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return res.status(400).json({ error: "day=YYYY-MM-DD" });
  const uid = req.user.id;
  const [obs, qol, meds, oura] = await Promise.all([
    pool.query(
      `select ts, metric, value, raw from observations
       where user_id = $1 and source = 'hae' and (ts at time zone $2)::date = $3::date order by ts`,
      [uid, TZ, day]
    ),
    pool.query("select seg, type, rating from qol_ratings where user_id = $1 and day = $2 order by seg", [uid, day]),
    pool.query("select to_char(taken_at,'HH24:MI') as t, drug from med_doses where user_id = $1 and day = $2 order by taken_at", [uid, day]),
    pool.query(
      `select metric, value from observations where user_id = $1 and source = 'oura' and (ts at time zone $2)::date = $3::date`,
      [uid, TZ, day]
    ),
  ]);
  const hourly = {}, daily = {}, workouts = [];
  const counts = {};
  obs.rows.forEach((r) => (counts[r.metric] = (counts[r.metric] || 0) + 1));
  obs.rows.forEach((r) => {
    if (r.metric === "workout") return workouts.push({ ts: r.ts, minutes: r.value, ...r.raw });
    if (counts[r.metric] > 1) (hourly[r.metric] = hourly[r.metric] || []).push({ ts: r.ts, value: r.value });
    else daily[r.metric] = r.value;
  });
  res.json({ day, hourly, daily, oura: Object.fromEntries(oura.rows.map((r) => [r.metric, r.value])), qol: qol.rows, doses: meds.rows, workouts });
});

// Several daily metrics at once, pivoted: [{day, "hae/heart_rate_variability": 48.2, ...}]
app.get("/api/daily-multi", requireAuth, async (req, res) => {
  const days = Math.min(365, Number(req.query.days) || 30);
  const wanted = String(req.query.metrics || "").split(",").map((x) => x.trim()).filter(Boolean).slice(0, 20);
  if (!wanted.length) return res.json([]);
  const pairs = wanted.map((w) => w.split("/"));
  const { rows } = await pool.query(
    `select to_char((ts at time zone $2)::date,'YYYY-MM-DD') as day, source || '/' || metric as key, avg(value) as v
     from observations
     where user_id = $1 and (ts at time zone $2)::date >= (current_date at time zone $2)::date - ($3::int - 1)
       and (source, metric) in (${pairs.map((_, i) => `($${4 + i * 2}, $${5 + i * 2})`).join(",")})
     group by 1, 2 order by 1`,
    [req.user.id, TZ, days, ...pairs.flat()]
  );
  const byDay = {};
  const start = new Date(); start.setDate(start.getDate() - (days - 1));
  for (let i = 0; i < days; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i);
    const k = d.toLocaleDateString("en-CA", { timeZone: TZ });
    byDay[k] = { day: k };
  }
  rows.forEach((r) => { if (byDay[r.day]) byDay[r.day][r.key] = Number(r.v); });
  res.json(Object.values(byDay));
});

app.get("/api/workouts", requireAuth, async (req, res) => {
  const days = Math.min(365, Number(req.query.days) || 14);
  const { rows } = await pool.query(
    `select ts, value as minutes, raw from observations
     where user_id = $1 and metric = 'workout' and ts >= now() - ($2 || ' days')::interval order by ts desc`,
    [req.user.id, String(days)]
  );
  res.json(rows);
});

// ---------- Oura OAuth2 ----------
const OURA = {
  authorize: process.env.OURA_AUTHORIZE_URL || "https://cloud.ouraring.com/oauth/authorize",
  token: process.env.OURA_TOKEN_URL || "https://api.ouraring.com/oauth/token",
  scope: "daily heartrate workout session spo2 personal",
  clientId: process.env.OURA_CLIENT_ID || "",
  clientSecret: process.env.OURA_CLIENT_SECRET || "",
};
const oauthStates = new Map(); // state -> {userId, verifier, exp}

function baseUrl(req) {
  return process.env.PUBLIC_URL || `${req.protocol}://${req.get("host")}`;
}

app.get("/oauth/oura/start", requireAuth, requireSession, (req, res) => {
  if (!OURA.clientId) return res.status(500).send("OURA_CLIENT_ID not configured");
  const state = crypto.randomBytes(16).toString("base64url");
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  oauthStates.set(state, { userId: req.user.id, verifier, exp: Date.now() + 10 * 60000 });
  const u = new URL(OURA.authorize);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", OURA.clientId);
  u.searchParams.set("redirect_uri", `${baseUrl(req)}/oauth/oura/callback`);
  u.searchParams.set("scope", OURA.scope);
  u.searchParams.set("state", state);
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("code_challenge_method", "S256");
  res.redirect(u.toString());
});

app.get("/oauth/oura/callback", async (req, res) => {
  const { code, state, error } = req.query;
  const pending = state && oauthStates.get(state);
  oauthStates.delete(state);
  if (error) return res.status(400).send(`Oura said: ${error}`);
  if (!pending || pending.exp < Date.now()) return res.status(400).send("Login flow expired; go back and try again.");
  try {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code: String(code),
      redirect_uri: `${baseUrl(req)}/oauth/oura/callback`,
      client_id: OURA.clientId,
      client_secret: OURA.clientSecret,
      code_verifier: pending.verifier,
    });
    const r = await fetch(OURA.token, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
    const tok = await r.json();
    if (!r.ok || !tok.access_token) throw new Error(JSON.stringify(tok));
    await pool.query(
      `insert into oauth_tokens (user_id, provider, access_token, refresh_token, expires_at, scope)
       values ($1,'oura',$2,$3, now() + ($4 || ' seconds')::interval, $5)
       on conflict (user_id, provider) do update set access_token = excluded.access_token,
         refresh_token = excluded.refresh_token, expires_at = excluded.expires_at, scope = excluded.scope, updated_at = now()`,
      [pending.userId, tok.access_token, tok.refresh_token || null, String(tok.expires_in || 86400), tok.scope || OURA.scope]
    );
    res.redirect("/?connected=oura");
  } catch (e) {
    console.error("oura oauth failed", e.message);
    res.status(500).send("Could not complete Oura connection: " + e.message);
  }
});

app.get("/api/integrations", requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    "select provider, expires_at, updated_at, scope, refresh_token is not null as has_refresh from oauth_tokens where user_id = $1",
    [req.user.id]
  );
  const last = await pool.query(
    "select route, status, ts, rows from ingest_log where route = 'oura-sync' order by id desc limit 1"
  );
  res.json({ oura: { configured: Boolean(OURA.clientId), connected: rows.find((r) => r.provider === "oura") || null, lastSync: last.rows[0] || null } });
});

app.delete("/api/integrations/oura", requireAuth, requireSession, async (req, res) => {
  await pool.query("delete from oauth_tokens where user_id = $1 and provider = 'oura'", [req.user.id]);
  res.json({ ok: true });
});

app.use("/vendor", express.static(path.join(__dirname, "vendor"), { maxAge: "7d" }));

// The app itself, only when signed in.
app.get("/", requireAuth, (req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.get("/index.html", requireAuth, (req, res) => res.sendFile(path.join(__dirname, "index.html")));
// Anything else: API-key callers get a logged 404 (so a mis-set URL or method shows up in
// /api/ingest-log); browser sessions get the app.
app.all("*", requireAuth, async (req, res) => {
  if (req.user.via === "api_key" || req.method !== "GET" || req.path.startsWith("/api/")) {
    await logIngest(req.user.id, `${req.method} ${req.path}`, 404, 0, req.body);
    return res.status(404).json({
      error: "no such route",
      hint: "Health Auto Export must POST to /api/ingest/hae",
      method: req.method,
      path: req.path,
    });
  }
  res.sendFile(path.join(__dirname, "index.html"));
});

async function repairCumulative() {
  const { rows } = await pool.query(
    "select distinct metric from observations where source = 'hae'"
  );
  const sleepMetrics = rows.map((r) => r.metric).filter((m) => m.startsWith("sleep_analysis"));
  if (sleepMetrics.length) {
    const bad = await pool.query(
      `delete from observations where source = 'hae' and metric = any($1)
       and ((metric in ('sleep_analysis_totalsleep','sleep_analysis_asleep','sleep_analysis_inbed') and value > 14)
            or (raw ? 'sleepStart' and raw ? 'sleepEnd'
                and extract(epoch from ((raw->>'sleepEnd')::timestamptz - (raw->>'sleepStart')::timestamptz))/3600 > 14))`,
      [sleepMetrics]
    );
    if (bad.rowCount) console.log(`repair: removed ${bad.rowCount} implausible sleep rows`);
    for (const metric of sleepMetrics) {
      await pool.query(
        `with keep as (
           select distinct on (user_id, (ts at time zone $2)::date) id
           from observations where source = 'hae' and metric = $1
           order by user_id, (ts at time zone $2)::date, id desc)
         delete from observations o where o.source = 'hae' and o.metric = $1 and o.id not in (select id from keep)`,
        [metric, TZ]
      );
    }
    await pool.query(
      `update observations set ts = ((ts at time zone $1)::date::timestamp at time zone $1)
       where source = 'hae' and metric = any($2) and ts <> ((ts at time zone $1)::date::timestamp at time zone $1)`,
      [TZ, sleepMetrics]
    );
  }
  const targets = rows.map((r) => r.metric).filter((m) => !m.startsWith("sleep_analysis") && isCumulative(m));
  if (!targets.length) return;
  for (const metric of targets) {
    const r = await pool.query(
      `with keep as (
         select distinct on (user_id, (ts at time zone $2)::date) id
         from observations where source = 'hae' and metric = $1
         order by user_id, (ts at time zone $2)::date, value desc nulls last, id desc
       )
       delete from observations o using (
         select id from observations where source = 'hae' and metric = $1 and id not in (select id from keep)
       ) d where o.id = d.id`,
      [metric, TZ]
    );
    if (r.rowCount) console.log(`repair: ${metric} removed ${r.rowCount} partial rows`);
  }
  // re-key survivors to local midnight
  await pool.query(
    `update observations set ts = ((ts at time zone $1)::date::timestamp at time zone $1)
     where source = 'hae' and metric = any($2) and ts <> ((ts at time zone $1)::date::timestamp at time zone $1)`,
    [TZ, targets]
  );
}

// ---------- start ----------
(async () => {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }
  await migrate();
  await ensureFirstUser();
  await repairCumulative();
  app.listen(PORT, () => console.log(`PDayMinder on http://localhost:${PORT}`));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
