CREATE INDEX IF NOT EXISTS idx_tags_parent ON tags(parent_id);
CREATE INDEX IF NOT EXISTS idx_tags_name ON tags(name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_video_tags_tag ON video_tags(tag_id);
CREATE INDEX IF NOT EXISTS idx_segment_tags_tag ON segment_tags(tag_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_tags_parent_name ON tags(COALESCE(parent_id, 0), name COLLATE NOCASE);
