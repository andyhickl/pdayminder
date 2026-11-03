// Hypothesis engine: feature store → generator → prospective scoring → ranking that learns from votes.
//
// Discovery runs on history (retrospective effect over the last 45 days) to decide what is worth watching; the
// grade a hypothesis earns comes only from days after it was activated (prospective), so the thing that picked
// it cannot also be the thing that confirms it.
//
// Tables: features (cache of the day-level feature table), hypotheses (one row per generated hypothesis, with
// status and votes). Exposed through init(deps) → { routes, buildFeatures }.

const crypto = require("crypto");

module.exports = function init({ pool, dailySeries, dopaDrugs, TZ, localDayOf }) {
  // ---------- feature registry ----------
  // key, label, source metric(s), family, controllable (can be the subject of a behaviour change), kind: exposure | outcome | both,
  // better: +1 if higher is better, -1 if lower is better, 0 neutral (used for wording and for the plausibility prior).
  const F = [
    { key: "sleep_h", label: "sleep", unit: "h", src: ["oura/total_sleep_h"], fam: "sleep", ctrl: true, kind: "both", better: 1, lit: 6.5 },
    { key: "deep_h", label: "deep sleep", unit: "h", src: ["oura/deep_h"], fam: "sleep", ctrl: false, kind: "both", better: 1, lit: 1 },
    { key: "rem_h", label: "REM sleep", unit: "h", src: ["oura/rem_h"], fam: "sleep", ctrl: false, kind: "both", better: 1 },
    { key: "sleep_score", label: "Oura sleep score", unit: "", src: ["oura/sleep_score"], fam: "sleep", ctrl: false, kind: "both", better: 1 },
    { key: "latency_min", label: "time to fall asleep", unit: "min", src: ["oura/latency_min"], fam: "sleep", ctrl: false, kind: "outcome", better: -1 },
    { key: "hrv", label: "night HRV", unit: "ms", src: ["oura/avg_hrv"], fam: "hrv", ctrl: false, kind: "exposure", better: 1 },
    { key: "lowest_hr", label: "lowest night heart rate", unit: "bpm", src: ["oura/lowest_hr"], fam: "hrv", ctrl: false, kind: "exposure", better: -1 },
    { key: "readiness", label: "Oura readiness", unit: "", src: ["oura/readiness_score"], fam: "hrv", ctrl: false, kind: "exposure", better: 1 },
    { key: "temp_dev", label: "temperature deviation", unit: "°C", src: ["oura/temperature_deviation"], fam: "hrv", ctrl: false, kind: "exposure", better: 0 },
    { key: "steps", label: "steps", unit: "", src: ["hae/step_count", "oura/steps"], fam: "activity", ctrl: true, kind: "exposure", better: 1 },
    { key: "walk_speed", label: "walking speed", unit: "m/s", src: ["hae/walking_speed"], fam: "gait", ctrl: false, kind: "outcome", better: 1 },
    { key: "dbl_support", label: "double support", unit: "%", src: ["hae/walking_double_support_percentage"], fam: "gait", ctrl: false, kind: "outcome", better: -1 },
    { key: "asymmetry", label: "walking asymmetry", unit: "%", src: ["hae/walking_asymmetry_percentage"], fam: "gait", ctrl: false, kind: "outcome", better: -1 },
    { key: "resting_hr", label: "resting heart rate", unit: "bpm", src: ["hae/resting_heart_rate"], fam: "hrv", ctrl: false, kind: "exposure", better: -1 },
    { key: "energy", label: "calories", unit: "kcal", src: ["cronometer/energy", "hae/dietary_energy"], fam: "nutrition", ctrl: true, kind: "exposure", better: 0 },
    { key: "protein", label: "protein", unit: "g", src: ["cronometer/protein", "hae/protein"], fam: "nutrition", ctrl: true, kind: "exposure", better: 0 },
    { key: "protein_near_dose", label: "protein within 90 min of a dose", unit: "g", src: ["derived/protein_near_dose"], fam: "nutrition", ctrl: true, kind: "exposure", better: -1, lit: 20 },
    { key: "carbs", label: "carbs", unit: "g", src: ["cronometer/carbs", "hae/carbohydrates"], fam: "nutrition", ctrl: true, kind: "exposure", better: 0 },
    { key: "fiber", label: "fiber", unit: "g", src: ["cronometer/fiber"], fam: "nutrition", ctrl: true, kind: "exposure", better: 1 },
    { key: "caffeine", label: "caffeine", unit: "mg", src: ["cronometer/caffeine", "hae/caffeine"], fam: "nutrition", ctrl: true, kind: "exposure", better: 0, lit: 100 },
    { key: "water", label: "water", unit: "g", src: ["cronometer/water", "hae/dietary_water"], fam: "nutrition", ctrl: true, kind: "exposure", better: 1 },
    { key: "first_meal", label: "first meal time", unit: "h", src: ["derived/first_meal_hour"], fam: "nutrition", ctrl: true, kind: "exposure", better: 0 },
    { key: "last_meal", label: "last meal time", unit: "h", src: ["derived/last_meal_hour"], fam: "nutrition", ctrl: true, kind: "exposure", better: -1, lit: 19.5 },
    { key: "supps", label: "supplements logged", unit: "", src: ["derived/supplements_logged"], fam: "supplements", ctrl: true, kind: "exposure", better: 1 },
    { key: "doses", label: "levodopa doses", unit: "", src: [], fam: "doses", ctrl: false, kind: "exposure", better: 0, lit: 3 },
    { key: "first_dose_h", label: "first dose time", unit: "h", src: [], fam: "doses", ctrl: true, kind: "exposure", better: 0 },
    { key: "dose_gap_max", label: "longest gap between doses", unit: "h", src: [], fam: "doses", ctrl: true, kind: "exposure", better: -1 },
    { key: "min_home", label: "time at home", unit: "min", src: ["derived/minutes_home"], fam: "context", ctrl: false, kind: "exposure", better: 0 },
    { key: "min_work", label: "time at work", unit: "min", src: ["derived/minutes_work"], fam: "context", ctrl: false, kind: "exposure", better: 0, lit: 180 },
    { key: "min_driving", label: "time driving", unit: "min", src: ["derived/minutes_driving"], fam: "context", ctrl: false, kind: "exposure", better: -1, lit: 60 },
    { key: "events", label: "symptom events", unit: "", src: ["derived/events_count"], fam: "events", ctrl: false, kind: "both", better: -1 },
    { key: "event_min", label: "minutes in symptom events", unit: "min", src: ["derived/event_minutes"], fam: "events", ctrl: false, kind: "outcome", better: -1 },
    { key: "dystonia", label: "dystonia events", unit: "", src: ["derived/events_dystonia"], fam: "events", ctrl: false, kind: "outcome", better: -1 },
    { key: "qol", label: "QoL", unit: "", src: [], fam: "qol", ctrl: false, kind: "both", better: 1 },
    { key: "qol_am", label: "morning QoL (06–12)", unit: "", src: [], fam: "qol", ctrl: false, kind: "outcome", better: 1 },
    { key: "qol_pm", label: "afternoon QoL (14–20)", unit: "", src: [], fam: "qol", ctrl: false, kind: "outcome", better: 1 },
    { key: "qol_eve", label: "evening QoL (18–24)", unit: "", src: [], fam: "qol", ctrl: false, kind: "outcome", better: 1 },
    { key: "tremor", label: "tremor score", unit: "", src: ["motor/tremor_score"], fam: "tremor", ctrl: false, kind: "outcome", better: 1 },
    { key: "tap", label: "tapping score", unit: "", src: ["motor/tap_score"], fam: "tapping", ctrl: false, kind: "outcome", better: 1 },
    { key: "tap_rate", label: "tap rate", unit: "/s", src: ["motor/tap_rate"], fam: "tapping", ctrl: false, kind: "outcome", better: 1 },
    { key: "gait", label: "gait score", unit: "", src: ["motor/gait_score"], fam: "gait", ctrl: false, kind: "outcome", better: 1 },
    { key: "balance", label: "balance score", unit: "", src: ["motor/balance_score"], fam: "balance", ctrl: false, kind: "outcome", better: 1 },
    { key: "ddk", label: "pa-ta-ka rate", unit: "/s", src: ["motor/ddk_rate"], fam: "voice", ctrl: false, kind: "outcome", better: 1 },
    { key: "tap_delta", label: "post-minus-pre tapping", unit: "/s", src: [], fam: "tapping", ctrl: false, kind: "outcome", better: 1 },
    { key: "tremor_delta", label: "post-minus-pre tremor score", unit: "", src: [], fam: "tremor", ctrl: false, kind: "outcome", better: 1 },
    { key: "batteries", label: "batteries run", unit: "", src: ["derived/batteries_pre", "derived/batteries_post"], fam: "doses", ctrl: true, kind: "exposure", better: 1 },
  ];
  const FK = Object.fromEntries(F.map((f) => [f.key, f]));

  // Plausibility prior for (exposure family → outcome family), from the Block 1 research. 1 = well supported mechanism,
  // 0.5 = plausible, 0.2 = no particular reason, used only to rank candidates (never to grade them).
  const PRIOR = {
    "nutrition>qol": 0.8, "nutrition>tapping": 0.8, "nutrition>tremor": 0.6, "nutrition>events": 0.7, "nutrition>sleep": 0.6, "nutrition>gait": 0.5,
    "sleep>qol": 0.9, "sleep>events": 0.7, "sleep>tremor": 0.6, "sleep>tapping": 0.6, "sleep>gait": 0.5, "sleep>balance": 0.5, "sleep>voice": 0.4,
    "hrv>qol": 0.6, "hrv>events": 0.5, "hrv>tapping": 0.4, "hrv>tremor": 0.4,
    "activity>qol": 0.9, "activity>sleep": 0.8, "activity>gait": 0.7, "activity>events": 0.5, "activity>tremor": 0.4, "activity>balance": 0.6,
    "doses>events": 0.9, "doses>qol": 0.9, "doses>tapping": 0.9, "doses>tremor": 0.9, "doses>gait": 0.7,
    "context>qol": 0.6, "context>events": 0.6, "context>tapping": 0.3,
    "supplements>qol": 0.5, "supplements>sleep": 0.6, "supplements>tapping": 0.4, "supplements>tremor": 0.3, "supplements>events": 0.3,
    "events>qol": 0.8, "events>sleep": 0.6, "qol>events": 0.6, "qol>sleep": 0.5,
  };
  const prior = (xf, yf) => PRIOR[`${xf}>${yf}`] ?? 0.2;

  // ---------- feature store ----------
  const cache = new Map(); // uid -> {at, days, table}
  async function buildFeatures(uid, days = 60, force = false) {
    const c = cache.get(uid);
    if (!force && c && c.days >= days && Date.now() - c.at < 20 * 60000) return c.table;
    const table = {};
    const row = (d) => (table[d] = table[d] || { day: d });
    const srcKeys = [...new Set(F.flatMap((f) => f.src))];
    for (const k of srcKeys) {
      const [s, m] = k.split("/");
      const series = await dailySeries(uid, s, m, days);
      for (const [d, v] of series) row(d)["src:" + k] = v;
    }
    for (const f of F) if (f.src.length) for (const d of Object.keys(table)) { for (const k of f.src) { const v = table[d]["src:" + k]; if (v != null) { table[d][f.key] = f.key === "batteries" ? (table[d][f.key] || 0) + v : v; if (f.key !== "batteries") break; } } }
    // QoL by period, doses, deltas
    const q = await pool.query(
      `select to_char(day,'YYYY-MM-DD') as day, avg(rating) as qol, avg(rating) filter (where seg between 3 and 5) as qol_am,
              avg(rating) filter (where seg between 7 and 9) as qol_pm, avg(rating) filter (where seg between 9 and 11) as qol_eve, count(*)::int as rated
       from qol_ratings where user_id = $1 and type = 'rating' and day >= (now() at time zone $2)::date - ($3::int - 1) group by day`, [uid, TZ, days]);
    q.rows.forEach((r) => { const o = row(r.day); ["qol", "qol_am", "qol_pm", "qol_eve"].forEach((k) => (o[k] = r[k] == null ? null : Number(r[k]))); o.rated = r.rated; });
    const dd = await pool.query(
      `select to_char(day,'YYYY-MM-DD') as day, count(*)::int as n, min(taken_at) as first_t,
              max(gap) as gap_max from (
         select day, taken_at, extract(epoch from (taken_at - lag(taken_at) over (partition by day order by taken_at)))/3600 as gap
         from med_doses where user_id = $1 and drug = any($3) and day >= (now() at time zone $2)::date - ($4::int - 1)) g group by day`, [uid, TZ, await dopaDrugs(uid), days]);
    dd.rows.forEach((r) => { const o = row(r.day); o.doses = r.n; o.first_dose_h = r.first_t ? Number(String(r.first_t).slice(0, 2)) + Number(String(r.first_t).slice(3, 5)) / 60 : null; o.dose_gap_max = r.gap_max == null ? null : Number(r.gap_max); });
    const t = await pool.query(
      `select to_char((ts at time zone $2)::date,'YYYY-MM-DD') as day, metric, raw->>'battery' as phase, avg(value) as v from observations
       where user_id = $1 and source = 'motor' and metric in ('tap_rate','tremor_score') and raw->>'battery' in ('pre','post')
         and (ts at time zone $2)::date >= (now() at time zone $2)::date - ($3::int - 1) group by 1, 2, 3`, [uid, TZ, days]);
    const pp = {}; t.rows.forEach((r) => ((pp[r.day] = pp[r.day] || {})[r.metric + ":" + r.phase] = Number(r.v)));
    for (const [d, v] of Object.entries(pp)) { const o = row(d); if (v["tap_rate:pre"] != null && v["tap_rate:post"] != null) o.tap_delta = v["tap_rate:post"] - v["tap_rate:pre"]; if (v["tremor_score:pre"] != null && v["tremor_score:post"] != null) o.tremor_delta = v["tremor_score:post"] - v["tremor_score:pre"]; }
    // days with no events logged but with ratings count as 0 events (the absence is informative once the log exists)
    const firstEvent = await pool.query("select min(ts) as t from observations where user_id = $1 and source = 'event'", [uid]);
    const since = firstEvent.rows[0].t ? localDayOf(firstEvent.rows[0].t) : null;
    for (const d of Object.keys(table)) { if (since && d >= since) { ["events", "event_min", "dystonia"].forEach((k) => { if (table[d][k] == null) table[d][k] = 0; }); } }
    // supplements: 0 once the stack exists
    const firstSupp = await pool.query("select min(day) as d from med_doses where user_id = $1 and source = 'supplement'", [uid]);
    if (firstSupp.rows[0].d) { const sd = new Date(firstSupp.rows[0].d).toISOString().slice(0, 10); for (const d of Object.keys(table)) if (d >= sd && table[d].supps == null) table[d].supps = 0; }
    for (const d of Object.keys(table)) for (const k of Object.keys(table[d])) if (k.startsWith("src:")) delete table[d][k];
    cache.set(uid, { at: Date.now(), days, table });
    return table;
  }
  const invalidate = (uid) => cache.delete(uid);

  // ---------- helpers ----------
  const med = (a) => { const s = a.filter((v) => v != null).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
  const nextDay = (d) => new Date(new Date(d + "T12:00:00Z").getTime() + 86400000).toISOString().slice(0, 10);
  const fmtNum = (v, unit) => (v == null ? "?" : (Math.abs(v) >= 100 ? Math.round(v) : Number(v.toFixed(1))) + (unit ? " " + unit : ""));
  const fmtHour = (h) => `${String(Math.floor(h)).padStart(2, "0")}:${String(Math.round((h % 1) * 60)).padStart(2, "0")}`;

  // A hypothesis spec: {x, xdir: "above"|"below", thr: {type: "median"|"lit"|"any", value}, lag: 0|1, y, ydir: "up"|"down", period}
  // exposure(day) = x above/below thr; outcome(day+lag) = y above/below its median (or > 0 for counts with ydir "up").
  function describe(spec, refs) {
    const x = FK[spec.x], y = FK[spec.y];
    const tv = spec.thr.type === "median" ? (spec.thr.value != null ? spec.thr.value : refs.med[spec.x]) : spec.thr.value;
    const thrTxt = spec.thr.type === "any" ? "" : spec.thr.type === "median" ? ` (your median, ${x.unit === "h" && /time/.test(x.label) ? fmtHour(tv) : fmtNum(tv, x.unit)})` : ` (${x.unit === "h" && /time/.test(x.label) ? fmtHour(tv) : fmtNum(tv, x.unit)})`;
    const xTxt = spec.thr.type === "any" ? (spec.xdir === "above" ? `any ${x.label}` : `no ${x.label}`) : `${x.label} ${spec.xdir === "above" ? (/time/.test(x.label) ? "later than" : "above") : (/time/.test(x.label) ? "earlier than" : "below")}${thrTxt}`;
    const isCount = ["events", "dystonia", "event_min"].includes(spec.y);
    const yTxt = isCount ? (spec.ydir === "up" ? `${y.label} more likely` : `${y.label} less likely`) : `${y.label} ${spec.ydir === "up" ? "higher" : "lower"} than usual`;
    const when = spec.lag ? " the next day" : spec.lag === 0 && ["sleep_h", "deep_h", "rem_h", "sleep_score", "latency_min", "hrv", "lowest_hr", "readiness"].includes(spec.y) ? " that night" : " that day";
    return `${xTxt[0].toUpperCase() + xTxt.slice(1)} → ${yTxt}${when}`;
  }
  function exposureOf(spec, r, refs) {
    const v = r && r[spec.x]; if (v == null) return null;
    if (spec.thr.type === "any") return spec.xdir === "above" ? v > 0 : v <= 0;
    const t = spec.thr.value != null ? spec.thr.value : refs.med[spec.x]; if (t == null) return null;
    return spec.xdir === "above" ? v > t : v < t;
  }
  function outcomeOf(spec, r, refs) {
    const v = r && r[spec.y]; if (v == null) return null;
    if (["events", "dystonia", "event_min"].includes(spec.y)) return spec.ydir === "up" ? v > 0 : v === 0;
    const t = spec.ythr != null ? spec.ythr : refs.med[spec.y]; if (t == null) return null;
    return spec.ydir === "up" ? v > t : v < t;
  }
  // Score a spec over a set of days: 2×2 counts, rate difference, posterior P(rate_exposed > rate_control) in the
  // predicted direction (outcome is defined so that "true" = predicted), Beta(1,1) priors, Monte Carlo.
  function score(spec, table, refs, days) {
    let a = 0, b = 0, c = 0, d = 0; const perDay = [];
    for (const day of days) {
      const e = exposureOf(spec, table[day], refs); const o = outcomeOf(spec, table[spec.lag ? nextDay(day) : day], refs);
      let verdict = "na";
      if (e != null && o != null) { if (e) { o ? a++ : b++; } else { o ? c++ : d++; } verdict = e === o ? "support" : "refute"; }
      perDay.push({ day, exposure: e, outcome: o, verdict });
    }
    const nE = a + b, nC = c + d;
    const rE = nE ? a / nE : null, rC = nC ? c / nC : null;
    let post = null;
    if (nE && nC) { let wins = 0; const N = 600; for (let i = 0; i < N; i++) { if (betaSample(a + 1, b + 1) > betaSample(c + 1, d + 1)) wins++; } post = wins / N; }
    return { a, b, c, d, nE, nC, rE, rC, diff: rE != null && rC != null ? rE - rC : null, post, perDay, scored: nE + nC };
  }
  function betaSample(al, be) { const x = gammaSample(al), y = gammaSample(be); return x / (x + y); }
  function gammaSample(k) { // Marsaglia–Tsang
    if (k < 1) return gammaSample(k + 1) * Math.pow(Math.random(), 1 / k);
    const d = k - 1 / 3, c = 1 / Math.sqrt(9 * d);
    for (;;) { let x, v; do { x = gaussian(); v = 1 + c * x; } while (v <= 0); v = v * v * v; const u = Math.random(); if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v; }
  }
  function gaussian() { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
  function grade(sc) {
    if (!sc.scored) return "no data";
    if (sc.nE < 3 || sc.nC < 3) return "too early";
    if (sc.post >= 0.9) return "supported so far";
    if (sc.post <= 0.1) return "not holding up";
    return "mixed";
  }
  const specId = (spec) => crypto.createHash("sha1").update(JSON.stringify([spec.x, spec.xdir, spec.thr.type, spec.thr.value ?? null, spec.lag, spec.y, spec.ydir])).digest("hex").slice(0, 12);

  // ---------- generator ----------
  function candidates(table) {
    const days = Object.keys(table).sort();
    const refs = { med: Object.fromEntries(F.map((f) => [f.key, med(days.map((d) => table[d][f.key]))])) };
    const out = [];
    const xs = F.filter((f) => f.kind !== "outcome"), ys = F.filter((f) => f.kind !== "exposure");
    for (const x of xs) for (const y of ys) {
      if (x.key === y.key || x.fam === y.fam && x.fam !== "doses") continue;
      for (const lag of [0, 1]) {
        if (lag === 0 && y.fam === "sleep" && x.fam !== "sleep") { /* same-day sleep is "that night" — fine */ }
        if (lag === 1 && x.fam === "events" && y.fam === "events") continue;
        const thrs = [{ type: "median" }]; if (x.lit != null) thrs.push({ type: "lit", value: x.lit });
        if (["events", "supps", "dystonia", "batteries"].includes(x.key)) thrs.length = 0, thrs.push({ type: "any" });
        for (const thr of thrs) for (const xdir of ["above", "below"]) for (const ydir of ["up", "down"]) {
          // predicted direction must be a coherent story: use the registry's "better" hints to drop the nonsensical half
          const xBad = (xdir === "above" && x.better === -1) || (xdir === "below" && x.better === 1); // exposure is the "bad" side
          const yBad = (ydir === "up" && y.better === -1) || (ydir === "down" && y.better === 1);
          if (x.better !== 0 && y.better !== 0 && xBad !== yBad) continue; // bad exposure → bad outcome, good → good
          if (x.better === 0 && ydir === "up" && y.better === -1) { /* allowed: neutral exposure, bad outcome */ }
          if (thr.type === "any" && xdir === "below") continue;
          const spec = { x: x.key, xdir, thr, lag, y: y.key, ydir, period: lag ? 10 : 7 };
          out.push(spec);
        }
      }
    }
    return { specs: out, refs, days };
  }

  // Vote model: weights over attributes (x family, y family, x key, y key, lag, controllable, template) learned from votes by
  // a few passes of online logistic regression; prediction feeds the ranking.
  function attrs(spec) { const x = FK[spec.x], y = FK[spec.y]; return [`xf:${x.fam}`, `yf:${y.fam}`, `x:${spec.x}`, `y:${spec.y}`, `lag:${spec.lag}`, `ctrl:${x.ctrl ? 1 : 0}`, `thr:${spec.thr.type}`, `pair:${x.fam}>${y.fam}`]; }
  function trainVoteModel(voted) { // voted: [{spec, vote}]
    const w = {}; if (!voted.length) return w;
    for (let pass = 0; pass < 25; pass++) for (const { spec, vote } of voted) {
      const a = attrs(spec); const z = a.reduce((s, k) => s + (w[k] || 0), 0); const p = 1 / (1 + Math.exp(-z)); const t = vote > 0 ? 1 : 0;
      a.forEach((k) => (w[k] = (w[k] || 0) + 0.15 * (t - p) - 0.002 * (w[k] || 0)));
    }
    return w;
  }
  const votePred = (w, spec) => { const z = attrs(spec).reduce((s, k) => s + (w[k] || 0), 0); return 1 / (1 + Math.exp(-z)); };

  function rank(table, exclude, voted, recentDays = 45) {
    const { specs, refs, days } = candidates(table);
    const recent = days.slice(-recentDays);
    const w = trainVoteModel(voted);
    const activeAttrs = new Set();
    const ranked = [];
    // Dismissals are explicit: never re-propose the same "if" with the same kind of "then", and cool off the same "if" at all.
    const dismissed = voted.filter((v) => v.vote < 0).map((v) => v.spec);
    for (const spec of specs) {
      const id = specId(spec); if (exclude.has(id)) continue;
      if (dismissed.some((d) => d.x === spec.x && FK[d.y].fam === FK[spec.y].fam)) continue;
      const cool = dismissed.some((d) => d.x === spec.x) ? 0.2 : dismissed.some((d) => FK[d.x].fam === FK[spec.x].fam) ? 0.08 : 0;
      const sc = score(spec, table, refs, recent);
      const coverage = recent.length ? sc.scored / recent.length : 0;
      if (coverage < 0.4 || sc.nE < 3 || sc.nC < 3) continue; // must be scorable and both arms populated
      const balance = Math.min(sc.nE, sc.nC) / Math.max(sc.nE, sc.nC);
      const x = FK[spec.x], y = FK[spec.y];
      const pr = prior(x.fam, y.fam);
      const hint = sc.diff == null ? 0 : Math.max(0, sc.diff); // retrospective effect in the predicted direction, a hint only
      const v = voted.length ? votePred(w, spec) : 0.5;
      const s = 0.25 * coverage + 0.15 * balance + 0.25 * pr + 0.15 * hint + 0.15 * v + 0.05 * (x.ctrl ? 1 : 0) - cool;
      ranked.push({ id, spec, text: describe(spec, refs), score: s, coverage: Number(coverage.toFixed(2)), prior: pr, hint: Number(hint.toFixed(2)), votePred: Number(v.toFixed(2)), retro: { nE: sc.nE, nC: sc.nC, rE: sc.rE, rC: sc.rC, post: sc.post } });
    }
    ranked.sort((p, q) => q.score - p.score);
    // diversity: no two sharing both families; at most 2 per outcome family in the queue, and the same outcome feature
    // pays a growing penalty so the right-hand side varies (QoL would otherwise dominate because it is rated daily).
    const seenPair = new Set(), yFamCount = {}, yKeyCount = {}, xKeyCount = {}, diverse = [];
    for (const r of ranked) {
      const yf = FK[r.spec.y].fam, k = `${FK[r.spec.x].fam}>${yf}`;
      if (seenPair.has(k)) continue;
      if ((yFamCount[yf] || 0) >= 2 || (xKeyCount[r.spec.x] || 0) >= 2) continue;
      xKeyCount[r.spec.x] = (xKeyCount[r.spec.x] || 0) + 1;
      const penalty = 0.06 * (yKeyCount[r.spec.y] || 0);
      seenPair.add(k); yFamCount[yf] = (yFamCount[yf] || 0) + 1; yKeyCount[r.spec.y] = (yKeyCount[r.spec.y] || 0) + 1;
      diverse.push({ ...r, score: r.score - penalty });
    }
    diverse.sort((p, q) => q.score - p.score);
    return { ranked: diverse, refs };
  }

  // ---------- persistence ----------
  async function ensureTables() {
    await pool.query(`create table if not exists hypotheses (
      id text not null, user_id int not null references users(id) on delete cascade, spec jsonb not null, text text not null,
      status text not null default 'active', started date, period int, vote int default 0, reason text, pinned boolean default false,
      created_at timestamptz not null default now(), updated_at timestamptz not null default now(), primary key (user_id, id))`);
    await pool.query("alter table hypotheses add column if not exists pinned boolean default false");
  }
  async function listActive(uid) { return (await pool.query("select * from hypotheses where user_id = $1 and status = 'active' order by created_at", [uid])).rows; }
  async function voted(uid) { return (await pool.query("select spec, vote from hypotheses where user_id = $1 and vote <> 0", [uid])).rows.map((r) => ({ spec: r.spec, vote: r.vote })); }
  async function activate(uid, cand, today, refs) {
    // Freeze the thresholds at activation so the definition can't drift while it is being graded.
    if (refs) { if (cand.spec.thr.type === "median" && cand.spec.thr.value == null) cand.spec.thr.value = refs.med[cand.spec.x]; if (cand.spec.ythr == null && !["events", "dystonia", "event_min"].includes(cand.spec.y)) cand.spec.ythr = refs.med[cand.spec.y]; }
    await pool.query(`insert into hypotheses (id, user_id, spec, text, status, started, period) values ($1,$2,$3,$4,'active',$5,$6)
      on conflict (user_id, id) do update set status = 'active', started = excluded.started, period = excluded.period, text = excluded.text, updated_at = now()`,
      [cand.id, uid, cand.spec, cand.text, today, cand.spec.period]);
  }
  async function wantCount(uid) {
    const { rows } = await pool.query("select (data->>'hypothesis_count')::int as n from settings where user_id = $1", [uid]);
    return Math.max(1, Math.min(8, (rows[0] && rows[0].n) || 3));
  }
  async function fillActive(uid, table, today) {
    const want = await wantCount(uid);
    let act = await listActive(uid);
    if (act.length > want) { // trimmed: retire the unpinned ones with the weakest evidence first
      const extra = act.filter((h) => !h.pinned).slice(0, act.length - want);
      for (const h of extra) await pool.query("update hypotheses set status = 'retired', reason = 'trimmed', updated_at = now() where user_id = $1 and id = $2", [uid, h.id]);
      act = await listActive(uid);
    }
    if (act.length >= want) return act;
    const seen = new Set((await pool.query("select id from hypotheses where user_id = $1", [uid])).rows.map((r) => r.id));
    const { ranked, refs } = rank(table, seen, await voted(uid));
    const usedX = new Set(act.map((h) => h.spec.x)), usedPair = new Set(act.map((h) => `${FK[h.spec.x].fam}>${FK[h.spec.y].fam}`)), usedY = new Set(act.map((h) => h.spec.y));
    let n = act.length;
    const tryFill = (strict) => async () => { for (const cand of ranked) {
      if (n >= want) break; if (seen.has(cand.id)) continue;
      const pair = `${FK[cand.spec.x].fam}>${FK[cand.spec.y].fam}`;
      if (strict && (usedX.has(cand.spec.x) || usedPair.has(pair) || usedY.has(cand.spec.y))) continue;
      if (!strict && usedPair.has(pair)) continue;
      await activate(uid, cand, today, refs); seen.add(cand.id); usedX.add(cand.spec.x); usedPair.add(pair); usedY.add(cand.spec.y); n++;
    } };
    await tryFill(true)(); if (n < want) await tryFill(false)();
    return listActive(uid);
  }
  // End-of-period bookkeeping: supported → finding; expired without support → retired (pinned ones never expire).
  async function settle(uid, table) {
    const evald = await evaluateActive(uid, table);
    const today = localDayOf(new Date());
    for (const h of evald) {
      const ended = !h.pinned && h.days.length >= h.period && h.days[h.days.length - 1].day < today;
      if (h.grade === "supported so far" && h.days.length >= h.period) await pool.query("update hypotheses set status = 'finding', reason = 'supported over its period', updated_at = now() where user_id = $1 and id = $2", [uid, h.id]);
      else if (ended) await pool.query("update hypotheses set status = 'retired', reason = $3, updated_at = now() where user_id = $1 and id = $2", [uid, h.id, h.grade === "not holding up" ? "refuted" : "expired"]);
    }
  }
  async function evaluateActive(uid, table, statusList = ["active"]) {
    const act = (await pool.query("select * from hypotheses where user_id = $1 and status = any($2) order by created_at", [uid, statusList])).rows;
    const days = Object.keys(table).sort();
    const refs = { med: Object.fromEntries(F.map((f) => [f.key, med(days.map((d) => table[d][f.key]))])) };
    const today = localDayOf(new Date());
    return act.map((h) => {
      const spec = h.spec; const start = h.started ? new Date(h.started).toISOString().slice(0, 10) : today;
      const period = h.period || spec.period || 7;
      const open = h.pinned || h.status === "finding"; // pinned and findings keep accumulating days past the period
      const win = []; for (let i = 0; i < (open ? 400 : period); i++) { const d = new Date(new Date(start + "T12:00:00Z").getTime() + i * 86400000).toISOString().slice(0, 10); if (d > today) break; win.push(d); }
      const sc = score(spec, table, refs, win);
      const retro = score(spec, table, refs, days.filter((d) => d < start).slice(-45));
      const x = FK[spec.x], y = FK[spec.y];
      return { id: h.id, text: describe(spec, refs), spec, exposure: x.label, outcome: y.label, lag: spec.lag, started: start, period, vote: h.vote, pinned: Boolean(h.pinned), status: h.status, reason: h.reason,
        days: sc.perDay, support: sc.perDay.filter((p) => p.verdict === "support").length, refute: sc.perDay.filter((p) => p.verdict === "refute").length, na: sc.perDay.filter((p) => p.verdict === "na").length,
        twoByTwo: { withExposure: { yes: sc.a, no: sc.b }, without: { yes: sc.c, no: sc.d } }, rateWith: sc.rE, rateWithout: sc.rC, diff: sc.diff, posterior: sc.post, grade: grade(sc),
        retro: { scored: retro.scored, rateWith: retro.rE, rateWithout: retro.rC, posterior: retro.post }, controllable: x.ctrl, families: [x.fam, y.fam] };
    });
  }

  // ---------- routes ----------
  function routes(app, requireAuth) {
    app.get("/api/hypotheses", requireAuth, async (req, res) => {
      const uid = req.user.id; const table = await buildFeatures(uid, 60);
      await settle(uid, table);
      await fillActive(uid, table, localDayOf(new Date()));
      const active = await evaluateActive(uid, table);
      const findings = await evaluateActive(uid, table, ["finding"]);
      const seen = new Set((await pool.query("select id from hypotheses where user_id = $1", [uid])).rows.map((r) => r.id));
      const { ranked } = rank(table, seen, await voted(uid));
      // Findings straight from history: strong, well-populated retrospective effects nobody has tracked or discarded.
      const generatorFindings = ranked.filter((r) => r.retro.post != null && r.retro.post >= 0.95 && r.retro.nE >= 5 && r.retro.nC >= 5)
        .slice(0, 6).map((r) => ({ id: r.id, text: r.text, rateWith: r.retro.rE, rateWithout: r.retro.rC, posterior: r.retro.post, nE: r.retro.nE, nC: r.retro.nC, spec: r.spec }));
      const history = (await pool.query("select id, text, status, started, period, vote, reason, updated_at from hypotheses where user_id = $1 and status in ('retired') order by updated_at desc limit 20", [uid])).rows;
      res.json({ active, findings, generatorFindings, queue: ranked.slice(0, 5).map((r) => ({ id: r.id, text: r.text, coverage: r.coverage, prior: r.prior, hint: r.hint })), history, candidates: ranked.length, features: Object.keys(table).length, count: await wantCount(uid) });
    });
    app.post("/api/hypotheses/pin", requireAuth, async (req, res) => {
      await pool.query("update hypotheses set pinned = $3, updated_at = now() where user_id = $1 and id = $2", [req.user.id, String(req.body.id || ""), Boolean(req.body.pinned)]);
      res.json({ ok: true });
    });
    app.post("/api/hypotheses/count", requireAuth, async (req, res) => {
      const n = Math.max(1, Math.min(8, Number(req.body.count) || 3));
      await pool.query(`insert into settings (user_id, data) values ($1, jsonb_build_object('hypothesis_count', $2::int)) on conflict (user_id) do update set data = settings.data || jsonb_build_object('hypothesis_count', $2::int)`, [req.user.id, n]);
      res.json({ ok: true, count: n });
    });
    // Discard a finding (tracked or generator-only): it stays hidden and is never re-proposed.
    app.post("/api/hypotheses/discard", requireAuth, async (req, res) => {
      const id = String(req.body.id || ""); const spec = req.body.spec || null; const text = String(req.body.text || "");
      const r = await pool.query("update hypotheses set status = 'discarded', reason = 'discarded finding', updated_at = now() where user_id = $1 and id = $2", [req.user.id, id]);
      if (!r.rowCount && spec) await pool.query("insert into hypotheses (id, user_id, spec, text, status, reason) values ($1,$2,$3,$4,'discarded','discarded finding') on conflict (user_id, id) do update set status = 'discarded', updated_at = now()", [id, req.user.id, spec, text]);
      res.json({ ok: true });
    });
    app.post("/api/hypotheses/vote", requireAuth, async (req, res) => {
      const v = Math.max(-1, Math.min(1, Number(req.body.vote) || 0));
      await pool.query("update hypotheses set vote = $3, updated_at = now() where user_id = $1 and id = $2", [req.user.id, String(req.body.id || ""), v]);
      res.json({ ok: true });
    });
    // Retire one active hypothesis (reason: dismissed | refresh) and activate the best-ranked unseen candidate.
    app.post("/api/hypotheses/refresh", requireAuth, async (req, res) => {
      const uid = req.user.id; const id = String(req.body.id || "");
      const pinned = await pool.query("select pinned from hypotheses where user_id = $1 and id = $2", [uid, id]);
      if (pinned.rows[0] && pinned.rows[0].pinned) return res.status(400).json({ error: "pinned" });
      await pool.query("update hypotheses set status = 'retired', reason = $3, updated_at = now() where user_id = $1 and id = $2 and status = 'active'", [uid, id, req.body.reason || "refresh"]);
      const table = await buildFeatures(uid, 60);
      await fillActive(uid, table, localDayOf(new Date()));
      res.json({ active: await evaluateActive(uid, table) });
    });
    app.get("/api/features", requireAuth, async (req, res) => {
      const table = await buildFeatures(req.user.id, Math.min(365, Number(req.query.days) || 60), req.query.force === "1");
      res.json({ registry: F.map(({ key, label, unit, fam, ctrl, kind }) => ({ key, label, unit, fam, ctrl, kind })), days: Object.values(table).sort((a, b) => a.day.localeCompare(b.day)) });
    });
  }

  return { routes, buildFeatures, invalidate, ensureTables, F };
};
