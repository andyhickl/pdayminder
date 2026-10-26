const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && !/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL)
    ? { rejectUnauthorized: false }
    : false,
});

const SCHEMA = `
create table if not exists users (
  id            serial primary key,
  email         text unique not null,
  password_hash text not null,
  created_at    timestamptz not null default now()
);

create table if not exists sessions (
  id         text primary key,
  user_id    int not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create table if not exists api_keys (
  id         serial primary key,
  user_id    int not null references users(id) on delete cascade,
  name       text not null,
  key_hash   text unique not null,
  prefix     text not null,
  created_at timestamptz not null default now(),
  last_used  timestamptz,
  revoked_at timestamptz
);

create table if not exists settings (
  user_id int primary key references users(id) on delete cascade,
  data    jsonb not null default '{}'::jsonb
);

-- 2-hour quality-of-life ratings. seg 0..11 = hours 0-2, 2-4, ... 22-24 local.
create table if not exists qol_ratings (
  user_id int not null references users(id) on delete cascade,
  day     date not null,
  seg     smallint not null check (seg between 0 and 11),
  type    text not null,            -- rating | sleep | empty
  rating  smallint not null check (rating between 1 and 5),
  updated_at timestamptz not null default now(),
  primary key (user_id, day, seg)
);

-- Medication doses with time of day.
create table if not exists med_doses (
  id       bigserial primary key,
  user_id  int not null references users(id) on delete cascade,
  day      date not null,
  taken_at time not null,
  drug     text not null default 'sinemet',
  dose     text,
  source   text not null default 'pdayminder',
  created_at timestamptz not null default now(),
  unique (user_id, day, taken_at, drug)
);

-- Everything from wearables and apps: one row per (source, metric, timestamp).
create table if not exists observations (
  id       bigserial primary key,
  user_id  int not null references users(id) on delete cascade,
  ts       timestamptz not null,
  source   text not null,           -- oura | whoop | strivepd | strava | concept2 | hae
  metric   text not null,           -- e.g. sleep_score, hrv, tremor, steps
  value    double precision,
  raw      jsonb,
  created_at timestamptz not null default now(),
  unique (user_id, source, metric, ts)
);
create table if not exists ingest_log (
  id         bigserial primary key,
  user_id    int references users(id) on delete cascade,
  ts         timestamptz not null default now(),
  route      text not null,
  status     int not null,
  rows       int,
  bytes      int,
  summary    jsonb
);

create index if not exists observations_user_ts on observations (user_id, ts);
create index if not exists observations_user_source_metric on observations (user_id, source, metric, ts);
`;

async function migrate() {
  await pool.query(SCHEMA);
}

module.exports = { pool, migrate };
