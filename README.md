# PDayMinder

Personal Parkinson's QoL + medication tracker, and the data hub for the daily-regimen agents.

## Running
Requires `DATABASE_URL` (Postgres). On first boot with an empty `users` table, it creates the account from
`PDAYMINDER_USER` / `PDAYMINDER_PASSWORD` and imports `pdayminder-data.json` (from `DATA_DIR` if set, else the repo copy).

## Auth
- Web app: email + password at `/login`, 90-day httpOnly session cookie. Everything is behind it.
- Agents / integrations: `Authorization: Bearer <api key>`. Mint keys while signed in:
  `POST /api/keys {"name":"oura-sync"}` (key shown once), list `GET /api/keys`, revoke `DELETE /api/keys/:id`.
  API keys cannot mint or list keys.

## API
- `GET/POST /api/pdayminder/data` — the web app's payload (`settings`, `days`)
- `POST /api/observations` — `[{ts, source, metric, value, raw}]`, upserts on (source, metric, ts)
- `GET /api/observations?source=&metric=&from=&to=&limit=`
- `POST /api/med-doses` — `[{day, taken_at, drug, dose, source}]`
- `GET /api/health` — public liveness

## Tables
`users`, `sessions`, `api_keys`, `settings`, `qol_ratings` (day, seg 0-11, rating 1-5),
`med_doses` (day, taken_at, drug, dose, source), `observations` (ts, source, metric, value, raw).

## Health Auto Export
`POST /api/ingest/hae` with an API key accepts HAE's REST API payload (`{data:{metrics:[...], workouts:[...]}}`).
Each numeric field of each data point becomes an `observations` row with `source='hae'`:
`qty` -> `<metric>`, other fields -> `<metric>_<field>` (e.g. `heart_rate_avg`, `sleep_analysis_deep`).
Workouts -> metric `workout`, value = minutes, raw = the workout. Re-sending the same window is safe (upsert).

## UI data endpoints
- `GET /api/sources` — rows, metric count, first/last timestamp per source
- `GET /api/metrics` — distinct source/metric pairs
- `GET /api/daily?days=30&source=hae&metric=heart_rate_avg` — per-day mean QoL, dose count, and daily mean of one metric (`TZ_NAME`, default America/Los_Angeles)

## Day / trend endpoints
- `GET /api/day?day=YYYY-MM-DD` — hourly series, daily values, QoL segments, doses, workouts for one day
- `GET /api/daily-multi?days=30&metrics=hae/heart_rate_variability,hae/resting_heart_rate` — pivoted daily means
- `GET /api/workouts?days=14`

## Health Auto Export note
iOS drops a custom `Authorization` header from HAE's requests. Use the URL form:
`https://<host>/api/ingest/hae?api_key=<key>`. Use a dedicated key for HAE so it can be rotated alone.

## Oura
OAuth2. Register an app at cloud.ouraring.com/oauth/applications with redirect URI `https://<host>/oauth/oura/callback`;
set `OURA_CLIENT_ID` / `OURA_CLIENT_SECRET` (and `PUBLIC_URL`) on both the web service and the `oura-sync` cron job.
Connect from Settings > Integrations in the app; tokens live in `oauth_tokens` and the cron job refreshes them
(refresh tokens rotate). `sync/oura.js` runs every 4 h. `OURA_DAYS` is the lookback (3 by default; set 365 and
trigger a manual run once to backfill). A legacy `OURA_TOKEN` env var still works as a fallback. Writes `source='oura'` rows: sleep per night (keyed on the day it ended),
readiness, activity, stress, SpO2. Naps/rest sessions are skipped. Each run logs to `ingest_log` as `oura-sync`.

## Nutrition (hae/dietary_*, hae/protein, ...)
Food logged in Cronometer reaches Apple Health (13 nutrient types) and HAE relays it hourly like any other metric.
Intake metrics (regex `SUMMED_RE` in server.js: dietary_*, protein, carbohydrates, total_fat, fiber, caffeine,
water, minerals, vitamins) are summed per day instead of averaged, everywhere a daily value is computed
(`dailySeries()` backs `/api/daily`, `/api/daily-multi` and `/api/stats`; `/api/day` sums them into `daily`).
Derived daily metrics, computed on read and listed by `/api/metrics` once the inputs exist:
`derived/protein_near_dose` (grams of protein in hourly rows whose hour starts within ±90 min of a dopaminergic
dose; protein competes with levodopa for transport), `derived/first_meal_hour`, `derived/last_meal_hour` (from
non-zero hourly `dietary_energy`). Stats has a Nutrition group; Day vitals shows protein, fiber and caffeine.
The full Cronometer profile (80+ nutrients, supplements, creatine) needs the Cronometer cron (backlog).

## Home tab: batteries and hypotheses
The first tab is Home: date, ring + logging, **Run tests**, **Hypotheses**, recent days. A battery is the day's four
tests in order (tremor and tapping daily; the third and fourth slots rotate by weekday: pa-ta-ka, gait, balance,
spiral, sustained vowel, reading, max phonation, so each slow measure gets a weekly turn). Windows come only from logged
doses: pre-dose before the first dose, or 3 h+ after a dose while another is still expected (expected/day = number of
scheduled times for dopaminergic meds); after the last expected dose, pre-dose waits for tomorrow. Post-dose 45–120
min after any logged dose. One of each per day, with countdowns. The runner opens the right Tests section, scrolls to
the card and outlines it. Starting one switches to the Tests tab with a
banner; `apiFetch` tags each test save with `raw.battery` (pre/post) and `raw.session_id` and advances the banner
(ad hoc tests of another kind don't advance it). Completion posts `/api/sessions` (observation `session/battery`),
which drives the Mon–Fri pre/post grid and `derived/batteries_pre|post`.

Hypotheses (`hypotheses.js`): a feature store (`buildFeatures`: ~45 day-level features from Oura, HAE, Cronometer,
context, events, doses, batteries, QoL by period, pre/post deltas; cached 20 min, invalidated on writes) feeds a
generator that enumerates `exposure × threshold (personal median or literature value) × lag (0/1) → outcome ×
direction` over the registry `F`, keeping only coherent directions (bad→bad, good→good via the `better` hints).
Candidates are ranked by 14-day coverage, arm balance, a literature plausibility prior per family pair (`PRIOR`), a
retrospective effect hint, controllability, and a vote model (online logistic regression over family/feature
attributes trained on 👍/✕). Three are active in the `hypotheses` table (thresholds frozen at activation; one per
"if" feature and per family pair). Grading is prospective only: on days after activation, a 2×2 of "if" × "then",
rates, and the posterior P(rate_with > rate_without) under Beta(1,1) priors by Monte Carlo; grades no data / too
early (< 3 days per arm) / mixed / supported so far (≥ 0.9) / not holding up (≤ 0.1). The retrospective hint is
shown but never counts. `GET /api/hypotheses` (active, queue, history), `POST /api/hypotheses/vote`,
`POST /api/hypotheses/refresh {id, reason}` (retire + activate the best unseen; dismissals block the same "if" with
the same kind of "then" and cool its family), `POST /api/hypotheses/pin` (pinned ones keep scoring past their period
and can't be swapped), `POST /api/hypotheses/count` (1–8 under consideration, `settings.hypothesis_count`),
`POST /api/hypotheses/discard`, `GET /api/features`. `settle()` runs on every read: a hypothesis still "supported so
far" at the end of its period becomes a finding (status `finding`, evaluated over all days since activation);
expired or refuted ones retire. The Findings card also lists leads: retrospective effects with posterior ≥ 0.95 and
≥ 5 days per arm, persisted as status `lead` the first time they are seen (so they don't flicker as the data
shifts), re-scored over the last 45 days on every read and flagged when they weaken below 0.8. Every hypothesis,
finding and lead carries a plain-language sentence, a rationale from the family-pair table (`RATIONALE`), a day index,
and a "show the days" table of per-day values and verdicts with links into that day. Ranking caps the queue at two per
outcome family and two per "if" feature, with a growing penalty on repeated outcome features.

## Location context (source = context)
Overland (iOS, free) posts GeoJSON batches to `/api/ingest/overland?api_key=…`; points land in `locations`. Per local
day the server rebuilds segments: a point is `driving` if speed > 6 m/s, or if its motion array says so and it is not
sitting still inside a place (iOS keeps the driving flag on for minutes after parking); else `home` / `work` if within
that place's radius (Settings › Profile › Places: address geocoded via Nominatim at `/api/geocode`, or the phone's
position; default 250 m), else `out`. A state lasts until the next point, except that a drive with no points for
10 min (2 min inside a place) ends and the silence is labelled by the last point's position. Blips < 2 min are
absorbed. Rebuilds are transactional; `POST /api/context/rebuild?days=N` re-derives past days. Segments are observations (`metric = place`, `ts = start`, `value = minutes`, raw `{place,start,end,
source}`); `POST /api/context/manual {segments:[{start,end,place}]}` writes manual segments that own their days.
`/api/context?days=`, `/api/context/qol?days=` (minutes and overlap-weighted QoL per place), derived
`minutes_<place>` daily metrics, a Location section in Stats, and the outer band on the ring.

## Workouts (hae/workout, derived/workout_*)
HAE's workout records (name, start/end, per-minute heart rate, energy, distance) are summarised on read with
`summarizeWorkout`: minutes in the vigorous and moderate zones from the per-minute samples. Zones use heart-rate
reserve: HRmax = highest recorded workout HR in a year (else 208 − 0.7 × age, Tanaka), resting HR = 30-day median of
Watch resting / Oura lowest HR; vigorous ≥ 65 % HRR (≈ 80 % HRmax, the SPARX band), moderate ≥ 50 % HRR. Settings ›
Profile › Exercise (`settings.exercise {age, hrMax, hrRest, vigorousPct, weeklyVigorousMin, sessionsPerWeek}`)
overrides. `GET /api/workouts?days=` (summaries + profile), `GET /api/workouts/stats?weeks=` (Mon–Sun rollups, 4-week
averages, last 14 days). Daily derived metrics for trends, stats and the hypotheses engine: `workout_minutes`,
`workout_vigorous`, `workout_moderate`, `workouts_count`, `workout_kcal`, `workout_hr_avg`, `workout_hr_max`,
`workout_start_hour`, `vigorous_7d`, `mvpa_7d` (days from the first workout on are present with zeros). UI: green arc
on the ring, green band with the heart-rate trace on Day vitals, "Workouts by intensity" weekly bars on Trends,
"Exercise dose" tiles on Stats (this week vs 120 vigorous min, 150 MVPA min, 4 sessions).

## Supplements
Settings › Profile › Supplements mirrors the medication editor (`settings.supplements[{id,name,dose,times[]}]`), for
single-nutrient supplements worth timing (creatine, vitamin D, fiber, CoQ10); multivitamins stay in Cronometer. Logged
from the QoL tab ("Log supplement"), stored as `days[].supps[{t,id}]` → `med_doses` rows with `source = 'supplement'`,
yellow rays on the ring and marks on Day vitals. Daily rollups: `derived/supplements_logged`, `derived/supp_<id>`.

## Ring markers
Dose rays blue (dopaminergic; other meds are dots), supplement rays yellow, events red arcs on the inner edge with
start/end rays, workouts green arcs (end label only for sessions of an hour or more). Time labels sit in bubbles on two rings outside the wheel; placement runs in priority order (dose,
event, supplement), moving a colliding label to the outer ring and dropping it if both rings are taken (the ray and
its tooltip stay). Events for the last 21 days come with the initial `/api/pdayminder/data` payload so the ring
draws in one pass.

## Symptom events (source = event)
"Log an event" on the QoL tab records dystonia / cramping / posturing, involuntary movement, freezing, off episodes,
falls, pain or other: body regions, severity on the app-wide 1–5 scale (1 = couldn't function, 5 = barely noticeable), start and end (or "still happening"), triggers, free note. Stored
as one observation per event (`metric = event`, `ts = start`, `value = duration minutes`, details in `raw`) with
the dose context computed server-side at save: `dose_state`, `minutes_since_dose`, `dose_time`. Endpoints:
`GET /api/events?days=`, `POST /api/events` (upsert by start; `original_start` moves an edited event),
`DELETE /api/events?ts=`. `/api/day` returns the day's events; Day vitals draws them as shaded bands with the dose
lines. Derived daily metrics (`derived/events_count`, `event_minutes`, `events_<type>`) feed Stats, Trends and QoL
correlations; the Trends "Events" section adds a histogram of events by minutes since the last levodopa dose
(early/late clusters suggest diphasic patterns, a middle cluster peak-dose).

## Cronometer sync (sync/cronometer.js, source = cronometer)
Cronometer has no public API; the cron job logs in the way the web app does (anti-CSRF form login, GWT-RPC
`authenticate` and `generateAuthorizationToken`, then the same `/export?generate=servings` CSV the Export Data
button downloads). GWT hashes are read from the app's JS each run; the session cookie is cached in `oauth_tokens`
(provider `cronometer`) so most runs skip the rate-limited login. Env on the `cronometer-sync` job:
`CRONOMETER_EMAIL`, `CRONOMETER_PASSWORD`, `CRONOMETER_DAYS` (lookback, default 3), optional
`CRONOMETER_USER_EMAIL`. Every nutrient column becomes an hourly-summed metric (`energy`, `protein`, `fiber`,
`omega_3`, `b12`, ...); entries whose category/group says supplement, or whose name matches a supplement keyword
(creatine, vitamin, omega, magnesium...), also become `supp_<slug>` with the numeric amount. The lookback window is
rewritten each run so edits and deletions propagate. All `cronometer/*` metrics are summed per day; `/api/day`
returns them as `nutrition`, which Day vitals prefers over the Apple Health copy. Unofficial: a Cronometer build
can break it until the hashes or payloads are updated; the Apple Health path keeps the macros flowing meanwhile.

## Cumulative HAE metrics
Steps, distance, energy, stand time etc. are keyed to local midnight and the largest value wins, because overlapping
HAE automation windows send partial sums for the same day. Sleep is one row per night keyed on the end date; windows
over 14 h are dropped as merged nights. `repairCumulative()` runs at boot to clean up older rows.

## UI
Five tabs (bottom bar on phones, top bar on desktop), remembered per device: QoL (day view, ring, day vitals, 7-day grid),
Tests (Motor and Voice sections, collapsible), Trends (Day vitals first), Stats (`/api/stats`: last, 7/14/30-day means,
min/max/SD, 30-day sparkline, baseline = mean±SD of days 8–90 ago; latest value coloured on the QoL palette relative to
baseline, scores on their own 1–5 scale), Settings (incl. Trend metrics picker; `settings.trendMetrics` overrides
`DEFAULT_TREND_METRICS`). Placeholder days (no ratings, no doses) are not stored. Checkpoint before the tabbed layout: branch `checkpoint/0.1-qolAndTests`.

## Backlog
See `docs/BACKLOG.md`.

## Medications and dose state
`settings.medications` = `[{id, name, dose, dopaminergic, times: ["HH:MM", ...]}]` (replaces the old 3-slot `medTimes`;
migrated on load). Logged doses are `{t, drug}` (old plain "HH:MM" strings = sinemet) and are stored in `med_doses.drug`.
Dopaminergic drugs get the ring rays and the white dose lines in Day vitals; other drugs show as grey dots/lines.
"Doses / day" counts dopaminergic doses only. Every saved test carries `raw.dose_state` (`pre` | `post` | `ramp`) and
`raw.minutes_since_dose` computed at save time; `GET /api/observations?annotate=dose` recomputes the same from logged
doses for any analysis. Rule: post = 30–210 min after the latest dopaminergic dose that day, ramp = under 30 min, pre
otherwise (no dose yet counts as pre).

## Legal
`docs/privacy.md`, `docs/terms.md` and `docs/bibliography.md` are served publicly (no login) at `/privacy`, `/terms`
and `/bibliography` (annotated sources for every test, score and reference range; linked from Settings → About).

## Tremor test (motor/*)
20 s phone accelerometer test in the app. Per-axis spectra (1–15 Hz) are summed; the 3.5–7.5 Hz band is scored.
Metrics per test: `tremor_rms` (m/s², band), `tremor_band_ratio`, `tremor_peak_hz`, `tremor_amp_cm` (peak-to-peak
hand excursion from x = a/(2πf)² at the band peak), `tremor_updrs` (MDS-UPDRS 3.17 amplitude bins: 0 <0.1 cm,
1 <1 cm, 2 1–3 cm, 3 3–10 cm, 4 >10 cm — an estimate of the clinical score, not a rating). `raw` carries hand,
posture, note. Phone only; laptops don't expose motion sensors to the browser.

## Finger tapping test (motor/tap_*)
Alternate taps between two targets for 20 s. Metrics: `tap_rate` (taps/s), `tap_iti_ms`, `tap_cv` (rhythm),
`tap_decrement` (first-half vs second-half rate), `tap_accuracy` (alternation), `tap_updrs` (heuristic 0–4 in the spirit
of MDS-UPDRS 3.4; not calibrated to clinic ratings). `raw` carries hand and note.

## Voice test (motor/voice_*)
5 s sustained /a/ via the phone mic (Web Audio, no audio stored). Frame pass for voicing and coarse F0; period pass
(peak-to-peak) on the longest voiced run gives Praat-style local jitter/shimmer; HNR from a period-averaged template vs
residual. Period marks are refined to sub-sample precision by cross-correlating each period onto the previous mark.
Validated against Praat (parselmouth) on synthetic phonations: F0 exact, jitter within ~0.02 pp on steady/jittery
voices (reads high under heavy breath noise), HNR within ~1 dB when noise is present (caps ~34 dB on pure tones),
shimmer ~30% lower than Praat on step-change test tones. Metrics: `voice_f0`, `voice_f0_sd`, `voice_jitter_pct`,
`voice_shimmer_pct`, `voice_hnr`, `voice_loudness_db`, `voice_int_slope` (dB/s over the phonation; improves OFF→ON per
Bern 2025), `voice_ppe` (pitch period entropy, Little 2009: normalized entropy of the AR(2) residual of semitone pitch).

Scoring: `voice_score` (0–4) counts how many of jitter, shimmer, HNR, PPE are worse than the user's own prior mean by
>1 SD (needs 5 prior tests). Group-reference labels were removed: the UCI reference used studio mics and the groups
overlap (AUC ~0.75), so single values can't say anything about diagnosis; the card shows only a muted percentile.

Max phonation mode: the same card can record one hold of "ahh" for as long as the breath lasts (up to 60 s, Done to
stop). `voice_mpt` = the longest continuous voiced stretch in seconds; `voice_mpt_norm` scores it 1–5 against ~20 ± 6 s
for healthy adults (Maslan 2011), `voice_mpt_score` against the user's own prior holds (needs 5). It tracks breath
support and glottal closure, moves with voice therapy (LSVT), and is a slow measure: weekly is enough. It is not part
of the Voice composite.

## Pa-ta-ka / DDK test (motor/ddk_*)
10 s of repeated /pa-ta-ka/. Syllable nuclei = peaks of a 10 ms RMS envelope (15 ms smoothing), >=80 ms apart, with a
valley <=80% of the lower neighbour (no ASR). `coverage` = share of the speech span inside the detected run; the card
warns below 60%. Validated 3–8 syll/s with consonant dips as shallow as 30% and closures down to 20 ms. Metrics: `ddk_rate` (syll/s), `ddk_ioi_ms`, `ddk_cv` (rhythm), `ddk_decrement`,
`ddk_loudness_cv`, `ddk_score` (1–5 vs own baseline: rate, rhythm, slowdown, loudness consistency).

## Spiral test (motor/spiral_*)
Trace a 3-turn Archimedean spiral on a canvas. Angular offset is fitted (median of θ − r/k) so the start angle doesn't
matter; residual r − kθ scores deviation. Metrics: `spiral_error_pct` (mean |residual| / R), `spiral_tremor_share`
(3.5–7.5 Hz share of the residual), `spiral_seconds`, `spiral_speed` (path length / s / R). `raw.trace` keeps a
downsampled stroke (≤200 points) for review.
Reference ranges on the card come from the UCI Parkinsons dataset (Little et al. 2008). Note from the UCI telemonitoring
set (Tsanas 2009, 42 PD patients over ~6 months): classic jitter/shimmer/HNR separate PD from healthy at group level
(AUC ~0.75–0.78) but show ~zero within-person correlation with motor UPDRS over time, so treat voice as a slow, low-weight signal.

## Reading test (motor/read_*)
Read a passage aloud (Rainbow Passage is the scored standard; five public-domain literary passages for variety, each
with its own baseline). 10 ms frames, autocorrelation pitch on voiced frames, octave errors dropped (>7 st from median).
Metrics: `read_f0_sd_st` (pitch SD in semitones; monopitch when low), `read_range_st` (p5–p95), `read_f0`, `read_rate`
(envelope peaks/s), `read_pause_pct`, `read_seconds`, `read_score` (0–4 vs own baseline on the same passage).
`raw.passage` tags the passage. sdF0 in read speech improved OFF→ON in Bern 2025.

## Gait test (motor/gait_*)
Phone in a front pocket, 5 s lead-in, 30 s walk. Orientation-free acceleration magnitude at 50 Hz, 1 s moving mean removed.
Steps = peaks >= 0.5×RMS, >= 0.3 s apart. Metrics: `gait_cadence` (steps/min), `gait_step_cv` (%), `gait_step_regularity`
and `gait_stride_regularity` (normalised autocorrelation at 1- and 2-step lags, Moe-Nilssen & Helbostad), `gait_asymmetry`
(|AC1 − AC2|), `gait_rms`, `gait_score` (1–5 vs own baseline), `gait_norm` (1–5 vs healthy cadence 112±9 and step CV 2.5±1.5 %).

## Balance test (motor/balance_*)
Feet together, phone held flat against the chest, 30 s still (5 s lead-in). Gravity-free acceleration (or 2 s moving
mean removed), 100 ms smoothing; x = mediolateral, z = anteroposterior. Metrics: `balance_sway_rms` (horizontal RMS
m/s²), `balance_sway_ml`, `balance_sway_ap`, `balance_path` (per s), `balance_jerk` (m/s³), `balance_area` (95 % ellipse
proxy), `balance_low_share` (0–1 Hz share), `balance_score` (1–5 vs own baseline, per eyes condition), `balance_norm`
(eyes open only; sway RMS 0.08±0.03 and jerk 1.0±0.5 from trunk-accelerometer stance norms, Mancini 2012 — approximate
for a chest-held phone). `raw.eyes` = open | closed.

## Norm-referenced scores (`*_norm`, 1–5)
Alongside each personal-baseline score, mic-robust measures are compared to healthy-control references: pa-ta-ka rate
vs 7.16±0.73 syll/s and reading F0 SD vs 2.48±0.56 st (Rusz et al. 2011, 23 HC), sustained-vowel jitter vs 0.37±0.20 %
and PPE vs 0.12±0.05 (UCI healthy recordings), gait as above. z (direction-adjusted) → 5 at z ≥ −0.5, 4 ≥ −1, 3 ≥ −1.5,
2 ≥ −2, else 1. Shimmer and HNR are excluded as microphone-dependent. Composites (client-side, daily means of components):
`rollup:motor_norm` (tremor_score, tap_score, gait_norm), `rollup:motor_base` (tremor_score, tap_score, gait_score),
`rollup:voice_norm` (ddk/voice/read _norm), `rollup:voice_base` (ddk/voice/read _score), `rollup:overall_*`.
Composites are weighted means renormalised over the tests present that day: motor gait 0.35 / balance 0.25 /
tapping 0.25 / tremor 0.15; voice pa-ta-ka 0.5 / reading 0.3 / vowel 0.2; overall motor 0.75 / voice 0.25. Weights follow the mPower digital
PD score (Zhan et al. 2018: gait 33.4 %, balance 23.2 %, tapping 23.0 %, voice 17.0 %, reaction 3.4 %) renormalised over
our tasks, with tremor at roughly its MDS-UPDRS III item share. The Status card at the top of Trends shows all three vs healthy and vs baseline with sparklines.

## Score scales
Every consolidated score is 1–5 with 5 = best, matching QoL: `tremor_score` (= 5 − estimated UPDRS 3.17),
`tap_score` (= 5 − tapping heuristic), `voice_score`, `ddk_score`, `read_score` (= 5 − number of features worse than
the user's own baseline). `tremor_updrs` and `tap_updrs` (0–4) are kept as the clinical-style estimates.
A one-time `migrateScores()` derived/flipped existing rows (tracked in the `migrations` table).
