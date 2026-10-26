ALTER TABLE annotations ADD COLUMN updated_at TEXT;
CREATE VIRTUAL TABLE annotations_fts USING fts5(
  label,
  note,
  content='annotations',
  content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER annotations_ai AFTER INSERT ON annotations BEGIN
  INSERT INTO annotations_fts(rowid, label, note) VALUES (new.id, new.label, new.note);
END;
CREATE TRIGGER annotations_ad AFTER DELETE ON annotations BEGIN
  INSERT INTO annotations_fts(annotations_fts, rowid, label, note) VALUES ('delete', old.id, old.label, old.note);
END;
CREATE TRIGGER annotations_au AFTER UPDATE ON annotations BEGIN
  INSERT INTO annotations_fts(annotations_fts, rowid, label, note) VALUES ('delete', old.id, old.label, old.note);
  INSERT INTO annotations_fts(rowid, label, note) VALUES (new.id, new.label, new.note);
END;
INSERT INTO annotations_fts(annotations_fts) VALUES('rebuild');
