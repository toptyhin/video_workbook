CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS folder_stats (
  folder_path TEXT PRIMARY KEY,
  total INTEGER NOT NULL DEFAULT 0,
  done INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT OR IGNORE INTO settings(key, value) VALUES
  ('language', '"auto"'),
  ('whisper_model', '"small"'),
  ('theme', '"system"'),
  ('tags.multi_select_mode', '"union"'),
  ('tags.max_depth', '5'),
  ('log.level', '"INFO"');
