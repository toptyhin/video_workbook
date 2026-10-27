-- 009: эмбеддинги сегментов транскрибации (M12, семантический поиск).
-- vectors — L2-нормированный float32; dim = length(vector)/4; каскад от segments.
CREATE TABLE IF NOT EXISTS segment_embeddings (
  segment_id INTEGER PRIMARY KEY REFERENCES segments(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  dim INTEGER NOT NULL,
  vector BLOB NOT NULL,              -- float32, L2-нормированный
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_segment_embeddings_model ON segment_embeddings(model);
