CREATE TABLE IF NOT EXISTS annotation_tags (
  annotation_id INTEGER NOT NULL REFERENCES annotations(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (annotation_id, tag_id)
);
CREATE INDEX IF NOT EXISTS idx_ann_tags_tag ON annotation_tags(tag_id);
