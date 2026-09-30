-- No IP, no headers, no request metadata: the checked report, when, and alert state.
CREATE TABLE IF NOT EXISTS reports (
  install  TEXT NOT NULL,
  id       TEXT NOT NULL,
  kind     TEXT NOT NULL,
  received TEXT NOT NULL,
  day      TEXT NOT NULL,
  body     TEXT NOT NULL,
  sig      TEXT,
  alerted  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (install, id)
);
CREATE TABLE IF NOT EXISTS examples (
  install  TEXT NOT NULL,
  id       TEXT NOT NULL,
  received TEXT NOT NULL,
  day      TEXT NOT NULL,
  body     TEXT NOT NULL,
  alerted  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (install, id)
);
-- Failure signatures and weekly summaries already alerted. Code locations, no install ids.
CREATE TABLE IF NOT EXISTS signatures (sig TEXT PRIMARY KEY, first_day TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS alerts (day TEXT PRIMARY KEY, n INTEGER NOT NULL);
