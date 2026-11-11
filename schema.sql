CREATE TABLE IF NOT EXISTS handoff (
  key TEXT PRIMARY KEY,
  state TEXT,
  reason TEXT,
  lang TEXT,
  since INTEGER,
  touched INTEGER,
  last_notice INTEGER DEFAULT 0
);
