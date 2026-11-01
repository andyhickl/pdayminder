# PDayMinder backlog

Ordered by value. Dates are when the item was added.

## The original goal: three daily outputs (not started)
- **Status report** (morning). Last night, yesterday's doses and tests, QoL trend, what didn't sync. Pure reads over
  data that now exists. Best first build: run it as a scheduled task first, then bake it into the app.
- **Coach update**. Today's plan to Google Calendar, one focus, what's working, proposals only (never auto-changes
  meds). Depends on the status report and a few weeks of baseline.
- **Research brief**. PubMed / bioRxiv / ClinicalTrials.gov watch, evidence-tiered, EOPD-filtered; most days short or
  empty. Separate from the AI news brief.
- Where the agents run: Render cron (reachable from the DB) vs scheduled Claude sessions (this workspace can't reach
  render.com). Decide before building the first one.

## Scoring (next after the outputs)
- **Pre/post-dose delta metrics** (2026-10-31). Per day: post-dose minus pre-dose score for each test, as its own daily
  metric for QoL correlations. Dose tagging is in place (`raw.dose_state`, `annotate=dose`), so this is a rollup.
- **z-level composites**. Composites average binned 1–5 scores; averaging the underlying z-scores and binning once at
  the end loses less. Needs per-test z saved (`*_z_norm`, `*_z_base`).
- **Learned personal weights** (mPower-style weak supervision). After ~30 pre/post-dose pairs, fit weights so the
  composite ranks pre-dose worse than post-dose as often as possible (Zhan 2018).

## Tests
- **SASPAP baseline card** (2026-10-31, Andy). As written; confirm which instrument before building.
- Reaction time task (3 % of mPower). Skippable.
- Validate the voice analyzer on a public phone-recorded PD/HC corpus (MDVR-KCL on Zenodo).

## Data sources
- **Nutrition vs symptoms** (2026-10-31, Andy). Why it matters in PD: dietary protein competes with levodopa for
  gut and blood-brain transport (large neutral amino acids), so protein near a dose can blunt or delay it; caffeine,
  meal timing and total energy also plausibly move QoL. Plan: (1) log food in an app that writes to Apple Health
  (Cronometer writes macros and micronutrients; MacroFactor, MyFitnessPal, Lose It and Foodnoms write macros);
  (2) add the HealthKit dietary metrics (energy, protein, carbohydrates, fat, fiber, water, caffeine) to the HAE
  daily automation at an hourly interval so meal timing survives; (3) ingest as `hae` daily/hourly metrics like
  everything else; (4) new rollups per day: total protein, protein within ±90 min of each levodopa dose, caffeine,
  first/last meal time, and surface them in QoL correlations and in the pre/post-dose delta analysis once that
  exists. No new OAuth needed; the whole thing rides on HAE. Open question: does HAE relay per-sample dietary
  entries with their timestamps or only interval sums (hourly sums are enough).
- Whoop, Strava, TrainingPeaks, Concept2 syncs (Oura's OAuth/token pattern; Strava is already connected to the agent side).
- Apple Movement Disorder API: small native iOS app for StrivePD-equivalent tremor/dyskinesia (needs Apple
  entitlement). Draft the entitlement request. Only passive source of the real signal.
- Written HIPAA records request to Rune Labs for StrivePD history.

## UI (small)
- Calendar dots for days with synced wearable data, not just QoL entries.
- Trends picker: lag and correlation are per-metric; a "scan all enabled metrics" table (r, n, lag) would save clicking.
- Export: a one-click CSV of observations (not just QoL/meds) for analysis outside the app.

## Done (2026-10-26 → 2026-10-31)
Render redeploy · Postgres + login + API keys · HAE ingest (hourly HR/HRV, daily gait, sleep, workouts) with cumulative
fix · Oura OAuth sync · Day vitals (hourly HR/HRV over QoL bands, dose lines, test markers, day-over-day arrows) ·
QoL correlations (dual axis, lag, Spearman) · Vitals trends · tap-to-rate 7-day grid with paging · date picker ·
tremor, tapping, gait (free/cued), balance, spiral, sustained vowel, pa-ta-ka, reading tests · personal-baseline and
norm-referenced 1–5 scores · literature-weighted Motor/Voice/Overall composites · Stats tab with baselines ·
medication model (multi-drug, dopaminergic flag, pre/post-dose tagging) · tabbed UI · cancel buttons · favicon/PWA ·
privacy, terms, annotated bibliography · checkpoint branch `checkpoint/0.1-qolAndTests`.
