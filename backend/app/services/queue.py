"""FIFO-очередь транскрипции: один процесс, прогресс через SSE (M3)."""
from __future__ import annotations

import logging
import multiprocessing
import queue as thread_queue
import threading
import time
from pathlib import Path
from typing import Any

from ..config import Config
from ..db import connect
from . import transcriber
from .events import EventBus

log = logging.getLogger(__name__)

TERMINAL_OK = {"done"}
ACTIVE = {"queued", "processing"}


class QueueError(ValueError):
    def __init__(self, code: str, detail: str, status_code: int = 409) -> None:
        super().__init__(detail)
        self.code = code
        self.detail = detail
        self.status_code = status_code


class TranscriptionQueue:
    def __init__(self, config: Config, bus: EventBus) -> None:
        self.config = config
        self.bus = bus
        self._queue: thread_queue.Queue[int] = thread_queue.Queue()
        self._pending: list[int] = []
        self._cancelled: set[int] = set()
        self._current: int | None = None
        self._current_progress = 0.0
        self._cancel_events: dict[int, Any] = {}
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    # ---------- lifecycle ----------

    def start(self) -> None:
        self._recover()
        self._thread = threading.Thread(target=self._worker_loop, name="transcription-queue", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        with self._lock:
            event = self._cancel_events.get(self._current) if self._current is not None else None
        if event is not None:
            event.set()
        if self._thread:
            self._thread.join(timeout=5)

    def _recover(self) -> None:
        conn = connect(self.config.db_path)
        try:
            conn.execute("UPDATE videos SET status = 'queued', progress = 0 WHERE status = 'processing'")
            conn.commit()
            rows = conn.execute("SELECT id FROM videos WHERE status = 'queued' ORDER BY id").fetchall()
        finally:
            conn.close()
        for row in rows:
            with self._lock:
                if row["id"] not in self._pending:
                    self._pending.append(row["id"])
                    self._queue.put(row["id"])

    # ---------- public API ----------

    def enqueue(self, ids: list[int]) -> dict[str, Any]:
        if not ids:
            raise QueueError("invalid_ids", "Пустой список ids", 400)
        queued: list[int] = []
        skipped: list[dict[str, Any]] = []
        conn = connect(self.config.db_path)
        try:
            for video_id in ids:
                row = conn.execute("SELECT id, status FROM videos WHERE id = ?", (video_id,)).fetchone()
                if row is None:
                    skipped.append({"id": video_id, "reason": "not_found"})
                    continue
                status = row["status"]
                if status in ACTIVE:
                    skipped.append({"id": video_id, "reason": "already_queued"})
                    continue
                conn.execute(
                    "UPDATE videos SET status = 'queued', progress = 0, error = NULL WHERE id = ?",
                    (video_id,),
                )
                queued.append(video_id)
            conn.commit()
        finally:
            conn.close()
        for video_id in queued:
            with self._lock:
                if video_id not in self._pending:
                    self._pending.append(video_id)
                    self._queue.put(video_id)
            self._publish_status(video_id, "queued")
        self._publish_queue_state()
        return {"queued": queued, "skipped": skipped}

    def cancel(self, video_id: int) -> dict[str, Any]:
        with self._lock:
            current = self._current
            pending = video_id in self._pending
            event = self._cancel_events.get(video_id)
        conn = connect(self.config.db_path)
        try:
            row = conn.execute("SELECT id, status FROM videos WHERE id = ?", (video_id,)).fetchone()
            if row is None:
                raise QueueError("not_found", "Видео не найдено", 404)
            if current == video_id and event is not None:
                event.set()
                return {"id": video_id, "status": "processing"}
            if pending:
                with self._lock:
                    self._cancelled.add(video_id)
                    if video_id in self._pending:
                        self._pending.remove(video_id)
                conn.execute(
                    "UPDATE videos SET status = 'pending', progress = 0 WHERE id = ?", (video_id,)
                )
                conn.commit()
                self._publish_status(video_id, "pending")
                self._publish_queue_state()
                return {"id": video_id, "status": "pending"}
            if row["status"] in {"done", "error"}:
                raise QueueError("invalid_state", "Файл уже обработан", 409)
            raise QueueError("invalid_state", "Файл не в очереди", 409)
        finally:
            conn.close()

    def state(self) -> dict[str, Any]:
        with self._lock:
            current = self._current
            pending = list(self._pending)
        body: dict[str, Any] = {
            "current": None,
            "pending": [{"video_id": vid, "position": index + 1} for index, vid in enumerate(pending)],
            "total": len(pending),
        }
        if current is not None:
            conn = connect(self.config.db_path)
            try:
                row = conn.execute("SELECT id, title, progress FROM videos WHERE id = ?", (current,)).fetchone()
            finally:
                conn.close()
            if row:
                body["current"] = {
                    "video_id": row["id"],
                    "title": row["title"] or Path(row["id"]).name,
                    "progress": float(row["progress"] or 0),
                }
        return body

    # ---------- internals ----------

    def _worker_loop(self) -> None:
        while not self._stop.is_set():
            try:
                video_id = self._queue.get(timeout=0.5)
            except thread_queue.Empty:
                continue
            with self._lock:
                if video_id in self._cancelled:
                    self._cancelled.discard(video_id)
                    continue
                if video_id in self._pending:
                    self._pending.remove(video_id)
            try:
                self._run_one(video_id)
            except Exception:  # pragma: no cover - очередь не должна умирать
                log.exception("Transcription task failed for video %s", video_id)
                self._mark_error(video_id, "Внутренняя ошибка обработки")
            finally:
                with self._lock:
                    self._current = None
                    self._current_progress = 0.0
                self._publish_queue_state()

    def _run_one(self, video_id: int) -> None:
        conn = connect(self.config.db_path)
        try:
            row = conn.execute("SELECT * FROM videos WHERE id = ?", (video_id,)).fetchone()
        finally:
            conn.close()
        if row is None:
            return
        video_path = row["path"]
        if not Path(video_path).exists():
            self._mark_error(video_id, "Файл не найден на диске")
            return
        with self._lock:
            self._current = video_id
            self._current_progress = 0.0
        conn = connect(self.config.db_path)
        try:
            conn.execute(
                "UPDATE videos SET status = 'processing', progress = 0, error = NULL WHERE id = ?",
                (video_id,),
            )
            conn.commit()
            settings = {
                row_["key"]: row_["value"]
                for row_ in conn.execute("SELECT key, value FROM settings")
            }
        finally:
            conn.close()
        self._publish_status(video_id, "processing")
        self._publish_queue_state()

        model_name = _setting(settings, "whisper_model", "small")
        language = _setting(settings, "language", "auto")
        model_dir = self.config.resources_dir / "models" / f"faster-whisper-{model_name}"
        wav_path = self.config.tmp_dir / f"{video_id}.wav"
        ctx = multiprocessing.get_context("spawn")
        cancel_event = ctx.Event()
        progress_queue = ctx.Queue()
        result_queue = ctx.Queue()
        error_queue = ctx.Queue()
        with self._lock:
            self._cancel_events[video_id] = cancel_event
        process = ctx.Process(
            target=transcriber.transcribe_task,
            kwargs={
                "video_id": video_id,
                "video_path": video_path,
                "wav_path": str(wav_path),
                "ffmpeg": self.config.ffmpeg,
                "model_name": model_name,
                "model_dir": str(model_dir) if model_dir.exists() else None,
                "language": language,
                "duration_ms": row["duration_ms"],
                "progress_queue": progress_queue,
                "result_queue": result_queue,
                "error_queue": error_queue,
                "cancel_event": cancel_event,
            },
            daemon=True,
        )
        process.start()
        cancelled = False
        last_db_update = 0.0
        try:
            while process.is_alive():
                if cancel_event.is_set():
                    cancelled = True
                    process.terminate()
                    process.join(timeout=3)
                    break
                now = time.monotonic()
                try:
                    while True:
                        progress = progress_queue.get_nowait()
                        with self._lock:
                            self._current_progress = float(progress)
                        if now - last_db_update > 0.5:
                            self._update_progress(video_id, float(progress))
                            last_db_update = now
                except thread_queue.Empty:
                    pass
                process.join(timeout=0.2)
            process.join(timeout=2)
            if cancelled:
                self._mark_pending(video_id)
                return
            if process.exitcode == 0 and not result_queue.empty():
                result = result_queue.get(timeout=5)
                self._store_result(video_id, result, model_name)
                return
            error_message = "Обработка не удалась"
            try:
                if not error_queue.empty():
                    error_message = str(error_queue.get(timeout=2)).splitlines()[0][:1000]
            except thread_queue.Empty:
                pass
            self._mark_error(video_id, error_message)
        finally:
            with self._lock:
                self._cancel_events.pop(video_id, None)
            for queue_ in (progress_queue, result_queue, error_queue):
                queue_.close()
            wav_path.unlink(missing_ok=True)

    def _store_result(self, video_id: int, result: dict[str, Any], model_name: str) -> None:
        conn = connect(self.config.db_path)
        try:
            conn.execute("DELETE FROM segments WHERE video_id = ?", (video_id,))
            for segment in result.get("segments", []):
                conn.execute(
                    "INSERT INTO segments(video_id, start_ms, end_ms, text) VALUES (?, ?, ?, ?)",
                    (video_id, segment["start_ms"], segment["end_ms"], segment["text"]),
                )
            conn.execute(
                "UPDATE videos SET status = 'done', progress = 1.0, error = NULL, "
                "processed_at = datetime('now'), lang = ?, model = ?, headline = ? WHERE id = ?",
                (
                    result.get("lang"),
                    model_name,
                    result.get("headline"),
                    video_id,
                ),
            )
            conn.commit()
        finally:
            conn.close()
        self._publish_status(video_id, "done")
        self.bus.publish("video.progress", {"video_id": video_id, "progress": 1.0})

    def _mark_error(self, video_id: int, message: str) -> None:
        conn = connect(self.config.db_path)
        try:
            conn.execute(
                "UPDATE videos SET status = 'error', error = ?, progress = 0 WHERE id = ?",
                (message[:2000], video_id),
            )
            conn.commit()
        finally:
            conn.close()
        self._publish_status(video_id, "error", message)

    def _mark_pending(self, video_id: int) -> None:
        conn = connect(self.config.db_path)
        try:
            conn.execute("UPDATE videos SET status = 'pending', progress = 0 WHERE id = ?", (video_id,))
            conn.commit()
        finally:
            conn.close()
        self._publish_status(video_id, "pending")

    def _update_progress(self, video_id: int, progress: float) -> None:
        conn = connect(self.config.db_path)
        try:
            conn.execute("UPDATE videos SET progress = ? WHERE id = ?", (progress, video_id))
            conn.commit()
        finally:
            conn.close()
        self.bus.publish_threadsafe("video.progress", {"video_id": video_id, "progress": progress})

    def _publish_status(self, video_id: int, status: str, error: str | None = None) -> None:
        self.bus.publish_threadsafe(
            "video.status", {"video_id": video_id, "status": status, "error": error}
        )

    def _publish_queue_state(self) -> None:
        with self._lock:
            current = self._current
            pending = list(self._pending)
            progress = self._current_progress
        self.bus.publish_threadsafe(
            "queue.state",
            {
                "current_video_id": current,
                "current_progress": progress,
                "pending_ids": pending,
                "total": len(pending),
            },
        )


def _setting(settings: dict[str, str], key: str, default: str) -> str:
    import json

    raw = settings.get(key)
    if raw is None:
        return default
    try:
        value = json.loads(raw)
    except json.JSONDecodeError:
        return default
    return value if isinstance(value, str) else default
