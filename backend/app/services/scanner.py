"""Фоновое сканирование папок и upsert файлов библиотеки (M2)."""
from __future__ import annotations

import asyncio
import logging
import os
import sqlite3
import uuid
from pathlib import Path

from ..config import Config
from ..db import connect
from . import probe
from .events import EventBus

log = logging.getLogger(__name__)

VIDEO_EXTENSIONS = probe.VIDEO_EXTENSIONS


def upsert_file(conn: sqlite3.Connection, config: Config, file_path: Path) -> tuple[str, int | None]:
    """Добавляет/обновляет файл. Возвращает (added|duplicates|errors, video_id)."""
    key = str(file_path)
    try:
        meta = probe.probe_video(file_path, config.ffprobe)
    except (probe.ProbeError, OSError) as exc:
        _upsert_error(conn, file_path, str(exc))
        return "errors", _video_id(conn, key)
    existing = conn.execute("SELECT id FROM videos WHERE path = ?", (key,)).fetchone()
    duplicate = conn.execute(
        "SELECT id FROM videos WHERE sha256 = ? AND path != ?", (meta.sha256, key)
    ).fetchone()
    status = "duplicate" if duplicate else "pending"
    duplicate_of = duplicate["id"] if duplicate else None
    # UNIQUE(sha256) из спеки: у дубликата храним NULL и ссылку duplicate_of.
    sha256 = None if duplicate else meta.sha256
    if existing:
        conn.execute(
            "UPDATE videos SET title = COALESCE(title, ?), duration_ms = ?, size_bytes = ?, "
            "sha256 = ?, mtime_ms = ?, status = CASE WHEN status = 'done' THEN status ELSE ? END, "
            "duplicate_of = ?, error = NULL WHERE id = ?",
            (
                file_path.name,
                meta.duration_ms,
                meta.size_bytes,
                sha256,
                meta.mtime_ms,
                status,
                duplicate_of,
                existing["id"],
            ),
        )
        video_id = existing["id"]
    else:
        cursor = conn.execute(
            "INSERT INTO videos(path, title, duration_ms, size_bytes, sha256, mtime_ms, status, duplicate_of) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                key,
                file_path.name,
                meta.duration_ms,
                meta.size_bytes,
                sha256,
                meta.mtime_ms,
                status,
                duplicate_of,
            ),
        )
        video_id = int(cursor.lastrowid or 0)
    conn.commit()
    return ("duplicates" if duplicate else "added"), video_id


def _video_id(conn: sqlite3.Connection, path: str) -> int | None:
    row = conn.execute("SELECT id FROM videos WHERE path = ?", (path,)).fetchone()
    return int(row["id"]) if row else None


def _upsert_error(conn: sqlite3.Connection, file_path: Path, message: str) -> None:
    row = conn.execute("SELECT id FROM videos WHERE path = ?", (str(file_path),)).fetchone()
    if row:
        conn.execute(
            "UPDATE videos SET status = 'error', error = ? WHERE id = ?",
            (message[:1000], row["id"]),
        )
    else:
        conn.execute(
            "INSERT INTO videos(path, title, status, error) VALUES (?, ?, 'error', ?)",
            (str(file_path), file_path.name, message[:1000]),
        )
    conn.commit()


class Scanner:
    def __init__(self, config: Config, bus: EventBus) -> None:
        self.config = config
        self.bus = bus
        self._tasks: dict[str, asyncio.Task[None]] = {}
        self._known_roots: dict[str, str] = {}
        self._loop: asyncio.AbstractEventLoop | None = None

    def bind_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    def start_scan(self, path: str) -> str:
        root = str(Path(path).expanduser())
        if root in self._known_roots:
            return self._known_roots[root]
        scan_id = uuid.uuid4().hex
        self._known_roots[root] = scan_id
        if self._loop is None:  # pragma: no cover - приложение ещё не стартовало
            raise RuntimeError("scanner loop is not bound")
        self._loop.call_soon_threadsafe(self._spawn, scan_id, root)
        return scan_id

    def _spawn(self, scan_id: str, root: str) -> None:
        task = asyncio.create_task(self._run(scan_id, root))
        self._tasks[scan_id] = task

        def cleanup(_task: asyncio.Task[None]) -> None:
            self._tasks.pop(scan_id, None)
            self._known_roots.pop(root, None)

        task.add_done_callback(cleanup)

    async def _run(self, scan_id: str, root: str) -> None:
        loop = asyncio.get_running_loop()
        try:
            stats = await asyncio.to_thread(self._scan_sync, scan_id, root, loop)
        except Exception as exc:  # pragma: no cover
            log.exception("Scan failed: %s", root)
            self.bus.publish_threadsafe(
                "backend.error", {"code": "scan_failed", "detail": str(exc), "scan_id": scan_id}
            )
            return
        self.bus.publish("folder.scanned", {"scan_id": scan_id, "root": root, **stats})

    def _scan_sync(self, scan_id: str, root: str, loop) -> dict:
        conn = connect(self.config.db_path)
        stats = {"found": 0, "added": 0, "duplicates": 0, "errors": 0}
        try:
            target = Path(root)
            if target.is_file():
                files = [target] if probe.is_video_file(target) else []
            else:
                files = []
                for dirpath, _dirnames, filenames in os.walk(target):
                    for name in filenames:
                        candidate = Path(dirpath) / name
                        if probe.is_video_file(candidate):
                            files.append(candidate)
            files.sort()
            for file_path in files:
                stats["found"] += 1
                outcome, video_id = upsert_file(conn, self.config, file_path)
                stats[outcome] += 1
                self.bus.publish_threadsafe(
                    "video.status",
                    {
                        "scan_id": scan_id,
                        "video_id": video_id,
                        "status": outcome,
                        "path": str(file_path),
                    },
                )
        finally:
            conn.close()
        return stats
