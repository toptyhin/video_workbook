"""Наблюдатель за отслеживаемыми папками (M2)."""
from __future__ import annotations

import logging
import threading
from pathlib import Path

from watchdog.events import FileSystemEvent, FileSystemEventHandler
from watchdog.observers import Observer

from ..config import Config
from ..db import connect
from . import probe
from .events import EventBus
from .scanner import upsert_file
from .thumbnail import drop_thumbs

log = logging.getLogger(__name__)


class _Handler(FileSystemEventHandler):
    def __init__(self, pending: set[str], lock: threading.Lock) -> None:
        self._pending = pending
        self._lock = lock

    def _add(self, path: str) -> None:
        if not path:
            return
        with self._lock:
            self._pending.add(path)

    def on_created(self, event: FileSystemEvent) -> None:
        self._add(event.src_path)

    def on_deleted(self, event: FileSystemEvent) -> None:
        self._add(event.src_path)

    def on_modified(self, event: FileSystemEvent) -> None:
        self._add(event.src_path)

    def on_moved(self, event: FileSystemEvent) -> None:
        source = getattr(event, "src_path", "")
        target = getattr(event, "dest_path", "")
        self._add(source)
        self._add(target)


class LibraryWatcher:
    def __init__(self, config: Config, bus: EventBus) -> None:
        self.config = config
        self.bus = bus
        self._observer: Observer | None = None
        self._thread: threading.Thread | None = None
        self._pending: set[str] = set()
        self._lock = threading.Lock()
        self._stop = threading.Event()

    def start(self, roots: list[str]) -> None:
        self.stop()
        self._stop.clear()
        observer = Observer()
        handler = _Handler(self._pending, self._lock)
        for root in roots:
            path = Path(root)
            if path.is_dir():
                observer.schedule(handler, str(path), recursive=True)
        observer.start()
        self._observer = observer
        self._thread = threading.Thread(target=self._flush_loop, name="watcher-flush", daemon=True)
        self._thread.start()
        log.info("Watching %d folders", len(roots))

    def stop(self) -> None:
        self._stop.set()
        if self._observer is not None:
            self._observer.stop()
            self._observer.join(timeout=3)
            self._observer = None
        if self._thread is not None:
            self._thread.join(timeout=3)
            self._thread = None

    def _flush_loop(self) -> None:
        while not self._stop.wait(1.5):
            with self._lock:
                pending = list(self._pending)
                self._pending.clear()
            for path in pending:
                try:
                    self._handle(path)
                except Exception:  # pragma: no cover
                    log.exception("Watcher failed for %s", path)

    def _handle(self, path: str) -> None:
        candidate = Path(path)
        if candidate.suffix.lower() not in probe.VIDEO_EXTENSIONS:
            return
        conn = connect(self.config.db_path)
        try:
            if candidate.exists() and candidate.is_file():
                outcome, video_id = upsert_file(conn, self.config, candidate)
                self.bus.publish_threadsafe(
                    "video.status",
                    {"video_id": video_id, "status": outcome, "path": str(candidate)},
                )
            else:
                row = conn.execute("SELECT id FROM videos WHERE path = ?", (str(candidate),)).fetchone()
                if row:
                    conn.execute(
                        "UPDATE videos SET status = 'missing', progress = 0 WHERE id = ?", (row["id"],)
                    )
                    conn.commit()
                    drop_thumbs(self.config, row["id"])
                    self.bus.publish_threadsafe(
                        "video.status",
                        {"video_id": row["id"], "status": "missing", "path": str(candidate)},
                    )
        finally:
            conn.close()
