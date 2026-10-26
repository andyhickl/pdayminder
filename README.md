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
