-- 008: записи экрана/окна (M11). Финальные файлы — $VL_DATA_DIR/recordings/*.webm.
CREATE TABLE IF NOT EXISTS recordings (
  id TEXT PRIMARY KEY,                 -- uuid hex сессии (32 символа)
  video_id INTEGER NOT NULL UNIQUE REFERENCES videos(id) ON DELETE CASCADE,
  source_kind TEXT NOT NULL,           -- 'screen' | 'window'
  source_title TEXT,                   -- имя экрана/окна (для истории)
  mime_type TEXT NOT NULL,             -- фактический mime MediaRecorder
  system_audio INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  size_bytes INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_recordings_video ON recordings(video_id);
