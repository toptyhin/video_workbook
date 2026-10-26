"""SQLite: соединения, PRAGMA, forward-only миграции (A7)."""
from __future__ import annotations

import logging
import sqlite3
from pathlib import Path

log = logging.getLogger(__name__)


def connect(db_path: Path | str) -> sqlite3.Connection:
    conn = sqlite3.connect(str(db_path), timeout=30, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA synchronous = NORMAL")
    conn.execute("PRAGMA busy_timeout = 30000")
    return conn


def get_user_version(conn: sqlite3.Connection) -> int:
    row = conn.execute("PRAGMA user_version").fetchone()
    return int(row[0]) if row else 0


def migrate(conn: sqlite3.Connection, migrations_dir: Path) -> int:
    """Применяет миграции по возрастанию номера; идемпотентно."""
    current = get_user_version(conn)
    files = sorted(Path(migrations_dir).glob("*.sql"))
    for path in files:
        try:
            version = int(path.name.split("_", 1)[0])
        except ValueError:  # pragma: no cover - защита от мусора в каталоге
            log.warning("Skipping migration with bad name: %s", path.name)
            continue
        if version <= current:
            continue
        log.info("Applying migration %s", path.name)
        conn.executescript(path.read_text(encoding="utf-8"))
        conn.execute(f"PRAGMA user_version = {version}")
        conn.commit()
        current = version
    return current
