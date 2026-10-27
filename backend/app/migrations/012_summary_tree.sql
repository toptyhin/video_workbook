-- M14 (rev2): иерархическое дерево смысловых блоков вместо фиксированных уровней.
-- Старый кэш MAP/levels несовместим с новой моделью — это кэш, его можно удалить.
DROP TABLE IF EXISTS summary_chunks;
DROP TABLE IF EXISTS summary_levels;

CREATE TABLE IF NOT EXISTS summary_nodes (
  video_id INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  node_id TEXT NOT NULL,
  parent_id TEXT,
  depth INTEGER NOT NULL,
  order_idx INTEGER NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  segment_ids TEXT NOT NULL,
  title TEXT,
  summary TEXT,
  children_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (video_id, model, node_id)
);
CREATE INDEX IF NOT EXISTS idx_summary_nodes_depth
  ON summary_nodes(video_id, model, depth, order_idx);

-- Материализованные уровни детализации: 1 — самый подробный (листья дерева),
-- max_level — корневое саммари. Уровень 0 в БД не хранится (это segments).
CREATE TABLE IF NOT EXISTS summary_levels (
  video_id INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  level INTEGER NOT NULL,
  label TEXT,
  blocks TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  prompt_version INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (video_id, model, level)
);

ALTER TABLE summary_jobs ADD COLUMN max_level INTEGER;
