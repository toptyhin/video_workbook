from __future__ import annotations

from app.config import Config
from app.db import connect


def add_video(
    config: Config,
    path: str = "/tmp/videos/lesson-01.mp4",
    title: str | None = None,
    duration_ms: int = 600_000,
    status: str = "done",
) -> int:
    conn = connect(config.db_path)
    try:
        cursor = conn.execute(
            "INSERT INTO videos(path, title, duration_ms, size_bytes, status, progress) VALUES (?, ?, ?, ?, ?, ?)",
            (path, title or path.rsplit("/", 1)[-1], duration_ms, 1024, status, 1.0 if status == "done" else 0),
        )
        conn.commit()
        return int(cursor.lastrowid or 0)
    finally:
        conn.close()


def add_segment(config: Config, video_id: int, start_ms: int, end_ms: int, text: str) -> int:
    conn = connect(config.db_path)
    try:
        cursor = conn.execute(
            'INSERT INTO segments(video_id, start_ms, end_ms, "text") VALUES (?, ?, ?, ?)',
            (video_id, start_ms, end_ms, text),
        )
        conn.commit()
        return int(cursor.lastrowid or 0)
    finally:
        conn.close()


def add_tag(config: Config, name: str, parent_id: int | None = None, color: str | None = None) -> int:
    conn = connect(config.db_path)
    try:
        cursor = conn.execute(
            "INSERT INTO tags(parent_id, name, color) VALUES (?, ?, ?)", (parent_id, name, color)
        )
        conn.commit()
        return int(cursor.lastrowid or 0)
    finally:
        conn.close()
