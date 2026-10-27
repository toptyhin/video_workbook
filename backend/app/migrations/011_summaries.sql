-- M14: саммари транскрибации (plans/14-summary-lfm.md §4.1).
-- Кэш хранится per-model: установленные одновременно модели не вытесняют друг друга.
CREATE TABLE IF NOT EXISTS summary_chunks (
  video_id INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  points TEXT NOT NULL,
  keywords TEXT,
  source_hash TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_version INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (video_id, model, idx)
);
CREATE INDEX IF NOT EXISTS idx_summary_chunks_video ON summary_chunks(video_id, model);

CREATE TABLE IF NOT EXISTS summary_levels (
  video_id INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  level INTEGER NOT NULL CHECK(level BETWEEN 1 AND 4),
  blocks TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_version INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (video_id, model, level)
);

CREATE TABLE IF NOT EXISTS summary_jobs (
  video_id INTEGER PRIMARY KEY REFERENCES videos(id) ON DELETE CASCADE,
  state TEXT NOT NULL,
  level INTEGER,
  detail TEXT,
  error_code TEXT,
  source_hash TEXT,
  model TEXT,
  prompt_version INTEGER,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
