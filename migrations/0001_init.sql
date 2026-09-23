-- One row per runner per contest, updated as they move.
CREATE TABLE IF NOT EXISTS runners (
  contest INTEGER NOT NULL, bib TEXT NOT NULL, rr_id TEXT, name TEXT, club TEXT, nat TEXT,
  gender TEXT, age_group TEXT, first_seen TEXT, last_seen TEXT, status TEXT, missing_since TEXT,
  last_split TEXT, last_elapsed INTEGER, finished INTEGER DEFAULT 0,
  PRIMARY KEY (contest, bib)
);

-- One row per runner per checkpoint, the first time we see it (re-timed values overwrite it).
CREATE TABLE IF NOT EXISTS passings (
  contest INTEGER NOT NULL, bib TEXT NOT NULL, split TEXT NOT NULL, label TEXT, tod TEXT,
  elapsed INTEGER, rank_overall INTEGER, rank_gender INTEGER, rank_age INTEGER, gap TEXT, observed_at TEXT,
  PRIMARY KEY (contest, bib, split)
);
CREATE INDEX IF NOT EXISTS passings_split ON passings (contest, split, elapsed);

-- The full live ranking every 2 minutes, compact JSON: [[bib, rank, genderRank, split, elapsed], ...]
CREATE TABLE IF NOT EXISTS snapshots (
  ts TEXT NOT NULL, contest INTEGER NOT NULL, n INTEGER, data TEXT,
  PRIMARY KEY (contest, ts)
);

-- Precomputed payloads the API serves with a single-row read.
CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, updated TEXT, data TEXT);
