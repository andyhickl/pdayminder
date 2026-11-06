// Insights: short, actionable observations for the Home tab. Five generators (goal gaps, today's conflicts, emerging
// patterns, findings, notes) produce candidates from the hypotheses feature table plus a few direct queries; each one
// is a key (so it can be voted, pinned, cooled down and never repeated verbatim), one sentence of observation, one of
// action, a "why" grounded in the literature, and links into the data. Shown set is persisted in `insights`.
module.exports = function init({ pool, hyp, TZ, localDayOf, exerciseProfile, workoutDays, dopaDrugs }) {
  const COOL_DAYS = 7, DISMISS_DAYS = 30, SHOW_DAYS = 7;

  async function ensureTables() {
    await pool.query(`create table if not exists insights (
      id serial primary key, user_id int not null references users(id) on delete cascade, key text not null, kind text not null, family text,
      text text not null, action text, why text, cite text, strength text, numbers jsonb, links jsonb,
      status text not null default 'candidate', vote int not null default 0, pinned boolean not null default false,
      shown_at timestamptz, cooled_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
      unique (user_id, key))`);
  }

  // ---------- helpers ----------
  const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
  const r0 = (v) => (v == null ? null : Math.round(v));
  const mean = (a) => { const s = a.filter((v) => v != null); return s.length ? s.reduce((x, y) => x + y, 0) / s.length : null; };
  const med = hyp.med;
  const mad = (a, m) => { const s = a.filter((v) => v != null).map((v) => Math.abs(v - m)); return med(s); };
  const fmtDay = (d) => new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
  const localHour = (ts) => { const [h, m] = new Date(ts).toLocaleTimeString("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit" }).split(":").map(Number); return h + m / 60; };
  const hm = (h) => { const hh = Math.floor(h), mm = Math.round((h - hh) * 60); return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`; };
  const CITE = {
    sparx: "Schenkman 2018, JAMA Neurol (SPARX): 4 × 30 min/week at 80–85 % HRmax held UPDRS-III steady over 6 months; 60–65 % did not.",
    pis: "van der Kolk 2019, Lancet Neurol (Park-in-Shape): 30–45 min home cycling 3×/week at 50–80 % HRR improved off-state motor scores.",
    protein: "Cereda 2010, Mov Disord (meta-analysis): levodopa competes with large neutral amino acids for gut and brain transport; moving protein away from doses shortens time-to-on and off time.",
    caffeine: "Drake 2013, J Clin Sleep Med: 400 mg caffeine 6 h before bed cut sleep by about an hour; half-life ~5 h.",
    sleep: "Chahine 2017, Sleep Med Rev: short and fragmented sleep worsens next-day motor and non-motor PD symptoms; Oura total sleep is the measure here.",
    wearing: "Stocchi 2015, Parkinsonism Relat Disord: wearing-off tracks the gap between doses; regular intervals smooth plasma levodopa.",
    battery: "Pre/post-dose pairs are what make the levodopa response readable (Zhan 2018, mPower composite; this app's design).",
    fiber: "Block 1 regimen: 25–30 g/day fiber for PD constipation prevention (Barichella 2016, Neurology, fiber-and-probiotic RCT).",
    drift: "Slow measures (night HRV, voice, gait, tapping) move over weeks, not days; a half-SD shift of the last two weeks against the previous four is the signal to watch (this app's personal baselines).",
  };

  // ---------- generators ----------
  // Each returns [{ key, kind, family, text, action, why, cite, strength, base, numbers, links }]
  async function genGoals(uid, table, days, today) {
    const out = [];
    // exercise dose this week
    const prof = await exerciseProfile(uid);
    const byDay = await workoutDays(uid, 14);
    const dow = (new Date(today + "T12:00:00Z").getUTCDay() + 6) % 7; // Mon = 0
    const monday = new Date(new Date(today + "T12:00:00Z").getTime() - dow * 86400000).toISOString().slice(0, 10);
    let vig = 0, sessions = 0; for (const [d, x] of Object.entries(byDay)) if (d >= monday && d <= today) { vig += x.workout_vigorous; sessions += x.workouts_count; }
    const target = prof.weeklyVigorousMin || 120, left = 6 - dow;
    if (Object.keys(byDay).length) {
      if (vig < target && left >= 0) {
        const gap = target - vig;
        out.push({ key: `goal:vigorous:${monday}`, kind: "goal", family: "exercise", base: 0.8 + Math.min(0.2, gap / target * 0.2),
          text: `${gap} vigorous minutes short of this week's ${target} (${vig} so far, ${sessions} session${sessions === 1 ? "" : "s"}), with ${left === 0 ? "today left" : left + " day" + (left === 1 ? "" : "s") + " left"}.`,
          action: gap <= 35 ? `One 30-minute row holding ≥${prof.vigorousBpm} bpm covers it.` : `${Math.ceil(gap / 30)} sessions of 30 minutes at ≥${prof.vigorousBpm} bpm gets there; vigorous means above ${prof.vigorousBpm} bpm for you.`,
          why: CITE.sparx, cite: "sparx", strength: "goal", numbers: { vig, gap, sessions }, links: [{ label: "Exercise dose", tab: "stats", section: "st-exercise" }] });
      } else if (vig >= target) {
        out.push({ key: `win:vigorous:${monday}`, kind: "note", family: "exercise", base: 0.6, text: `This week already carries ${vig} vigorous minutes: the SPARX dose is met.`, action: "Keep the rhythm; the trial effect needed six months of it.", why: CITE.sparx, cite: "sparx", strength: "milestone", numbers: { vig }, links: [{ label: "Workouts", tab: "trends", section: "tr-workouts" }] });
      }
    }
    // protein near dose, 7-day mean
    const last7 = days.slice(-7);
    const pnd = mean(last7.map((d) => table[d].protein_near_dose));
    const pndDays = last7.filter((d) => table[d].protein_near_dose != null).length;
    if (pnd != null && pndDays >= 3 && pnd >= 15) out.push({ key: "goal:protein_near_dose", kind: "goal", family: "nutrition", base: 0.75,
      text: `Over the last ${pndDays} logged days, ${r0(pnd)} g of protein a day landed within 90 minutes of a levodopa dose.`, action: "Keep the dose where it is and move the protein: take Sinemet 30–60 min before a protein-heavy meal, or shift the protein to the evening.", why: CITE.protein, cite: "protein", strength: "goal", numbers: { pnd: r0(pnd) }, links: [{ label: "Nutrition trends", tab: "trends", section: "tr-nutrition" }] });
    // sleep, 7-day mean
    const sl = mean(last7.map((d) => table[d].sleep_h)); const slN = last7.filter((d) => table[d].sleep_h != null).length;
    if (sl != null && slN >= 4 && sl < 6.8) out.push({ key: "goal:sleep", kind: "goal", family: "sleep", base: 0.7,
      text: `Sleep averaged ${r1(sl)} h over the last ${slN} nights.`, action: "Aim for 7 h: with a 06:00 rise that means lights out by 22:30, and the 21:00 melatonin is already on your side.", why: CITE.sleep, cite: "sleep", strength: "goal", numbers: { sl: r1(sl) }, links: [{ label: "Vitals trends", tab: "trends", section: "tr-vitals" }] });
    // dose gaps
    const gaps = last7.filter((d) => table[d].dose_gap_max != null && table[d].doses >= 2);
    const longGaps = gaps.filter((d) => table[d].dose_gap_max > 6);
    if (gaps.length >= 3 && longGaps.length >= 2) out.push({ key: "goal:dose_gap", kind: "goal", family: "doses", base: 0.65,
      text: `The longest gap between levodopa doses passed 6 h on ${longGaps.length} of the last ${gaps.length} multi-dose days (${longGaps.map((d) => fmtDay(d).slice(0, 3)).join(", ")}).`, action: "If those afternoons felt flat, that is wearing-off; worth telling your neurologist the gap, not just the feeling.", why: CITE.wearing, cite: "wearing", strength: "goal", numbers: { n: longGaps.length }, links: longGaps.map((d) => ({ label: fmtDay(d), day: d })) });
    // batteries this week
    const bat = days.filter((d) => d >= monday && d <= today).map((d) => table[d].batteries || 0);
    const batDays = bat.filter((b) => b >= 2).length, elapsed = dow + 1;
    if (elapsed >= 3 && batDays < elapsed - 1) out.push({ key: `goal:batteries:${monday}`, kind: "goal", family: "doses", base: 0.55,
      text: `${batDays} of ${elapsed} days this week had both the pre- and post-dose battery.`, action: "The pair is the measurement; one battery a day shows the state, two show the response.", why: CITE.battery, cite: "battery", strength: "adherence", numbers: { batDays, elapsed }, links: [{ label: "Run tests", tab: "qol", section: "qol-tests" }] });
    // fiber
    const fb = mean(last7.map((d) => table[d].fiber)); const fbN = last7.filter((d) => table[d].fiber != null).length;
    if (fb != null && fbN >= 3 && fb < 20) out.push({ key: "goal:fiber", kind: "goal", family: "nutrition", base: 0.5,
      text: `Fiber averaged ${r0(fb)} g/day over ${fbN} logged days; the regimen target is 25–30 g.`, action: "The psyllium covers 5–10 g; a serving of beans or oats and two fruits closes the rest.", why: CITE.fiber, cite: "fiber", strength: "goal", numbers: { fb: r0(fb) }, links: [{ label: "Nutrition trends", tab: "trends", section: "tr-nutrition" }] });
    return out;
  }

  async function genToday(uid, today) {
    const out = [];
    const dopa = await dopaDrugs(uid);
    const doses = (await pool.query("select taken_at from med_doses where user_id = $1 and day = $2 and drug = any($3) order by taken_at", [uid, today, dopa])).rows.map((r) => { const [h, m] = String(r.taken_at).split(":").map(Number); return h + m / 60; });
    const hourly = (await pool.query(`select metric, ts, value from observations where user_id = $1 and source = 'hae' and metric in ('protein','caffeine') and (ts at time zone $2)::date = $3::date and value > 0`, [uid, TZ, today])).rows
      .map((r) => ({ metric: r.metric, h: localHour(r.ts), value: Number(r.value) }));
    // protein within 60 min after a dose (hourly buckets: the bucket starting within an hour after the dose)
    for (const p of hourly.filter((x) => x.metric === "protein" && x.value >= 15)) {
      const d = doses.find((t) => p.h + 1 > t && p.h < t + 1); // bucket overlaps the hour after the dose
      if (d != null) out.push({ key: `today:protein:${today}:${Math.round(p.h)}`, kind: "today", family: "nutrition", base: 1.0,
        text: `${r0(p.value)} g of protein in the ${hm(p.h)} hour, right after the ${hm(d)} Sinemet.`, action: "Next time take the dose 30–60 min before the meal, or keep that meal lighter on protein and move it to the evening.", why: CITE.protein, cite: "protein", strength: "today", numbers: { g: r0(p.value) }, links: [{ label: "Today", day: today }] });
    }
    // caffeine after 14:00
    const lateCaf = hourly.filter((x) => x.metric === "caffeine" && x.h >= 14 && x.value >= 40);
    if (lateCaf.length) { const tot = lateCaf.reduce((a, x) => a + x.value, 0); out.push({ key: `today:caffeine:${today}`, kind: "today", family: "nutrition", base: 0.9,
      text: `${r0(tot)} mg of caffeine after 14:00 today (${lateCaf.map((x) => hm(x.h)).join(", ")}).`, action: "With a ~5 h half-life, a third of it is still on board at 22:00; keep caffeine to the morning if sleep onset matters tonight.", why: CITE.caffeine, cite: "caffeine", strength: "today", numbers: { tot: r0(tot) }, links: [{ label: "Today", day: today }] }); }
    // long gap right now
    const nowH = localHour(new Date());
    const s = (await pool.query("select data from settings where user_id = $1", [uid])).rows[0];
    const expected = ((s && s.data && s.data.medications) || []).filter((m) => m.dopaminergic).reduce((a, m) => a + ((m.times || []).length || 0), 0) || 3;
    if (doses.length && doses.length < expected && nowH - doses[doses.length - 1] > 5 && nowH < 22) out.push({ key: `today:gap:${today}:${doses.length}`, kind: "today", family: "doses", base: 0.95,
      text: `${r1(nowH - doses[doses.length - 1])} h since the ${hm(doses[doses.length - 1])} dose, with ${expected - doses.length} of today's ${expected} still to come.`, action: "If you are past the plan, log the next dose when you take it; the ring and the post-dose battery both key off it.", why: CITE.wearing, cite: "wearing", strength: "today", numbers: { h: r1(nowH - doses[doses.length - 1]) }, links: [{ label: "Today", day: today }] });
    return out;
  }

  function genPatterns(snap) {
    const out = [];
    const verb = (h) => (h.spec && h.spec.dir != null ? h.spec.dir : null);
    for (const h of snap.active || []) {
      if (h.posterior == null || h.posterior < 0.8 || h.twoByTwo.withExposure.yes + h.twoByTwo.withExposure.no < 4 || h.twoByTwo.without.yes + h.twoByTwo.without.no < 4) continue;
      const nE = h.twoByTwo.withExposure.yes + h.twoByTwo.withExposure.no, nC = h.twoByTwo.without.yes + h.twoByTwo.without.no;
      out.push({ key: `pattern:${h.id}`, kind: "pattern", family: h.families[0], base: 0.6 + 0.3 * (h.posterior - 0.8) / 0.2,
        text: `Early (${nE} vs ${nC} days, ${Math.round(h.posterior * 100)} % sure): ${h.text.replace(/\.$/, "")}: ${Math.round(h.rateWith * 100)} % of days vs ${Math.round(h.rateWithout * 100)} %.`,
        action: h.controllable ? `This one is in your hands: the "${h.exposure}" side is something you can set this week and watch.` : `Not something to steer, but worth knowing when you plan the day.`,
        why: h.rationale, cite: null, strength: "emerging", numbers: { post: Math.round(h.posterior * 100), nE, nC }, links: [{ label: "Hypotheses", tab: "trends", section: "tr-hyp" }] });
    }
    return out;
  }

  function genFindings(snap) {
    const out = [];
    for (const f of snap.findings || []) out.push({ key: `finding:${f.id}`, kind: "finding", family: f.families[0], base: 0.45,
      text: `Held up over ${f.dayIndex} days: ${f.text.replace(/\.$/, "")} (${Math.round(f.rateWith * 100)} % vs ${Math.round(f.rateWithout * 100)} %).`, action: f.controllable ? "Treat it as a rule for now; it stays scored every day and will say if it stops holding." : "Keep it in mind when reading a bad day.", why: f.rationale, strength: "supported", numbers: { post: Math.round((f.posterior || 0) * 100) }, links: [{ label: "Findings", tab: "trends", section: "tr-findings" }] });
    for (const g of (snap.generatorFindings || []).filter((g) => !g.weakened).sort((a, b) => (b.posterior || 0) - (a.posterior || 0)).slice(0, 3)) out.push({ key: `lead:${g.id}`, kind: "finding", family: (g.spec && hyp.FK[g.spec.x] && hyp.FK[g.spec.x].fam) || null, base: 0.35,
      text: `From your history (${g.nE} vs ${g.nC} days): ${g.text.replace(/\.$/, "")}: ${Math.round(g.rateWith * 100)} % vs ${Math.round(g.rateWithout * 100)} %.`, action: "Not tested forward yet; pin it if you want it kept in view, or let the hypotheses queue pick it up.", why: g.rationale, strength: "historical", numbers: { post: Math.round((g.posterior || 0) * 100) }, links: [{ label: "Findings", tab: "trends", section: "tr-findings" }] });
    return out;
  }

  async function genNotes(uid, table, days, today) {
    const out = [];
    const FK = hyp.FK;
    const last30 = days.slice(-30);
    // best day in 30 and what was different
    const rated = last30.filter((d) => table[d].qol != null);
    if (rated.length >= 7) {
      const best = rated.reduce((a, d) => (table[d].qol > table[a].qol ? d : a), rated[0]);
      const diffs = [];
      for (const f of hyp.F) {
        if (f.kind === "outcome" || !f.ctrl) continue;
        const v = table[best][f.key]; if (v == null) continue;
        const vals = last30.map((d) => table[d][f.key]).filter((x) => x != null); if (vals.length < 7) continue;
        const m = med(vals), s = mad(vals, m) || 0; if (!s) continue;
        const z = (v - m) / (1.4826 * s); if (Math.abs(z) >= 1.5) diffs.push({ f, v, m, z });
      }
      diffs.sort((a, b) => Math.abs(b.z) - Math.abs(a.z));
      const parts = diffs.slice(0, 3).map((x) => `${x.f.label} ${r1(x.v)}${x.f.unit ? " " + x.f.unit : ""} (usually ${r1(x.m)})`);
      if (parts.length) out.push({ key: `note:best:${best}`, kind: "note", family: diffs[0].f.fam, base: 0.55,
        text: `Your best day in the last 30 was ${fmtDay(best)} (QoL ${r1(table[best].qol)}). What was different: ${parts.join("; ")}.`, action: "One day proves nothing, but it is a cheap experiment to repeat.", why: "An unusual good day is the natural place to look for levers; the hypotheses engine tests them properly once there are enough days.", strength: "one day", numbers: { qol: r1(table[best].qol) }, links: [{ label: fmtDay(best), day: best }] });
    }
    // streaks
    const streak = (pred) => { let n = 0; for (let i = days.length - 1; i >= 0; i--) { if (pred(table[days[i]], days[i])) n++; else break; } return n; };
    const sW = streak((t) => (t.workout_min || 0) >= 20); if (sW >= 3) out.push({ key: `note:streak:workout:${sW}`, kind: "note", family: "exercise", base: 0.5, text: `${sW} days running with a workout of 20 minutes or more.`, action: "Streaks are the adherence the trials needed; protect tomorrow's slot.", why: CITE.pis, cite: "pis", strength: "milestone", numbers: { sW }, links: [{ label: "Workouts", tab: "trends", section: "tr-workouts" }] });
    const sB = streak((t) => (t.batteries || 0) >= 2); if (sB >= 3) out.push({ key: `note:streak:batteries:${sB}`, kind: "note", family: "doses", base: 0.45, text: `${sB} days in a row with both batteries run.`, action: "That is enough to start seeing your own levodopa response in the tapping and tremor deltas.", why: CITE.battery, cite: "battery", strength: "milestone", numbers: { sB }, links: [{ label: "Motor test trends", tab: "trends", section: "tr-motor" }] });
    // personal bests (90 d)
    const wd = await workoutDays(uid, 90);
    const wdays = Object.keys(wd).sort();
    if (wdays.length >= 3) { const bestV = wdays.reduce((a, d) => (wd[d].workout_vigorous > wd[a].workout_vigorous ? d : a), wdays[0]); if (bestV === today || bestV === days[days.length - 2]) out.push({ key: `note:pb:vigorous:${bestV}`, kind: "note", family: "exercise", base: 0.5, text: `${fmtDay(bestV)} was your most vigorous day in 90: ${wd[bestV].workout_vigorous} minutes in zone.`, action: "A 30-minute block in zone is the SPARX session; you are close.", why: CITE.sparx, cite: "sparx", strength: "milestone", numbers: { v: wd[bestV].workout_vigorous }, links: [{ label: fmtDay(bestV), day: bestV }] }); }
    // slow-measure drift: last 14 days vs previous 28
    for (const key of ["walk_speed", "tap_rate", "ddk", "hrv", "dbl_support"]) {
      const f = FK[key]; const rec = days.slice(-14).map((d) => table[d][key]).filter((v) => v != null); const prev = days.slice(-42, -14).map((d) => table[d][key]).filter((v) => v != null);
      if (rec.length < 5 || prev.length < 8) continue;
      const m1 = mean(rec), m0 = mean(prev); const sd = Math.sqrt(mean(prev.map((v) => (v - m0) ** 2))) || 0; if (!sd) continue;
      const z = (m1 - m0) / sd; if (Math.abs(z) < 0.5) continue;
      const better = f.better === 0 ? null : (z > 0) === (f.better > 0);
      out.push({ key: `note:drift:${key}:${today.slice(0, 7)}`, kind: "note", family: f.fam, base: better === false ? 0.65 : 0.45,
        text: `${f.label[0].toUpperCase() + f.label.slice(1)} over the last two weeks averages ${r1(m1)}${f.unit ? " " + f.unit : ""}, ${better === false ? "worse" : better ? "better" : "different"} than the previous four weeks (${r1(m0)}) by ${Math.abs(z).toFixed(1)} SD.`,
        action: better === false ? "Slow drift is the kind of thing a neurologist visit should hear about with the number attached." : "A real shift in the right direction; keep whatever changed.", why: CITE.drift, cite: "drift", strength: "trend", numbers: { m1: r1(m1), m0: r1(m0) }, links: [{ label: "Trends", tab: "trends", section: f.fam === "hrv" ? "tr-vitals" : "tr-motor" }] });
    }
    // week-over-week QoL
    const w1 = mean(days.slice(-7).map((d) => table[d].qol)), w0 = mean(days.slice(-14, -7).map((d) => table[d].qol));
    const n1 = days.slice(-7).filter((d) => table[d].qol != null).length, n0 = days.slice(-14, -7).filter((d) => table[d].qol != null).length;
    if (w1 != null && w0 != null && n1 >= 4 && n0 >= 4 && Math.abs(w1 - w0) >= 0.3) out.push({ key: `note:qol_week:${today}`, kind: "note", family: "qol", base: 0.5,
      text: `This week's QoL averages ${r1(w1)} against ${r1(w0)} last week (${n1} and ${n0} rated days).`, action: w1 > w0 ? "Look at what this week had more of; the best-day note and the hypotheses are the places it shows up." : "A lower week is worth a glance at sleep, doses and events before assuming it is the disease.", why: "Week-over-week mean of your 2-hourly ratings; the ground truth every other number is compared against.", strength: "trend", numbers: { w1: r1(w1), w0: r1(w0) }, links: [{ label: "QoL correlations", tab: "trends", section: "tr-corr" }] });
    return out;
  }

  // ---------- ranking (tiny online model over kind/family/strength, trained by votes) ----------
  async function weights(uid) { const r = await pool.query("select data->'insight_weights' as w from settings where user_id = $1", [uid]); return (r.rows[0] && r.rows[0].w) || {}; }
  const attrs = (c) => [`kind:${c.kind}`, `fam:${c.family}`, `str:${c.strength}`];
  const pred = (w, c) => { const z = attrs(c).reduce((a, k) => a + (w[k] || 0), 0); return 1 / (1 + Math.exp(-z)); };
  async function learn(uid, c, y) {
    const w = await weights(uid); const p = pred(w, c); const lr = 0.4;
    for (const k of attrs(c)) w[k] = Math.max(-3, Math.min(3, (w[k] || 0) + lr * (y - p)));
    await pool.query("update settings set data = jsonb_set(coalesce(data,'{}'::jsonb), '{insight_weights}', $2::jsonb) where user_id = $1", [uid, JSON.stringify(w)]);
  }

  async function wantCount(uid) { const r = await pool.query("select coalesce((data->>'insight_count')::int, 3) as n from settings where user_id = $1", [uid]); return Math.max(1, Math.min(8, (r.rows[0] && r.rows[0].n) || 3)); }

  // ---------- assembly ----------
  async function generate(uid) {
    const snap = await hyp.snapshot(uid);
    const table = snap.table, days = Object.keys(table).sort(), today = localDayOf(new Date());
    const cands = [];
    for (const g of [() => genToday(uid, today), () => genGoals(uid, table, days, today), () => genPatterns(snap), () => genFindings(snap), () => genNotes(uid, table, days, today)]) {
      try { cands.push(...(await g())); } catch (e) { console.error("insight generator", e.message); }
    }
    return cands;
  }

  async function current(uid) {
    const cands = await generate(uid);
    const w = await weights(uid);
    const count = await wantCount(uid);
    const now = new Date();
    // upsert candidates (text and numbers refresh in place; status untouched)
    for (const c of cands) {
      await pool.query(`insert into insights (user_id, key, kind, family, text, action, why, cite, strength, numbers, links) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        on conflict (user_id, key) do update set text = excluded.text, action = excluded.action, why = excluded.why, numbers = excluded.numbers, links = excluded.links, updated_at = now()`,
        [uid, c.key, c.kind, c.family, c.text, c.action, c.why, c.cite, c.strength, c.numbers || {}, JSON.stringify(c.links || [])]);
    }
    const keys = new Set(cands.map((c) => c.key));
    const rows = (await pool.query("select * from insights where user_id = $1", [uid])).rows;
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
    // expire shown items that are no longer generated (unless pinned); cool shown items past their run
    for (const r of rows) {
      if (r.status === "shown" && !r.pinned && !keys.has(r.key)) await pool.query("update insights set status = 'expired', updated_at = now() where id = $1", [r.id]);
      else if (r.status === "shown" && !r.pinned && r.shown_at && now - new Date(r.shown_at) > SHOW_DAYS * 86400000) await pool.query("update insights set status = 'cooled', cooled_at = now() where id = $1", [r.id]);
    }
    const score = (c) => { const r = byKey[c.key]; return c.base + 0.5 * (pred(w, c) - 0.5) + (r && r.vote > 0 ? 0.3 : 0); };
    const shown = rows.filter((r) => r.status === "shown" && (r.pinned || keys.has(r.key)) && !(r.shown_at && now - new Date(r.shown_at) > SHOW_DAYS * 86400000 && !r.pinned));
    const have = new Set(shown.map((r) => r.key));
    const eligible = cands.filter((c) => {
      if (have.has(c.key)) return false;
      const r = byKey[c.key]; if (!r) return true;
      if (r.status === "dismissed") return r.updated_at && now - new Date(r.updated_at) > DISMISS_DAYS * 86400000;
      if (r.status === "cooled") return r.cooled_at && now - new Date(r.cooled_at) > COOL_DAYS * 86400000;
      return true;
    }).sort((a, b) => score(b) - score(a));
    // diversity: at most one per family among the newly filled slots
    const famSeen = new Set(shown.map((r) => r.family).filter(Boolean)); const kindN = {}; for (const r of shown) kindN[r.kind] = (kindN[r.kind] || 0) + 1;
    const fill = []; for (const c of eligible) { if (fill.length + shown.length >= count) break; if ((c.family && famSeen.has(c.family)) || (kindN[c.kind] || 0) >= 2) continue; famSeen.add(c.family); kindN[c.kind] = (kindN[c.kind] || 0) + 1; fill.push(c); }
    for (const c of eligible) { if (fill.length + shown.length >= count) break; if (!fill.includes(c)) fill.push(c); }
    for (const c of fill) await pool.query("update insights set status = 'shown', shown_at = now(), updated_at = now() where user_id = $1 and key = $2", [uid, c.key]);
    const out = (await pool.query("select * from insights where user_id = $1 and status = 'shown' order by pinned desc, shown_at desc", [uid])).rows
      .filter((r) => r.pinned || keys.has(r.key)).slice(0, Math.max(count, rows.filter((r) => r.pinned).length));
    const order = { today: 0, goal: 1, pattern: 2, finding: 3, note: 4 };
    out.sort((a, b) => (b.pinned - a.pinned) || (order[a.kind] - order[b.kind]) || (new Date(b.shown_at) - new Date(a.shown_at)));
    return { items: out.map((r) => ({ id: r.id, key: r.key, kind: r.kind, family: r.family, text: r.text, action: r.action, why: r.why, cite: r.cite, strength: r.strength, numbers: r.numbers, links: r.links, vote: r.vote, pinned: r.pinned, shown_at: r.shown_at })), count, candidates: cands.length };
  }

  function routes(app, requireAuth) {
    app.get("/api/insights", requireAuth, async (req, res) => res.json(await current(req.user.id)));
    app.post("/api/insights/vote", requireAuth, async (req, res) => {
      const { id, vote } = req.body || {}; const uid = req.user.id;
      const r = (await pool.query("select * from insights where user_id = $1 and id = $2", [uid, id])).rows[0]; if (!r) return res.status(404).json({ error: "not found" });
      if (r.vote !== 0) return res.json(await current(uid)); // one vote per insight
      await learn(uid, r, vote > 0 ? 1 : 0);
      if (vote > 0) await pool.query("update insights set vote = 1, updated_at = now() where id = $1", [id]);
      else await pool.query("update insights set vote = -1, status = 'dismissed', pinned = false, updated_at = now() where id = $1", [id]);
      res.json(await current(uid));
    });
    app.post("/api/insights/pin", requireAuth, async (req, res) => {
      // Pinning keeps it in place; unpinning restarts its 7-day run rather than cooling it straight away.
      const { id, pinned } = req.body || {}; await pool.query("update insights set pinned = $3, status = 'shown', shown_at = now(), updated_at = now() where user_id = $1 and id = $2", [req.user.id, id, Boolean(pinned)]);
      res.json(await current(req.user.id));
    });
    app.post("/api/insights/refresh", requireAuth, async (req, res) => {
      const { id } = req.body || {}; const uid = req.user.id;
      if (id) await pool.query("update insights set status = 'cooled', cooled_at = now(), updated_at = now() where user_id = $1 and id = $2 and not pinned", [uid, id]);
      else await pool.query("update insights set status = 'cooled', cooled_at = now(), updated_at = now() where user_id = $1 and status = 'shown' and not pinned", [uid]);
      res.json(await current(uid));
    });
    app.post("/api/insights/count", requireAuth, async (req, res) => {
      const n = Math.max(1, Math.min(8, Number(req.body && req.body.count) || 3));
      await pool.query("update settings set data = jsonb_set(coalesce(data,'{}'::jsonb), '{insight_count}', to_jsonb($2::int)) where user_id = $1", [req.user.id, n]);
      res.json(await current(req.user.id));
    });
  }

  return { routes, ensureTables, current };
};
