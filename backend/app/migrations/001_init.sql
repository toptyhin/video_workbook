-- Базовые таблицы (TARGET.md §4), без FTS (FTS — M4).
CREATE TABLE IF NOT EXISTS videos (
  id INTEGER PRIMARY KEY,
  path TEXT UNIQUE NOT NULL,
  title TEXT,
  duration_ms INTEGER,
  size_bytes INTEGER,
  sha256 TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending',
  progress REAL NOT NULL DEFAULT 0,
  error TEXT,
  added_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  processed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_videos_status ON videos(status);
CREATE INDEX IF NOT EXISTS idx_videos_added ON videos(added_at);

CREATE TABLE IF NOT EXISTS segments (
  id INTEGER PRIMARY KEY,
  video_id INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  "text" TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_seg_video_time ON segments(video_id, start_ms);

CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY,
  parent_id INTEGER REFERENCES tags(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT,
  UNIQUE(parent_id, name)
);

CREATE TABLE IF NOT EXISTS video_tags (
  video_id INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (video_id, tag_id)
);

CREATE TABLE IF NOT EXISTS segment_tags (
  segment_id INTEGER NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (segment_id, tag_id)
);

CREATE TABLE IF NOT EXISTS annotations (
  id INTEGER PRIMARY KEY,
  video_id INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  label TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#3b82f6',
  note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_ann_video ON annotations(video_id, start_ms);

CREATE TABLE IF NOT EXISTS watched_folders (
  id INTEGER PRIMARY KEY,
  path TEXT UNIQUE NOT NULL,
  added_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
