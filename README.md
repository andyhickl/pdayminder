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

## Cumulative HAE metrics
Steps, distance, energy, stand time etc. are keyed to local midnight and the largest value wins, because overlapping
HAE automation windows send partial sums for the same day. Sleep is one row per night keyed on the end date; windows
over 14 h are dropped as merged nights. `repairCumulative()` runs at boot to clean up older rows.

## Backlog
See `docs/BACKLOG.md`.

## Legal
`docs/privacy.md` and `docs/terms.md` are served publicly (no login) at `/privacy` and `/terms`.

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

## Pa-ta-ka / DDK test (motor/ddk_*)
10 s of repeated /pa-ta-ka/. Syllable onsets from a 5 ms RMS envelope (upward crossing of 15% of max after >=30 ms
below, 80 ms refractory). Metrics: `ddk_rate` (syll/s), `ddk_ioi_ms`, `ddk_cv` (rhythm), `ddk_decrement`,
`ddk_loudness_cv`, `ddk_score` (0–3 vs own baseline: rate, rhythm, slowdown).

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

## Score scales
All test scores are 0–4 with 0 = at or better than baseline/normal and 4 = worst (UPDRS direction): `tremor_updrs`,
`tap_updrs`, `voice_score`, `ddk_score`, `read_score`. QoL ratings stay 1–5 with 5 = best.
