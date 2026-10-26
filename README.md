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
