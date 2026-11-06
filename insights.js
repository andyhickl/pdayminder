// Insights: the Home-tab carousel (Today · Goals · Patterns · Notes).
//
// Three parts, with a hard line between them:
//   1. Packets (deterministic). Generators turn the hypotheses feature table and a few direct queries into fact records:
//      category, icon, title, stage, the numbers, a citation id from the vetted table, links, and a template sentence
//      as the fallback wording. Numbers only ever come from here.
//   2. Explorer (Claude, at most once a day). Gets a digest of the feature table and proposes things worth noticing as
//      structured specs from a fixed menu (pair / cluster / compare / streak). The engine evaluates every proposal;
//      only those with a real effect become packets, at stage "noticed".
//   3. Writer (Claude, per packet, cached by a hash of the facts). Writes the observation, the telegraphic citation
//      and the action from the packet. A validator rejects any sentence whose numbers are not in the packet, or that
//      recommends a medication change; rejected prose falls back to the template.
// Without ANTHROPIC_API_KEY everything still works on the templates.
const crypto = require("crypto");

module.exports = function init({ pool, hyp, TZ, localDayOf, exerciseProfile, workoutDays, dopaDrugs, placeQol }) {
  const DISMISS_DAYS = 30, PER_CATEGORY = 3;
  const MODEL = process.env.INSIGHTS_MODEL || "claude-sonnet-5-5";
  const KEY = process.env.ANTHROPIC_API_KEY || "";
  const state = { lastError: null, lastWrite: null, lastExplore: null, model: MODEL, hasKey: Boolean(KEY) };

  async function ensureTables() {
    await pool.query(`create table if not exists insights (
      id serial primary key, user_id int not null references users(id) on delete cascade, key text not null, kind text not null, family text,
      text text not null, action text, why text, cite text, strength text, numbers jsonb, links jsonb,
      status text not null default 'candidate', vote int not null default 0, pinned boolean not null default false,
      shown_at timestamptz, cooled_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
      unique (user_id, key))`);
    await pool.query("alter table insights add column if not exists prose jsonb");
    await pool.query("alter table insights add column if not exists prose_hash text");
    await pool.query("alter table insights add column if not exists stage text");
    await pool.query(`create table if not exists insight_proposals (
      user_id int not null references users(id) on delete cascade, day date not null, specs jsonb not null, model text, created_at timestamptz not null default now(), primary key (user_id, day))`);
  }

  // ---------- citations (the only sources the writer may paraphrase) ----------
  const CITES = {
    sparx: { short: "SPARX 2018: 4 × 30 min/week at 80–85 % HRmax held UPDRS-III steady for six months; 60–65 % did not.", full: "Schenkman M et al. Effect of high-intensity treadmill exercise on motor symptoms in patients with de novo Parkinson disease: the SPARX phase 2 RCT. JAMA Neurology 2018;75:219–226." },
    pis: { short: "Park-in-Shape 2019: 30–45 min home cycling 3×/week at 50–80 % HRR improved off-state motor scores.", full: "van der Kolk NM et al. Effectiveness of home-based and remotely supervised aerobic exercise in Parkinson's disease: a double-blind RCT. Lancet Neurology 2019;18:998–1008." },
    protein: { short: "Cereda 2010 meta-analysis: protein taken with levodopa competes for transport and delays on-time; redistributing it helps.", full: "Cereda E et al. Low-protein and protein-redistribution diets for Parkinson's disease patients with motor fluctuations: a systematic review. Movement Disorders 2010;25:2021–2034." },
    caffeine: { short: "Drake 2013: 400 mg caffeine six hours before bed cost about an hour of sleep; half-life around five hours.", full: "Drake C et al. Caffeine effects on sleep taken 0, 3, or 6 hours before going to bed. J Clin Sleep Med 2013;9:1195–1200." },
    sleep: { short: "Chahine 2017 review: short, fragmented sleep worsens next-day motor and non-motor PD symptoms.", full: "Chahine LM, Amara AW, Videnovic A. A systematic review of the literature on disorders of sleep and wakefulness in Parkinson's disease from 2005 to 2015. Sleep Medicine Reviews 2017;35:33–50." },
    wearing: { short: "Wearing-off tracks the gap between doses; regular intervals smooth plasma levodopa.", full: "Stocchi F et al. Early DEtection of wEaring off in Parkinson's disease: the DEEP study. Parkinsonism Relat Disord 2014;20:204–211." },
    battery: { short: "The pre/post-dose pair is what makes the levodopa response readable; one battery shows the state, two show the change.", full: "Zhan A et al. Using smartphones and machine learning to quantify Parkinson disease severity: the mobile Parkinson disease score. JAMA Neurology 2018;75:876–880 (pre/post design as used in this app)." },
    fiber: { short: "Barichella 2016 RCT: fiber plus probiotics improved PD constipation; the regimen target is 25–30 g/day.", full: "Barichella M et al. Probiotics and prebiotic fiber for constipation associated with Parkinson disease: an RCT. Neurology 2016;87:1274–1280." },
    drift: { short: "Slow measures move over weeks, not days; half an SD against the previous month is the signal worth a look.", full: "Personal-baseline change detection as used in this app (see /bibliography, gait and voice norms)." },
    circadian: { short: "Irregular bedtimes fragment sleep and blunt next-day alertness; regularity matters as much as duration.", full: "Phillips AJK et al. Irregular sleep/wake patterns are associated with poorer academic performance and delayed circadian and sleep/wake timing. Scientific Reports 2017;7:3216." },
    creatine: { short: "Creatine 10 g/day was safe over 18 months in PD (NET-PD); the futility trial saw no slowing, so it is a strength-and-fatigue bet, not a disease-modifying one.", full: "NINDS NET-PD Investigators. A randomized, double-blind, futility clinical trial of creatine and minocycline in early Parkinson disease. Neurology 2006;66:664–671." },
    melatonin: { short: "Melatonin improved subjective sleep quality in PD trials more than it moved objective measures.", full: "Dowling GA et al. Melatonin for sleep disturbances in Parkinson's disease. Sleep Medicine 2005;6:459–466." },
    dystonia: { short: "Early-morning and end-of-dose dystonia follow the levodopa trough; timing it against the last dose is the first thing a neurologist asks.", full: "Tolosa E, Compta Y. Dystonia in Parkinson's disease. J Neurology 2006;253(Suppl 7):VII7–13." },
    steps: { short: "Daily step count tracks with slower gait and postural decline over years; sustained activity, not baseline, is what predicts course.", full: "Amara AW et al. Self-reported physical activity levels and clinical progression in early Parkinson's disease. Parkinsonism Relat Disord 2019;61:118–125." },
    hrv: { short: "Night HRV reflects autonomic recovery; in PD it also tracks autonomic involvement, so a rising trend is good news on two fronts.", full: "Alonso A et al. Heart rate variability and the risk of Parkinson disease: the ARIC study. Annals of Neurology 2015;77:877–883." },
    context: { short: "Where the day happens shapes the ratings: work and driving load the same hours levodopa is wearing thin.", full: "This app's context overlay (Overland) and per-place QoL; no external trial." },
    own: { short: "Your own history, scored day by day; the literature does not speak to this pair directly.", full: "Personal data, 2×2 contrast with a Beta(1,1) posterior (see /research)." },
  };

  // ---------- helpers ----------
  const r1 = (v) => (v == null ? null : Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 10) / 10);
  const r0 = (v) => (v == null ? null : Math.round(v));
  const mean = (a) => { const s = a.filter((v) => v != null); return s.length ? s.reduce((x, y) => x + y, 0) / s.length : null; };
  const med = hyp.med;
  const mad = (a, m) => med(a.filter((v) => v != null).map((v) => Math.abs(v - m)));
  const sd = (a) => { const s = a.filter((v) => v != null); if (s.length < 2) return 0; const m = mean(s); return Math.sqrt(s.reduce((x, v) => x + (v - m) ** 2, 0) / (s.length - 1)); };
  const fmtDay = (d) => new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
  const localHour = (ts) => { const [h, m] = new Date(ts).toLocaleTimeString("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit" }).split(":").map(Number); return h + m / 60; };
  const hm = (h) => { const hh = Math.floor(h), mm = Math.round((h - hh) * 60); return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`; };
  const hash = (o) => crypto.createHash("sha1").update(JSON.stringify(o)).digest("hex").slice(0, 16);
  const pct = (x) => (x == null ? null : Math.round(x * 100));
  const mondayOf = (d) => { const dow = (new Date(d + "T12:00:00Z").getUTCDay() + 6) % 7; return { monday: new Date(new Date(d + "T12:00:00Z").getTime() - dow * 86400000).toISOString().slice(0, 10), dow }; };
  const STAGES = ["noticed", "watching", "supported", "rule"];

  // ---------- packet generators ----------
  async function genToday(uid, today) {
    const out = [];
    const dopa = await dopaDrugs(uid);
    const doses = (await pool.query("select taken_at from med_doses where user_id = $1 and day = $2 and drug = any($3) order by taken_at", [uid, today, dopa])).rows.map((r) => { const [h, m] = String(r.taken_at).split(":").map(Number); return h + m / 60; });
    const hourly = (await pool.query(`select metric, ts, value from observations where user_id = $1 and source = 'hae' and metric in ('protein','caffeine') and (ts at time zone $2)::date = $3::date and value > 0`, [uid, TZ, today])).rows
      .map((r) => ({ metric: r.metric, h: localHour(r.ts), value: Number(r.value) }));
    for (const p of hourly.filter((x) => x.metric === "protein" && x.value >= 15)) {
      const d = doses.find((t) => p.h + 1 > t && p.h < t + 1);
      if (d != null) out.push({ key: `today:protein:${today}:${Math.round(p.h)}`, category: "today", icon: "fork", title: "Protein near levodopa", tag: `${hm(d)} dose`, stage: "noticed", family: "nutrition", base: 1.0, cite: "protein",
        facts: { protein_g: r0(p.value), meal_hour: hm(p.h), dose_time: hm(d), minutes_after: Math.max(0, r0((p.h - d) * 60)) },
        template: { text: `${r0(p.value)} g of protein in the ${hm(p.h)} hour, right after the ${hm(d)} Sinemet.`, action: "Next time take the dose 30–60 min before the meal, or keep that meal lighter on protein and move it to the evening." },
        links: [{ label: "Today", day: today }] });
    }
    const lateCaf = hourly.filter((x) => x.metric === "caffeine" && x.h >= 14 && x.value >= 40);
    if (lateCaf.length) { const tot = lateCaf.reduce((a, x) => a + x.value, 0); out.push({ key: `today:caffeine:${today}`, category: "today", icon: "cup", title: "Late caffeine", tag: lateCaf.map((x) => hm(x.h)).join(", "), stage: "noticed", family: "nutrition", base: 0.9, cite: "caffeine",
      facts: { caffeine_mg: r0(tot), times: lateCaf.map((x) => hm(x.h)), hours_to_bedtime: r1(22.5 - lateCaf[lateCaf.length - 1].h) },
      template: { text: `${r0(tot)} mg of caffeine after 14:00 today (${lateCaf.map((x) => hm(x.h)).join(", ")}).`, action: "With a ~5 h half-life, a third of it is still on board at 22:00; keep caffeine to the morning if sleep onset matters tonight." }, links: [{ label: "Today", day: today }] }); }
    const nowH = localHour(new Date());
    const s = (await pool.query("select data from settings where user_id = $1", [uid])).rows[0];
    const expected = ((s && s.data && s.data.medications) || []).filter((m) => m.dopaminergic).reduce((a, m) => a + ((m.times || []).length || 0), 0) || 3;
    if (doses.length && doses.length < expected && nowH - doses[doses.length - 1] > 5 && nowH < 22) { const gap = r1(nowH - doses[doses.length - 1]); out.push({ key: `today:gap:${today}:${doses.length}`, category: "today", icon: "pill", title: "Long gap since the last dose", tag: `${hm(doses[doses.length - 1])} dose`, stage: "noticed", family: "doses", base: 0.95, cite: "wearing",
      facts: { hours_since: gap, last_dose: hm(doses[doses.length - 1]), taken: doses.length, expected },
      template: { text: `${gap} h since the ${hm(doses[doses.length - 1])} dose, with ${expected - doses.length} of today's ${expected} still to come.`, action: "If you are past the plan, log the next dose when you take it; the ring and the post-dose battery both key off it." }, links: [{ label: "Today", day: today }] }); }
    // events today vs last dose
    const ev = (await pool.query(`select ts, value, raw from observations where user_id = $1 and source = 'event' and metric = 'event' and (ts at time zone $2)::date = $3::date order by ts`, [uid, TZ, today])).rows;
    for (const e of ev) { const h = localHour(e.ts); const prev = doses.filter((t) => t <= h).pop(); if (prev == null) continue; const since = r1(h - prev); if (since >= 3) out.push({ key: `today:event:${today}:${Math.round(h * 4)}`, category: "today", icon: "flag", title: `${(e.raw && e.raw.type) || "Event"} ${since} h after the dose`, tag: hm(h), stage: "noticed", family: "events", base: 0.85, cite: (e.raw && e.raw.type) === "dystonia" ? "dystonia" : "wearing",
      facts: { event_type: (e.raw && e.raw.type) || "event", event_time: hm(h), last_dose: hm(prev), hours_after_dose: since, minutes: e.value == null ? null : r0(e.value), severity: e.raw && e.raw.severity },
      template: { text: `${(e.raw && e.raw.type) || "An event"} at ${hm(h)}, ${since} h after the ${hm(prev)} dose${e.value ? `, lasting ${r0(e.value)} min` : ""}.`, action: "That timing is the end-of-dose window; worth telling your neurologist the hours, not just the symptom." }, links: [{ label: "Today", day: today }] }); }
    return out;
  }

  async function genGoals(uid, table, days, today) {
    const out = [];
    const prof = await exerciseProfile(uid);
    const byDay = await workoutDays(uid, 14);
    const { monday, dow } = mondayOf(today);
    let vig = 0, sessions = 0; for (const [d, x] of Object.entries(byDay)) if (d >= monday && d <= today) { vig += x.workout_vigorous; sessions += x.workouts_count; }
    const target = prof.weeklyVigorousMin || 120, left = 6 - dow;
    if (Object.keys(byDay).length) {
      if (vig < target) { const gap = target - vig; out.push({ key: `goal:vigorous:${monday}`, category: "goals", icon: "run", title: "Vigorous minutes", tag: left === 0 ? "today left" : `${left} day${left === 1 ? "" : "s"} left`, stage: "rule", family: "exercise", base: 0.9, cite: "sparx", bar: { value: vig, max: target, left: `${vig} min`, right: `${target} min` },
        facts: { vigorous_min: vig, target, gap, sessions, days_left: left, vigorous_bpm: prof.vigorousBpm, sessions_needed: Math.ceil(gap / 30) },
        template: { text: `${vig} of ${target} vigorous minutes this week, ${sessions} session${sessions === 1 ? "" : "s"}.`, action: gap <= 35 ? `One 30-minute row holding ≥${prof.vigorousBpm} bpm covers it.` : `${Math.ceil(gap / 30)} rows of 30 minutes at ≥${prof.vigorousBpm} bpm gets there.` }, links: [{ label: "Exercise dose", tab: "stats", section: "st-exercise" }] }); }
      else out.push({ key: `goal:vigorous:${monday}`, category: "goals", icon: "run", title: "Vigorous minutes", tag: "met", stage: "rule", family: "exercise", base: 0.6, cite: "sparx", bar: { value: vig, max: target, left: `${vig} min`, right: `${target} min` }, facts: { vigorous_min: vig, target, sessions }, template: { text: `${vig} vigorous minutes this week: the SPARX dose is met.`, action: "Keep the rhythm; the trial effect took six months of it." }, links: [{ label: "Workouts", tab: "trends", section: "tr-workouts" }] });
    }
    const last7 = days.slice(-7);
    const bat = days.filter((d) => d >= monday && d <= today).map((d) => table[d].batteries || 0);
    const batDays = bat.filter((b) => b >= 2).length, elapsed = dow + 1;
    if (elapsed >= 2) out.push({ key: `goal:batteries:${monday}`, category: "goals", icon: "pill", title: "Battery pairs", tag: `Mon–${["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][dow]}`, stage: "rule", family: "doses", base: batDays < elapsed - 1 ? 0.7 : 0.4, cite: "battery", bar: { value: batDays, max: elapsed, left: `${batDays} day${batDays === 1 ? "" : "s"}`, right: `${elapsed} days` },
      facts: { days_with_both: batDays, days_elapsed: elapsed }, template: { text: `${batDays} of ${elapsed} days this week had both the pre- and post-dose battery.`, action: "Post-dose opens 45 min after the next Sinemet; the pair is the measurement." }, links: [{ label: "Run tests", tab: "qol", section: "qol-tests" }] });
    const sl = mean(last7.map((d) => table[d].sleep_h)); const slN = last7.filter((d) => table[d].sleep_h != null).length;
    if (sl != null && slN >= 4) out.push({ key: "goal:sleep", category: "goals", icon: "moon", title: "Sleep", tag: `last ${slN} nights`, stage: "rule", family: "sleep", base: sl < 6.8 ? 0.75 : 0.35, cite: "sleep", bar: { value: Math.min(sl, 7), max: 7, left: `${r1(sl)} h`, right: "7 h" },
      facts: { mean_sleep_h: r1(sl), nights: slN, target_h: 7, lights_out: "22:30", rise: "06:00" }, template: { text: `Sleep averaged ${r1(sl)} h over the last ${slN} nights.`, action: sl < 6.8 ? "Aim for 7 h: lights out by 22:30 on a 06:00 rise; the 21:00 melatonin already helps." : "Holding at the target; keep the bedtime where it is." }, links: [{ label: "Vitals", tab: "trends", section: "tr-vitals" }] });
    const pnd = mean(last7.map((d) => table[d].protein_near_dose)); const pndDays = last7.filter((d) => table[d].protein_near_dose != null).length;
    if (pnd != null && pndDays >= 3) out.push({ key: "goal:protein_near_dose", category: "goals", icon: "fork", title: "Protein near doses", tag: `last ${pndDays} days`, stage: "rule", family: "nutrition", base: pnd >= 15 ? 0.75 : 0.3, cite: "protein", bar: { value: Math.max(0, 30 - pnd), max: 30, left: `${r0(pnd)} g near doses`, right: "aim < 10 g" },
      facts: { protein_near_dose_g: r0(pnd), days: pndDays, target_g: 10 }, template: { text: `${r0(pnd)} g of protein a day landed within 90 minutes of a levodopa dose over the last ${pndDays} logged days.`, action: pnd >= 15 ? "Keep the dose where it is and move the protein: Sinemet 30–60 min before a protein-heavy meal, or shift the protein to the evening." : "Well separated; keep it that way." }, links: [{ label: "Nutrition", tab: "trends", section: "tr-nutrition" }] });
    const gaps = last7.filter((d) => table[d].dose_gap_max != null && table[d].doses >= 2); const longGaps = gaps.filter((d) => table[d].dose_gap_max > 6);
    if (gaps.length >= 3 && longGaps.length >= 2) out.push({ key: "goal:dose_gap", category: "goals", icon: "clock", title: "Dose spacing", tag: `last ${gaps.length} days`, stage: "rule", family: "doses", base: 0.65, cite: "wearing", bar: { value: gaps.length - longGaps.length, max: gaps.length, left: `${gaps.length - longGaps.length} days under 6 h`, right: `${gaps.length} days` },
      facts: { long_gap_days: longGaps.length, days: gaps.length, example_days: longGaps.map(fmtDay), threshold_h: 6 }, template: { text: `The longest gap between doses passed 6 h on ${longGaps.length} of the last ${gaps.length} multi-dose days.`, action: "If those afternoons felt flat, that is wearing-off; tell your neurologist the gap, not just the feeling." }, links: longGaps.map((d) => ({ label: fmtDay(d), day: d })) });
    const fb = mean(last7.map((d) => table[d].fiber)); const fbN = last7.filter((d) => table[d].fiber != null).length;
    if (fb != null && fbN >= 3) out.push({ key: "goal:fiber", category: "goals", icon: "leaf", title: "Fiber", tag: `last ${fbN} days`, stage: "rule", family: "nutrition", base: fb < 20 ? 0.5 : 0.25, cite: "fiber", bar: { value: Math.min(fb, 28), max: 28, left: `${r0(fb)} g`, right: "25–30 g" },
      facts: { fiber_g: r0(fb), days: fbN, target: "25–30 g" }, template: { text: `Fiber averaged ${r0(fb)} g/day over ${fbN} logged days.`, action: fb < 20 ? "The psyllium covers 5–10 g; beans or oats and two fruits close the rest." : "On target." }, links: [{ label: "Nutrition", tab: "trends", section: "tr-nutrition" }] });
    // supplement adherence this week
    const supp = (await pool.query(`select drug, count(distinct day)::int as n from med_doses where user_id = $1 and source = 'supplement' and day >= $2::date and day <= $3::date group by drug`, [uid, monday, today])).rows;
    const s = (await pool.query("select data from settings where user_id = $1", [uid])).rows[0];
    const supps = ((s && s.data && s.data.supplements) || []).filter((x) => x.id || x.name);
    if (supps.length && elapsed >= 2) { const taken = Object.fromEntries(supp.map((r) => [r.drug, r.n])); const missed = supps.map((x) => ({ name: x.name || x.id, n: taken[x.id] || taken[x.name] || 0 })).filter((x) => x.n < elapsed - 1); const total = supps.reduce((a, x) => a + (taken[x.id] || taken[x.name] || 0), 0);
      out.push({ key: `goal:supps:${monday}`, category: "goals", icon: "pill", title: "Supplement stack", tag: `${supps.length} items`, stage: "rule", family: "supplements", base: missed.length ? 0.5 : 0.25, cite: "creatine", bar: { value: total, max: supps.length * elapsed, left: `${total} logged`, right: `${supps.length * elapsed} slots` },
        facts: { logged: total, slots: supps.length * elapsed, missed: missed.map((m) => `${m.name} ${m.n}/${elapsed}`) }, template: { text: `${total} of ${supps.length * elapsed} supplement slots logged this week${missed.length ? ` (behind: ${missed.map((m) => m.name).join(", ")})` : ""}.`, action: missed.length ? "Creatine and vitamin D only work as daily habits; park them next to the morning Sinemet." : "Full stack this week." }, links: [{ label: "Supplements", tab: "trends", section: "tr-supps" }] }); }
    return out;
  }

  function patternPacket(h, kind) {
    // kind: active (watching) | finding (supported) | lead/proposed (noticed)
    const nE = h.twoByTwo ? h.twoByTwo.withExposure.yes + h.twoByTwo.withExposure.no : h.nE, nC = h.twoByTwo ? h.twoByTwo.without.yes + h.twoByTwo.without.no : h.nC;
    const stage = kind === "finding" ? "supported" : kind === "active" ? "watching" : "noticed";
    const days = (h.days || []).filter((d) => d.verdict !== "na");
    return { key: `${kind === "active" ? "pattern" : kind === "finding" ? "finding" : "lead"}:${h.id}`, category: "patterns", icon: FAM_ICON[h.families ? h.families[0] : (h.spec && hyp.FK[h.spec.x] && hyp.FK[h.spec.x].fam)] || "flask", title: h.exposure && h.outcome ? `${cap(h.exposure)} → ${h.outcome}` : "From your history",
      tag: kind === "active" ? `day ${h.dayIndex} of ${h.period}` : kind === "finding" ? `held ${h.dayIndex} days` : "from history", stage, family: h.families ? h.families[0] : null, base: kind === "finding" ? 0.6 : kind === "active" ? 0.5 + 0.3 * Math.max(0, (h.posterior || 0) - 0.5) : 0.4, cite: h.cite || "own",
      dots: days.map((d) => d.verdict), posterior: pct(h.posterior), hid: h.id, kind,
      facts: { claim: h.text, rate_with: pct(h.rateWith), rate_without: pct(h.rateWithout), days_with: nE, days_without: nC, posterior_pct: pct(h.posterior), as_predicted: h.support ?? days.filter((d) => d.verdict === "support").length, not_as_predicted: h.against ?? days.filter((d) => d.verdict === "against").length, controllable: Boolean(h.controllable), day_index: h.dayIndex, period: h.period },
      days: days.map((d) => ({ day: d.day, verdict: d.verdict, x: d.xValue, y: d.yValue })),
      template: { text: h.rateWith == null || h.rateWithout == null ? `${h.text.replace(/\.$/, "")}. Day ${h.dayIndex} of ${h.period}; ${nE + nC} scorable day${nE + nC === 1 ? "" : "s"} so far${nE && !nC ? " (none yet without the condition)" : !nE && nC ? " (none yet with the condition)" : ""}.` : `${h.text.replace(/\.$/, "")}: ${pct(h.rateWith)} % of days vs ${pct(h.rateWithout)} % (${nE} vs ${nC} days).`, action: kind === "finding" ? "Treat it as a rule for now; it stays scored every day and will say if it stops holding." : kind === "active" ? (h.controllable ? `In your hands: set the "${h.exposure}" side this week and watch.` : "Not something to steer, but worth knowing when you plan the day.") : "Not tested forward yet; 👍 or pin it to start watching it day by day." },
      why: h.rationale, links: [{ label: "show the days", days: true }] };
  }
  const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
  const FAM_ICON = { sleep: "moon", hrv: "heart", activity: "walk", exercise: "run", gait: "walk", nutrition: "fork", supplements: "pill", doses: "pill", context: "map", events: "flag", qol: "star", tremor: "wave", tapping: "hand", balance: "scale", voice: "mic" };
  const FAM_CITE = { exercise: "sparx", activity: "steps", sleep: "sleep", nutrition: "protein", doses: "wearing", events: "dystonia", hrv: "hrv", context: "context", supplements: "creatine" };

  function genPatterns(snap) {
    const out = [];
    for (const h of snap.active || []) if (h.twoByTwo) out.push(patternPacket({ ...h, cite: FAM_CITE[h.families[0]] || "own" }, "active"));
    for (const f of snap.findings || []) out.push(patternPacket({ ...f, cite: FAM_CITE[f.families[0]] || "own" }, "finding"));
    for (const g of (snap.generatorFindings || []).filter((g) => !g.weakened).sort((a, b) => (b.posterior || 0) - (a.posterior || 0)).slice(0, 4)) {
      const x = hyp.FK[g.spec.x], y = hyp.FK[g.spec.y];
      out.push(patternPacket({ ...g, exposure: x.label, outcome: y.label, families: [x.fam, y.fam], controllable: x.ctrl, cite: FAM_CITE[x.fam] || "own", dayIndex: g.nE + g.nC }, "lead"));
    }
    return out;
  }

  async function genNotes(uid, table, days, today) {
    const out = [];
    const FK = hyp.FK; const last30 = days.slice(-30);
    const rated = last30.filter((d) => table[d].qol != null);
    if (rated.length >= 7) {
      const best = rated.reduce((a, d) => (table[d].qol > table[a].qol ? d : a), rated[0]);
      const diffs = [];
      for (const f of hyp.F) { if (f.kind === "outcome" || !f.ctrl) continue; const v = table[best][f.key]; if (v == null) continue; const vals = last30.map((d) => table[d][f.key]).filter((x) => x != null); if (vals.length < 7) continue; const m = med(vals), s = mad(vals, m) || 0; if (!s) continue; const z = (v - m) / (1.4826 * s); if (Math.abs(z) >= 1.5) diffs.push({ f, v, m, z }); }
      diffs.sort((a, b) => Math.abs(b.z) - Math.abs(a.z));
      const top = diffs.slice(0, 3);
      if (top.length) out.push({ key: `note:best:${best}`, category: "notes", icon: "star", title: "Best day in 30", tag: fmtDay(best), stage: "noticed", family: top[0].f.fam, base: 0.6, cite: FAM_CITE[top[0].f.fam] || "own",
        facts: { day: fmtDay(best), qol: r1(table[best].qol), differences: top.map((x) => ({ what: x.f.label, value: r1(x.v), unit: x.f.unit, usual: r1(x.m) })) },
        template: { text: `${fmtDay(best)} was your best day in the last 30 (QoL ${r1(table[best].qol)}). What was different: ${top.map((x) => `${x.f.label} ${r1(x.v)}${x.f.unit ? " " + x.f.unit : ""} (usually ${r1(x.m)})`).join("; ")}.`, action: "One day proves nothing, but it is a cheap experiment to repeat." }, links: [{ label: fmtDay(best), day: best }] });
    }
    const streak = (pred) => { let n = 0; for (let i = days.length - 1; i >= 0; i--) { if (pred(table[days[i]])) n++; else break; } return n; };
    const sW = streak((t) => (t.workout_min || 0) >= 20); if (sW >= 3) out.push({ key: `note:streak:workout:${sW}`, category: "notes", icon: "run", title: "Workout streak", tag: `${sW} days`, stage: "noticed", family: "exercise", base: 0.5, cite: "pis", facts: { streak_days: sW }, template: { text: `${sW} days running with a workout of 20 minutes or more.`, action: "Streaks are the adherence the trials needed; protect tomorrow's slot." }, links: [{ label: "Workouts", tab: "trends", section: "tr-workouts" }] });
    const sB = streak((t) => (t.batteries || 0) >= 2); if (sB >= 3) out.push({ key: `note:streak:batteries:${sB}`, category: "notes", icon: "pill", title: "Battery streak", tag: `${sB} days`, stage: "noticed", family: "doses", base: 0.45, cite: "battery", facts: { streak_days: sB }, template: { text: `${sB} days in a row with both batteries run.`, action: "Enough to start seeing your own levodopa response in the tapping and tremor deltas." }, links: [{ label: "Motor tests", tab: "trends", section: "tr-motor" }] });
    const wd = await workoutDays(uid, 90); const wdays = Object.keys(wd).sort();
    if (wdays.length >= 3) { const bestV = wdays.reduce((a, d) => (wd[d].workout_vigorous > wd[a].workout_vigorous ? d : a), wdays[0]); if (bestV >= days[days.length - 2] && wd[bestV].workout_vigorous > 0) out.push({ key: `note:pb:vigorous:${bestV}`, category: "notes", icon: "run", title: "Most vigorous day in 90", tag: fmtDay(bestV), stage: "noticed", family: "exercise", base: 0.5, cite: "sparx", facts: { day: fmtDay(bestV), vigorous_min: wd[bestV].workout_vigorous, sparx_session_min: 30 }, template: { text: `${fmtDay(bestV)} was your most vigorous day in 90: ${wd[bestV].workout_vigorous} minutes in zone.`, action: "A 30-minute block in zone is the SPARX session; you are close." }, links: [{ label: fmtDay(bestV), day: bestV }] }); }
    for (const key of ["walk_speed", "tap_rate", "ddk", "hrv", "dbl_support", "steps", "resting_hr"]) {
      const f = FK[key]; const rec = days.slice(-14).map((d) => table[d][key]).filter((v) => v != null); const prev = days.slice(-42, -14).map((d) => table[d][key]).filter((v) => v != null);
      if (rec.length < 5 || prev.length < 8) continue;
      const m1 = mean(rec), m0 = mean(prev); const s = sd(prev); if (!s) continue; const z = (m1 - m0) / s; if (Math.abs(z) < 0.5) continue;
      const better = f.better === 0 ? null : (z > 0) === (f.better > 0);
      out.push({ key: `note:drift:${key}:${today.slice(0, 7)}`, category: "notes", icon: FAM_ICON[f.fam] || "chart", title: `${cap(f.label)} drift`, tag: "2 wk vs 4 wk", stage: "noticed", family: f.fam, base: better === false ? 0.7 : 0.45, cite: key === "hrv" ? "hrv" : key === "steps" ? "steps" : "drift",
        facts: { measure: f.label, unit: f.unit, last_2_weeks: r1(m1), previous_4_weeks: r1(m0), sd_change: r1(Math.abs(z)), direction: better === false ? "worse" : better ? "better" : "different" },
        template: { text: `${cap(f.label)} over the last two weeks averages ${r1(m1)}${f.unit ? " " + f.unit : ""}, ${better === false ? "worse" : better ? "better" : "different"} than the previous four weeks (${r1(m0)}) by ${r1(Math.abs(z))} SD.`, action: better === false ? "Slow drift is what a neurologist visit should hear about, with the number attached." : "A real shift in the right direction; keep whatever changed." }, links: [{ label: "Trends", tab: "trends", section: f.fam === "hrv" || key === "steps" || key === "resting_hr" ? "tr-vitals" : "tr-motor" }] });
    }
    const w1 = mean(days.slice(-7).map((d) => table[d].qol)), w0 = mean(days.slice(-14, -7).map((d) => table[d].qol));
    const n1 = days.slice(-7).filter((d) => table[d].qol != null).length, n0 = days.slice(-14, -7).filter((d) => table[d].qol != null).length;
    if (w1 != null && w0 != null && n1 >= 4 && n0 >= 4 && Math.abs(w1 - w0) >= 0.25) out.push({ key: `note:qol_week:${mondayOf(today).monday}`, category: "notes", icon: "star", title: "Week over week", tag: `${n1} and ${n0} rated days`, stage: "noticed", family: "qol", base: 0.5, cite: "own", facts: { this_week: r1(w1), last_week: r1(w0), rated_days: [n1, n0] }, template: { text: `This week's QoL averages ${r1(w1)} against ${r1(w0)} last week.`, action: w1 > w0 ? "Look at what this week had more of; the best-day note is where it shows up." : "A lower week is worth a glance at sleep, doses and events before assuming it is the disease." }, links: [{ label: "QoL correlations", tab: "trends", section: "tr-corr" }] });
    // QoL by place (last 30 days of context)
    const pq = (await pool.query(`select raw->>'place' as place, count(*)::int as n from observations where user_id = $1 and source = 'context' and metric = 'place' and ts > now() - interval '30 days' group by 1`, [uid])).rows;
    if (pq.length >= 2) { const qol = await fetchPlaceQol(uid); if (qol && qol.home != null && qol.work != null && Math.abs(qol.home - qol.work) >= 0.3) out.push({ key: `note:place:${today.slice(0, 7)}`, category: "notes", icon: "map", title: "Home vs work", tag: "last 30 days", stage: "noticed", family: "context", base: 0.5, cite: "context", facts: { qol_home: r1(qol.home), qol_work: r1(qol.work) }, template: { text: `Blocks at home average QoL ${r1(qol.home)}; blocks at work ${r1(qol.work)}.`, action: qol.work < qol.home ? "Work hours overlap the midday trough; a protein-light lunch and the dose on time are the two levers there." : "Work days rate higher; the structure may be doing you a favour." }, links: [{ label: "Location", tab: "stats", section: "st-location" }] }); }
    // dystonia / event clustering by hour (30 d)
    const evh = (await pool.query(`select extract(hour from ts at time zone $2)::int as h, raw->>'type' as type, count(*)::int as n from observations where user_id = $1 and source = 'event' and metric = 'event' and ts > now() - interval '30 days' group by 1, 2`, [uid, TZ])).rows;
    const tot = evh.reduce((a, r) => a + r.n, 0);
    if (tot >= 4) { const byH = {}; for (const r of evh) byH[r.h] = (byH[r.h] || 0) + r.n; let bestH = null, bestN = 0; for (let h = 0; h < 24; h++) { const n = (byH[h] || 0) + (byH[h + 1] || 0) + (byH[h + 2] || 0); if (n > bestN) { bestN = n; bestH = h; } } if (bestN / tot >= 0.5) out.push({ key: `note:eventcluster:${today.slice(0, 7)}`, category: "notes", icon: "flag", title: "When events cluster", tag: `${tot} events, 30 days`, stage: "noticed", family: "events", base: 0.65, cite: "dystonia", facts: { events: tot, window: `${hm(bestH)}–${hm(bestH + 3)}`, share_pct: pct(bestN / tot) }, template: { text: `${pct(bestN / tot)} % of the last 30 days' ${tot} events fall between ${hm(bestH)} and ${hm(bestH + 3)}.`, action: "Line that window up against the dose before it; a consistent gap is the clearest thing you can bring to the neurologist." }, links: [{ label: "Event timing", tab: "trends", section: "tr-events" }] }); }
    return out;
  }
  async function fetchPlaceQol(uid) {
    try { const rows = await placeQol(uid, 30); const out = {}; for (const r of rows) if (r.qol != null && r.rated_minutes >= 600) out[r.place] = r.qol; return out; } catch { return null; }
  }

  // ---------- explorer (Claude proposes specs; the engine judges them) ----------
  function digest(uid, snap, table, days) {
    const last7 = days.slice(-7), last30 = days.slice(-30);
    const feats = hyp.F.map((f) => { const all = last30.map((d) => table[d][f.key]).filter((v) => v != null); if (all.length < 5) return null; return { key: f.key, label: f.label, unit: f.unit, family: f.fam, controllable: f.ctrl, kind: f.kind, better: f.better, n30: all.length, median30: r1(med(all)), mean7: r1(mean(last7.map((d) => table[d][f.key]))), today: r1(table[days[days.length - 1]] && table[days[days.length - 1]][f.key]) }; }).filter(Boolean);
    return { today: days[days.length - 1], features: feats, active: (snap.active || []).map((h) => ({ id: h.id, text: h.text, posterior: pct(h.posterior), days: h.dayIndex })), retired: (snap.history || []).slice(0, 10).map((h) => h.text), leads: (snap.generatorFindings || []).map((g) => g.text) };
  }
  async function explore(uid, snap, table, days, today, force) {
    if (!KEY) return [];
    const have = (await pool.query("select specs from insight_proposals where user_id = $1 and day = $2", [uid, today])).rows[0];
    if (have && !force) return have.specs;
    const d = digest(uid, snap, table, days);
    const dismissed = (await pool.query("select key from insights where user_id = $1 and status = 'dismissed' and updated_at > now() - interval '30 days'", [uid])).rows.map((r) => r.key);
    const sys = `You are the pattern explorer for a personal Parkinson's tracking app. The user has early-onset PD, takes levodopa (Sinemet) and rasagiline, rows on a Concept2, and rates quality of life (QoL, 1–5, 5 best) every two hours. You get a digest of ~60 daily features (30-day medians, 7-day means, today's values) and the hypotheses already under test. Propose up to 10 things worth noticing that are NOT already active or retired, each as JSON from this menu:
- {"type":"pair","x":<feature key>,"xdir":"above"|"below","thr":"median"|<number>,"y":<feature key>,"ydir":"up"|"down","lag":0|1,"why":<one sentence on the mechanism, naming the literature if any>}  (x must be an exposure or both; y an outcome or both; lag 1 means next day)
- {"type":"streak","x":<feature key>,"xdir":"above"|"below","thr":"median"|<number>,"why":...}  (a run of consecutive days)
- {"type":"compare","x":<feature key>,"split":"2026-MM-DD","why":...}  (mean before vs after a date, for a change you suspect)
Prefer controllable exposures, mechanisms with literature behind them, and pairs the user can act on. Never propose anything about changing medication dose or timing. Return only a JSON array.`;
    const user = `Digest:\n${JSON.stringify(d)}\nRecently dismissed insight keys (avoid these subjects): ${JSON.stringify(dismissed)}`;
    try {
      const txt = await claude(sys, user, 3000);
      const arr = parseArray(txt);
      const specs = arr.filter((p) => p && typeof p === "object" && ["pair", "streak", "compare"].includes(p.type) && hyp.FK[p.x]).slice(0, 10);
      await pool.query("insert into insight_proposals (user_id, day, specs, model) values ($1,$2,$3,$4) on conflict (user_id, day) do update set specs = excluded.specs, model = excluded.model, created_at = now()", [uid, today, JSON.stringify(specs), MODEL]);
      state.lastExplore = { at: new Date().toISOString(), proposals: specs.length };
      return specs;
    } catch (e) { state.lastError = `explore: ${e.message}`; console.error("insights explore", e.message); return []; }
  }
  function evaluateProposals(specs, snap, table, days) {
    const out = [];
    const refs = snap.refs;
    for (const p of specs) {
      try {
        if (p.type === "pair") {
          const x = hyp.FK[p.x], y = hyp.FK[p.y]; if (!x || !y) continue;
          const spec = { x: p.x, xdir: p.xdir === "below" ? "below" : "above", thr: typeof p.thr === "number" ? { type: "lit", value: p.thr } : { type: "median" }, y: p.y, ydir: p.ydir === "down" ? "down" : "up", lag: p.lag ? 1 : 0 };
          const sc = hyp.score(spec, table, refs, days.slice(-45));
          if (sc.nE < 4 || sc.nC < 4 || sc.post == null || sc.post < 0.8) continue;
          const id = "x" + hash(spec);
          out.push(patternPacket({ id, text: hyp.describe(spec, refs), rationale: p.why || hyp.rationale(spec), spec, exposure: x.label, outcome: y.label, families: [x.fam, y.fam], controllable: x.ctrl, rateWith: sc.rE, rateWithout: sc.rC, posterior: sc.post, nE: sc.nE, nC: sc.nC, days: sc.perDay, dayIndex: sc.scored, cite: FAM_CITE[x.fam] || "own", proposed: true }, "lead"));
          out[out.length - 1].spec = spec; out[out.length - 1].key = `proposal:${id}`; out[out.length - 1].tag = "proposed";
        } else if (p.type === "streak") {
          const x = hyp.FK[p.x]; if (!x) continue; const t = typeof p.thr === "number" ? p.thr : refs.med[p.x]; if (t == null) continue;
          let n = 0; for (let i = days.length - 1; i >= 0; i--) { const v = table[days[i]][p.x]; if (v == null) break; if (p.xdir === "below" ? v < t : v > t) n++; else break; }
          if (n < 3) continue;
          out.push({ key: `proposal:streak:${p.x}:${p.xdir}:${n}`, category: "notes", icon: FAM_ICON[x.fam] || "chart", title: `${cap(x.label)} streak`, tag: `${n} days`, stage: "noticed", family: x.fam, base: 0.5, cite: FAM_CITE[x.fam] || "own", why: p.why, facts: { measure: x.label, days: n, direction: p.xdir, threshold: r1(t), unit: x.unit }, template: { text: `${n} days running with ${x.label} ${p.xdir === "below" ? "below" : "above"} ${r1(t)}${x.unit ? " " + x.unit : ""}.`, action: x.ctrl ? "Worth noticing because you set it; keep it or break it on purpose." : "Worth a look at what else changed over the same days." }, links: [{ label: "Trends", tab: "trends", section: "tr-vitals" }] });
        } else if (p.type === "compare") {
          const x = hyp.FK[p.x]; if (!x || !/^\d{4}-\d{2}-\d{2}$/.test(String(p.split))) continue;
          const before = days.filter((d) => d < p.split).map((d) => table[d][p.x]).filter((v) => v != null), after = days.filter((d) => d >= p.split).map((d) => table[d][p.x]).filter((v) => v != null);
          if (before.length < 5 || after.length < 4) continue; const s = sd(before); if (!s) continue; const z = (mean(after) - mean(before)) / s; if (Math.abs(z) < 0.6) continue;
          out.push({ key: `proposal:compare:${p.x}:${p.split}`, category: "notes", icon: FAM_ICON[x.fam] || "chart", title: `${cap(x.label)} since ${fmtDay(p.split)}`, tag: `${after.length} days`, stage: "noticed", family: x.fam, base: 0.55, cite: FAM_CITE[x.fam] || "own", why: p.why, facts: { measure: x.label, unit: x.unit, before: r1(mean(before)), after: r1(mean(after)), split: fmtDay(p.split), sd_change: r1(Math.abs(z)) }, template: { text: `${cap(x.label)} averages ${r1(mean(after))}${x.unit ? " " + x.unit : ""} since ${fmtDay(p.split)}, against ${r1(mean(before))} before (${r1(Math.abs(z))} SD).`, action: "If something changed on that date, this is its footprint." }, links: [{ label: "Trends", tab: "trends", section: "tr-vitals" }] });
        }
      } catch (e) { console.error("proposal eval", e.message); }
    }
    return out;
  }

  // ---------- writer ----------
  async function claude(system, user, maxTokens) {
    const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "content-type": "application/json", "x-api-key": KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: MODEL, max_tokens: maxTokens || 1500, system, messages: [{ role: "user", content: user }] }) });
    const j = await r.json();
    if (!r.ok) throw new Error(`${r.status} ${(j.error && j.error.message) || JSON.stringify(j).slice(0, 200)}`);
    return (j.content || []).map((c) => c.text || "").join("");
  }
  const numbersIn = (s) => (String(s).match(/\d+(?:[.,:]\d+)?/g) || []).map((x) => x.replace(",", ""));
  function allowedNumbers(p) {
    const set = new Set();
    const walk = (v) => { if (v == null) return; if (typeof v === "number") { set.add(String(v)); set.add(String(Math.round(v))); set.add(String(Math.round(v * 10) / 10)); if (Math.abs(v) >= 1000) set.add(Math.round(v).toLocaleString("en-US")); } else if (typeof v === "string") numbersIn(v).forEach((n) => set.add(n)); else if (Array.isArray(v)) v.forEach(walk); else if (typeof v === "object") Object.values(v).forEach(walk); };
    walk(p.facts); walk(p.template); walk(p.bar); walk(p.tag); walk(p.title); numbersIn(CITES[p.cite] ? CITES[p.cite].short : "").forEach((n) => set.add(n));
    ["1", "2", "3", "4", "5", "6", "7", "10", "14", "15", "20", "30", "45", "60", "90", "100"].forEach((n) => set.add(n));
    return set;
  }
  const MED_RE = /\b(increase|decrease|double|halve|skip|stop|add|extra|raise|lower|reduce|more|fewer|another)\b[^.]{0,40}\b(dose|sinemet|levodopa|rasagiline|tablet|pill)s?\b|\b(dose|sinemet|levodopa|rasagiline)s?\b[^.]{0,40}\b(increase|decrease|double|halve|skip|stop|extra|raise|lower|reduce)\b/i;
  function validate(p, w) {
    if (!w || typeof w.text !== "string" || typeof w.action !== "string") return "shape";
    const ok = allowedNumbers(p); const bad = [...numbersIn(w.text), ...numbersIn(w.action), ...numbersIn(w.cite_text || "")].filter((n) => !ok.has(n) && !ok.has(n.replace(/\.0$/, "")));
    if (bad.length) return `numbers ${bad.join(",")}`;
    if (MED_RE.test(w.text) || MED_RE.test(w.action)) return "medication";
    if (w.text.length > 230 || w.action.length > 180 || (w.cite_text || "").length > 180) return "length";
    if (/no study|general (physiology )?note|citation/i.test(w.cite_text || "")) return "meta";
    return null;
  }
  const parseArray = (txt) => { const t = String(txt).replace(/```(?:json)?/g, ""); const i = t.indexOf("["), j = t.lastIndexOf("]"); if (i < 0 || j <= i) throw new Error("no JSON array in reply (" + t.length + " chars)"); return JSON.parse(t.slice(i, j + 1)); };
  async function write(uid, packets) {
    if (!KEY || !packets.length) return;
    // small batches keep each reply well inside the token budget
    for (let i = 0; i < packets.length; i += 4) await writeBatch(uid, packets.slice(i, i + 4));
  }
  async function writeBatch(uid, packets) {
    const sys = `You write the Insights card in a personal Parkinson's tracking app for one user: a scientist with early-onset PD who wants plain, specific, grounded sentences and no hype. For each packet, write JSON {"key", "text", "cite_text", "action"}:
- text: ONE sentence, at most 28 words, stating the observation. Use only numbers that appear in the packet (facts, template, bar, tag). Never invent or recompute a number. Vary the phrasing across packets; do not start every sentence the same way. For a pattern whose days_with + days_without is under 6, say it is too early to read and give the day count; do not quote the percentages.
- cite_text: ONE telegraphic sentence, at most 22 words, paraphrasing ONLY the given citation, starting with the study or author-year when there is one ("SPARX 2018: …"). If the citation says it is the user's own history, say "Your own history; no trial speaks to this pair." Never comment on the citation itself (no "no study named", no "general note").
- action: ONE concrete thing to do or take away, at most 24 words, in second person, matching the packet's action in substance. Never suggest changing a medication dose or its timing; anything about doses is phrased as something to raise with the neurologist.
Tone: a thoughtful colleague. No exclamation marks, no emoji, no "great job", no hedging padding. Return only a JSON array.`;
    const user = JSON.stringify(packets.map((p) => ({ key: p.key, category: p.category, title: p.title, stage: p.stage, facts: p.facts, template: p.template, bar: p.bar, tag: p.tag, citation: CITES[p.cite] ? CITES[p.cite].short : CITES.own.short, why: p.why || null })));
    try {
      const txt = await claude(sys, user, 3000);
      const arr = parseArray(txt);
      let ok = 0, rejected = [];
      for (const p of packets) {
        const w = arr.find((x) => x && x.key === p.key); const err = validate(p, w);
        if (err) { rejected.push(`${p.key}: ${err}`); continue; }
        await pool.query("update insights set prose = $3, prose_hash = $4, updated_at = now() where user_id = $1 and key = $2", [uid, p.key, JSON.stringify({ text: w.text.trim(), cite_text: (w.cite_text || "").trim(), action: w.action.trim() }), p.hash]); ok++;
      }
      state.lastWrite = { at: new Date().toISOString(), written: ok + ((state.lastWrite && state.lastWrite.at && Date.now() - new Date(state.lastWrite.at) < 60000) ? state.lastWrite.written : 0), rejected };
    } catch (e) { state.lastError = `write: ${e.message}`; console.error("insights write", e.message); }
  }

  // ---------- assembly ----------
  async function wantCount(uid) { return PER_CATEGORY; }
  async function current(uid, opts = {}) {
    const snap = await hyp.snapshot(uid);
    const table = snap.table, days = Object.keys(table).sort(), today = localDayOf(new Date());
    const packets = [];
    for (const g of [() => genToday(uid, today), () => genGoals(uid, table, days, today), () => genPatterns(snap), () => genNotes(uid, table, days, today)]) { try { packets.push(...(await g())); } catch (e) { console.error("insight generator", e.message); } }
    try { const specs = await explore(uid, snap, table, days, today, opts.regen); packets.push(...evaluateProposals(specs, snap, table, days)); } catch (e) { console.error("explorer", e.message); }
    for (const p of packets) { p.hash = hash({ v: 2, f: p.facts, t: p.template }); p.cite_short = CITES[p.cite] ? CITES[p.cite].short : CITES.own.short; p.cite_full = CITES[p.cite] ? CITES[p.cite].full : CITES.own.full; }
    // persist rows (prose cache, vote, pin, dismissed live here)
    for (const p of packets) await pool.query(`insert into insights (user_id, key, kind, family, text, action, why, cite, strength, numbers, links, stage) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      on conflict (user_id, key) do update set text = excluded.text, action = excluded.action, why = excluded.why, numbers = excluded.numbers, links = excluded.links, stage = excluded.stage, updated_at = now()`,
      [uid, p.key, p.category, p.family, p.template.text, p.template.action, p.why || p.cite_short, p.cite, p.stage, p.facts || {}, JSON.stringify(p.links || []), p.stage]);
    const rows = (await pool.query("select * from insights where user_id = $1", [uid])).rows; const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
    const now = Date.now();
    const live = packets.filter((p) => { const r = byKey[p.key]; return !(r && r.status === "dismissed" && now - new Date(r.updated_at) < DISMISS_DAYS * 86400000); });
    const score = (p) => { const r = byKey[p.key]; return (r && r.pinned ? 10 : 0) + (r && r.vote > 0 ? 1 : 0) + p.base; };
    const pages = {};
    for (const cat of ["today", "goals", "patterns", "notes"]) {
      const list = live.filter((p) => p.category === cat).sort((a, b) => score(b) - score(a));
      const seenFam = {}; const chosen = [];
      for (const p of list) { const r = byKey[p.key]; if (chosen.length >= PER_CATEGORY && !(r && r.pinned)) break; if (!(r && r.pinned) && cat !== "today" && (seenFam[p.family] || 0) >= 2) continue; seenFam[p.family] = (seenFam[p.family] || 0) + 1; chosen.push(p); }
      pages[cat] = chosen;
    }
    const chosen = Object.values(pages).flat();
    const need = chosen.filter((p) => { const r = byKey[p.key]; return !(r && r.prose && r.prose_hash === p.hash); });
    if (need.length) { await write(uid, need); const again = (await pool.query("select key, prose, prose_hash from insights where user_id = $1 and key = any($2)", [uid, need.map((p) => p.key)])).rows; for (const r of again) byKey[r.key] = { ...byKey[r.key], prose: r.prose, prose_hash: r.prose_hash }; }
    const item = (p) => { const r = byKey[p.key] || {}; const pr = r.prose && r.prose_hash === p.hash ? r.prose : null; return { id: r.id, key: p.key, category: p.category, icon: p.icon, title: p.title, tag: p.tag, stage: p.stage, stages: STAGES, family: p.family, text: pr ? pr.text : p.template.text, cite_text: pr && pr.cite_text ? pr.cite_text : p.cite_short, action: pr ? pr.action : p.template.action, why: p.why || null, cite_full: p.cite_full, generated: Boolean(pr), bar: p.bar || null, dots: p.dots || null, posterior: p.posterior ?? null, days: p.days || null, links: p.links || [], vote: r.vote || 0, pinned: Boolean(r.pinned), facts: p.facts }; };
    return { pages: Object.fromEntries(Object.entries(pages).map(([k, v]) => [k, v.map(item)])), candidates: packets.length, today, status: { ...state, generated: chosen.filter((p) => byKey[p.key] && byKey[p.key].prose && byKey[p.key].prose_hash === p.hash).length, shown: chosen.length } };
  }

  function routes(app, requireAuth) {
    app.get("/api/insights", requireAuth, async (req, res) => res.json(await current(req.user.id, { regen: req.query.regen === "1" })));
    app.get("/api/insights/status", requireAuth, async (req, res) => res.json(state));
    app.post("/api/insights/vote", requireAuth, async (req, res) => {
      const { id, vote } = req.body || {}; const uid = req.user.id;
      const r = (await pool.query("select * from insights where user_id = $1 and id = $2", [uid, id])).rows[0]; if (!r) return res.status(404).json({ error: "not found" });
      if (r.vote === 0) {
        if (vote > 0) { await pool.query("update insights set vote = 1, updated_at = now() where id = $1", [id]); await promote(uid, r); }
        else await pool.query("update insights set vote = -1, status = 'dismissed', pinned = false, updated_at = now() where id = $1", [id]);
      }
      res.json(await current(uid));
    });
    app.post("/api/insights/pin", requireAuth, async (req, res) => {
      const { id, pinned } = req.body || {}; const uid = req.user.id;
      const r = (await pool.query("select * from insights where user_id = $1 and id = $2", [uid, id])).rows[0]; if (!r) return res.status(404).json({ error: "not found" });
      await pool.query("update insights set pinned = $3, status = case when $3 then 'shown' else status end, updated_at = now() where user_id = $1 and id = $2", [uid, id, Boolean(pinned)]);
      if (pinned) await promote(uid, r);
      res.json(await current(uid));
    });
    app.post("/api/insights/dismiss", requireAuth, async (req, res) => {
      const { id } = req.body || {}; await pool.query("update insights set status = 'dismissed', pinned = false, updated_at = now() where user_id = $1 and id = $2", [req.user.id, id]);
      res.json(await current(req.user.id));
    });
  }
  // A 👍 or a pin on a "noticed" pattern (lead or proposal) starts watching it: it becomes an active hypothesis.
  async function promote(uid, r) {
    if (r.kind !== "patterns") return;
    const m = /^(lead|proposal):(.+)$/.exec(r.key); if (!m) return;
    const id = m[2];
    const existing = (await pool.query("select status from hypotheses where user_id = $1 and id = $2", [uid, id])).rows[0];
    if (existing) { if (existing.status === "lead") await pool.query("update hypotheses set status = 'active', started = $3, period = 14, pinned = true, reason = 'promoted from insights', updated_at = now() where user_id = $1 and id = $2", [uid, id, localDayOf(new Date())]); return; }
    // proposal: spec is stored on the insight's last packet; rebuild from the key's spec hash via a fresh snapshot
    const snap = await hyp.snapshot(uid); const specs = (await pool.query("select specs from insight_proposals where user_id = $1 order by day desc limit 3", [uid])).rows.flatMap((x) => x.specs);
    for (const p of specs) { if (p.type !== "pair" || !hyp.FK[p.x] || !hyp.FK[p.y]) continue; const spec = { x: p.x, xdir: p.xdir === "below" ? "below" : "above", thr: typeof p.thr === "number" ? { type: "lit", value: p.thr } : { type: "median" }, y: p.y, ydir: p.ydir === "down" ? "down" : "up", lag: p.lag ? 1 : 0 }; if ("x" + hash(spec) !== id) continue;
      await pool.query("insert into hypotheses (id, user_id, spec, text, status, reason, started, period, pinned) values ($1,$2,$3,$4,'active','promoted from insights',$5,14,true) on conflict (user_id, id) do update set status = 'active', started = excluded.started, period = 14, pinned = true", [id, uid, spec, hyp.describe(spec, snap.refs), localDayOf(new Date())]); return; }
  }

  return { routes, ensureTables, current, state };
};
