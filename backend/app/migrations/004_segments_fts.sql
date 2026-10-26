CREATE VIRTUAL TABLE segments_fts USING fts5(
  "text",
  content='segments',
  content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER segments_ai AFTER INSERT ON segments BEGIN
  INSERT INTO segments_fts(rowid, "text") VALUES (new.id, new.text);
END;
CREATE TRIGGER segments_ad AFTER DELETE ON segments BEGIN
  INSERT INTO segments_fts(segments_fts, rowid, "text") VALUES ('delete', old.id, old.text);
END;
CREATE TRIGGER segments_au AFTER UPDATE ON segments BEGIN
  INSERT INTO segments_fts(segments_fts, rowid, "text") VALUES ('delete', old.id, old.text);
  INSERT INTO segments_fts(rowid, "text") VALUES (new.id, new.text);
END;
INSERT INTO segments_fts(segments_fts) VALUES('rebuild');
