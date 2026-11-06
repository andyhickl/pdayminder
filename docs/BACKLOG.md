# PDayMinder backlog

Ordered by value. Dates are when the item was added.

## Next up
- **Daily status report** (2026-11-01). Morning: last night (sleep, deep, HRV, lowest HR, readiness vs 30-day
  median), yesterday (QoL shape, doses and gaps, events with dose timing, batteries run, nutrition and protein near
  doses, context), what's missing (unrated blocks, unlogged doses, syncs that didn't run), one "notable" line.
  Every claim carries a computed evidence grade: no data / too early / weak / supported, with the denominator stated.
  Stored in the app as a dated page; email is a view. Weekly (Monday): rollups vs previous week and baseline,
  pattern section from the hypotheses engine, adherence, a "for your neurologist" block. Monthly: slow-measure
  trends, re-check of previously reported patterns (retractions), decision review. Runs as a Render cron.
- **Drills** (2026-11-02). Tests tab section with a daily tick list: LSVT-style voice drill (loud sustained "ah",
  pitch glides, loud reading; the first and third are measured by our tests), big-amplitude movement, cued walk at
  103 BPM, balance work; dystonia "when it starts" checklist in the event dialog (sensory tricks, heel-strike cue,
  calf stretch). Adherence as a daily metric.
- **"Test this"** (2026-11-02). Turn a hypothesis into a two-week alternating n-of-1 design with a controllable
  exposure (bedtime by 22:15 on A days, etc.), push the schedule to Google Calendar, tag days A/B, read out
  automatically on day 15 against a pre-registered outcome. Observational-only hypotheses say so; anything touching
  medication dose or timing becomes a needs-neurologist-approval card instead.
- **Insights v2**. More generators (hydration, bedtime regularity from Oura bedtime, supplement adherence, event
  clusters by time of day), RPE after workouts, "test this" from an insight (n-of-1), and a weekly digest of what was
  shown and voted.
- **Hypothesis generation beyond the catalog** (2026-11-02). Generate variants (thresholds, lags, two-exposure
  combinations), rank by coverage + votes + literature plausibility + cost of the intervention; naive Bayes over the
  whole feature set for "what predicts a bad afternoon". Votes (👍/✕) are the training signal.
- **Coaching** (2026-11-02). The top of the tested list plus the behaviour that was tested; proposals only; willing to
  say "nothing stands out yet".
- **Google Calendar push** for the regimen (Block 1 events already exist as .ics/CSV; make it live from the app).

## Scoring
- **Pre/post-dose delta metrics** (2026-10-31). Per day: post minus pre for each test in a battery pair, as its own
  daily metric for correlations and the hypotheses engine. Batteries now tag saves (`raw.battery`, `session_id`).
- **z-level composites**. Average the underlying z-scores and bin once; needs per-test z saved.
- **Learned personal weights** (mPower-style). After ~30 pre/post pairs, fit composite weights (Zhan 2018).
- Context-aware baselines: QoL per place (done) → test scores per place / per dose state.

## Tests
- **SASPAP baseline card** (2026-10-31, Andy). Confirm which instrument before building.
- Reaction time task (3 % of mPower). Skippable.
- Validate the voice analyzer on a public phone-recorded PD/HC corpus (MDVR-KCL on Zenodo).

## Data sources
- **Apple Movement Disorder API**: request the entitlement (write-up at /apple-movement-disorder), then a small
  native iOS + watchOS app posting tremor/dyskinesia percentages to `/api/observations`. The only passive source of
  the real signal.
- Overland: visit events; grow the home radius if "out" blips keep appearing ~900 m from home.
- Workouts: RPE prompt after a session (PD blunts the heart-rate response, so RPE should govern when HR does not);
  per-session pre/post test pairing; Concept2 Logbook API for splits and stroke rate.
- Whoop, Strava, TrainingPeaks, Concept2 syncs (Oura's OAuth/token pattern; Strava is connected on the agent side).
- Cronometer: keep an eye on the GWT hash discovery after Cronometer builds; nightly 429 handling is in.
- Written HIPAA records request to Rune Labs for StrivePD history.

## UI (small)
- Calendar dots for days with synced wearable data, not just QoL entries.
- Trends picker: a "scan all enabled metrics" table (r, n, lag).
- Export: one-click CSV of observations.
- Events: edit from the Day vitals band; a "still happening" quick-end button on the Home tab.

## Done
- 2026-10-26 → 10-31: Render redeploy · Postgres + login + API keys · HAE ingest with cumulative fix · Oura OAuth sync ·
  Day vitals · QoL correlations · Vitals trends · 7-day grid · date picker · tremor, tapping, gait, balance, spiral,
  sustained vowel, pa-ta-ka, reading tests · personal-baseline and norm 1–5 scores · composites · Stats · medication
  model with pre/post tagging · tabs · privacy/terms/bibliography · checkpoint `checkpoint/0.1-qolAndTests`.
- 2026-11-01: max phonation mode · /research and /apple-movement-disorder pages · data-loss fix (dirty-day saves) ·
  Settings/Trends/QoL sections · daily-multi cap fix · nutrition via HAE (summed metrics, protein near dose, meal
  hours) · Cronometer cron (daily summary + servings, session reuse, 429 backoff) · symptom events (log/edit, dose
  context, bands, histogram, rollups) · ring arcs and grid stars.
- 2026-11-05: Insights carousel (packets + Claude explorer + Claude writer with validation, stages, pins, ✕, 👍
  promotes a pattern to a hypothesis); Hypotheses/Findings cards removed from Trends.
- 2026-11-05: Insights card (B + C): five generators, persistence, vote/pin/refresh/count, learned ranking,
  cooldowns, links into tabs/sections/days; battery banner on Home.
- 2026-11-05: Home tab layout A (Today card = date nav + ring + week grid as picker; Day vitals moved from Trends;
  Hypotheses/Findings moved to Trends); per-day hypothesis verdicts relabelled (as predicted / not as predicted /
  comparison day).
- 2026-11-04: context classifier fix (parked ≠ driving, quiet drives end, atomic rebuilds) · workouts: zone minutes
  from per-minute HR, exercise profile, green ring arc, Day-vitals band, weekly intensity bars, Exercise dose stats,
  exercise features in the hypotheses engine.
- 2026-11-02: bubbled ray labels with precedence · supplements (settings, logging, yellow rays, rollups) · supplement
  stack recorded · location context (Overland, places, carry-forward, inner band, Location stats, QoL per place) ·
  event severity on the 1–5 scale · Home tab with Run tests (batteries, windows, Mon–Sun grid, runner banner) and
  Hypotheses (catalog, day scoring, votes, ranked queue).
