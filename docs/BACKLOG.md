# PDayMinder backlog

Ordered roughly by value. Dates are when the item was added.

## UI
- **Reorganize the app** (2026-10-31). Group cards into sections (Log / Vitals / Tests / Trends / Settings), and add a
  single "Run tests" flow that walks tremor → tapping → spiral (→ voice weekly) with one note at the end. Target is a
  twice-daily session under two minutes.
- Calendar "has data" dots for days with synced wearable data, not just QoL entries.

## Tests and features
- **Gait test** (2026-10-31). Phone in pocket, walk 30 s. Cadence, step regularity, asymmetry from the accelerometer.
  Reuses the tremor-test capture code. On demand, so pre/post-dose comparison is possible (Watch gait is daily only).
- **DDK / pa-ta-ka test** (2026-10-31). Repeat /pa-ta-ka/ for 10 s. Syllable rate, rhythm irregularity (DDKI), voice
  onset time. The speech task most sensitive to levodopa state (Cologne 2025, Bern 2025); sustained-vowel measures are
  a slow baseline only.
- **Reading-passage sdF0** (2026-10-31). Monopitch in read speech improves OFF→ON (Bern 2025). Needs a fixed passage
  and pitch tracking over connected speech.
- **Balance / sway test**. Phone against chest, 30 s eyes open then closed; sway area. Only domain nothing else covers.
- **SASPAP baseline card** (2026-10-31, Andy). As written; confirm which instrument this refers to before building.
- **Pre/post-dose delta metrics**. Per day: (pre-dose score − post-dose score) for tremor, tapping, spiral, as its own
  daily metric for the Trends correlation. Needs tests tagged pre/post (note field now; a toggle later).
- Max phonation time mode for the voice test (hold "ahh" as long as possible; currently capped at 5 s).

## Data
- Whoop, Strava, TrainingPeaks, Concept2 syncs (same OAuth/token pattern as Oura).
- Apple Movement Disorder API: a small native iOS app to pull StrivePD-equivalent tremor/dyskinesia (needs Apple
  entitlement). Draft the entitlement request.
- Run our voice analyzer over a public phone-recorded PD/HC corpus (MDVR-KCL on Zenodo) to confirm group separation.

## Daily outputs (the original goal)
- Status report (morning): last night, yesterday's load and doses, QoL trend, gaps.
- Coach update: today's plan to Google Calendar, one focus, what's working.
- Research brief: PubMed / bioRxiv / ClinicalTrials.gov watch, evidence-tiered, EOPD-filtered.
