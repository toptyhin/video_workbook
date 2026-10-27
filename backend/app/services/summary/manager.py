"""M14 rev2: фоновый менеджер смыслового дерева саммари.

Один worker-поток + один активный job; llama-cli запускается подпроцессом
(изоляция CPU/памяти). Состояния job отражают стадии дерева:
``outlining`` (анализ всего текста) → ``splitting`` (рекурсивное деление) →
``summarizing`` (материализация уровней). Менеджер ведёт ``summary_jobs``,
прогресс/статусы по SSE, поддерживает отмену, инвалидацию и crash-recovery.
Арбитраж CPU — внешний gate (``set_compute_gate``), который подключает wiring.
"""
from __future__ import annotations

import logging
import queue as thread_queue
import threading
import time
from collections.abc import Callable
from typing import Any

from ...config import Config
from ...db import connect
from .. import settings_service
from ..events import EventBus
from ..model_resolver import (
    get_model,
    resolve_summary_gguf,
    summary_default_model,
    summary_model_ids,
)
from . import prompts
from .pipeline import FALLBACK_DETAIL, SummaryError, SummaryPipeline

log = logging.getLogger(__name__)

PROGRESS_INTERVAL = 0.25  # SSE ≤ 4 событий/с
GATE_POLL_SECONDS = 0.1
INTERRUPTED_DETAIL = "generation interrupted"
INTERRUPTED_CODE = "summary_interrupted"
DEFAULT_LEVEL = 1
ACTIVE_STATES = ("outlining", "splitting", "summarizing")
# Старые состояния MAP/REDUCE: после миграции 012 их job'ы надо пометить
# прерванными, иначе они навсегда останутся «висящими» в summary_jobs.
LEGACY_ACTIVE_STATES = ("mapping", "reducing")
INTERRUPTED_STATES = ACTIVE_STATES + LEGACY_ACTIVE_STATES
STAGE_STATES = {
    "outline": "outlining",
    "splitting": "splitting",
    "summarizing": "summarizing",
}


class SummaryManager:
    """Единственный владелец фоновой генерации саммари в процессе."""

    def __init__(
        self,
        config: Config,
        bus: EventBus,
        *,
        pipeline: SummaryPipeline | None = None,
    ) -> None:
        self.config = config
        self.bus = bus
        self.pipeline = pipeline or SummaryPipeline(config)
        self._queue: thread_queue.Queue[int] = thread_queue.Queue()
        self._pending: list[int] = []
        self._active: int | None = None
        self._progress: dict[int, dict[str, Any]] = {}
        self._last_progress: dict[int, float] = {}
        self._cancel_event: threading.Event | None = None
        self._cancelled: set[int] = set()
        self._forced: set[int] = set()
        self._lock = threading.RLock()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._started = False
        self._gate: Callable[[], bool] | None = None

    # ---------- lifecycle ----------

    def start(self) -> None:
        if self._started:
            self._ensure_worker()
            return
        self._started = True
        self._recover()
        self._ensure_worker()

    def shutdown(self) -> None:
        self._stop.set()
        with self._lock:
            event = self._cancel_event
            active = self._active
            thread = self._thread
        if event is not None:
            event.set()
        self.pipeline.cancel_active()
        if thread is not None and thread.is_alive():
            thread.join(timeout=5)
        if active is not None:
            self._mark_interrupted(active)
        self._started = False

    def set_compute_gate(self, gate: Callable[[], bool] | None) -> None:
        """Hook арбитража CPU: ``lambda: queue.is_idle()`` подключает wiring."""
        self._gate = gate

    def _ensure_worker(self) -> None:
        with self._lock:
            if self._thread is not None and self._thread.is_alive():
                return
            self._stop.clear()
            self._thread = threading.Thread(
                target=self._worker_loop, name="summary-manager", daemon=True
            )
            self._thread.start()

    # ---------- настройки/модель ----------

    def _settings(self, conn=None):
        own = conn is None
        connection = connect(self.config.db_path) if own else conn
        try:
            return settings_service.get_all(connection)
        finally:
            if own:
                connection.close()

    def _model_id(self, settings: dict[str, Any]) -> str:
        model_id = settings.get("summary.model")
        if isinstance(model_id, str) and model_id in summary_model_ids():
            return model_id
        return summary_default_model()

    def _model_info(self, model_id: str) -> dict[str, Any]:
        entry = get_model(model_id) or {}
        return {
            "id": model_id,
            "label": entry.get("label"),
            "installed": resolve_summary_gguf(self.config, model_id) is not None,
        }

    # ---------- статус ----------

    @staticmethod
    def _job_row(conn, video_id: int):
        return conn.execute(
            "SELECT * FROM summary_jobs WHERE video_id = ?", (video_id,)
        ).fetchone()

    def is_busy(self) -> bool:
        """Есть ли активный/ожидающий job (для проверки занятости модели)."""
        with self._lock:
            return self._active is not None or bool(self._pending)

    def status(self, video_id: int) -> dict[str, Any]:
        """``SummaryResponse`` без HTTP: состояние + уровни дерева + модель."""
        conn = connect(self.config.db_path)
        try:
            video = conn.execute(
                "SELECT id, status FROM videos WHERE id = ?", (video_id,)
            ).fetchone()
            if video is None:
                raise SummaryError("video_not_found", "Видео не найдено", 404)
            settings = settings_service.get_all(conn)
            model_id = self._model_id(settings)
            info = self.pipeline.inspect(video_id, model_id, conn=conn)
            job = self._job_row(conn, video_id)
        finally:
            conn.close()
        with self._lock:
            active = self._active == video_id
            pending = video_id in self._pending
            progress = (
                dict(self._progress[video_id])
                if active and video_id in self._progress
                else None
            )
        job_state = str(job["state"]) if job is not None else None
        job_model = job["model"] if job is not None else None
        job_hash = job["source_hash"] if job is not None else None
        job_detail = job["detail"] if job is not None else None
        job_error = job["error_code"] if job is not None else None
        source_hash = info["source_hash"]
        error_visible = (
            job_state == "error"
            and job_model in (None, model_id)
            and (job_hash is None or job_hash == source_hash)
        )
        interrupted = not active and not pending and job_state in INTERRUPTED_STATES
        if interrupted:
            error_visible = True
            job_detail = INTERRUPTED_DETAIL
            job_error = INTERRUPTED_CODE
        ready = bool(info["ready"])
        if active or pending:
            state = job_state if job_state in ACTIVE_STATES else "outlining"
        elif error_visible:
            state = "error"
        elif ready:
            state = "ready"
        elif info["stale"]:
            state = "stale"
        else:
            state = "absent"
        max_level = int(info["max_level"]) if ready else 0
        levels: dict[str, dict[str, Any]] = {}
        if ready:
            for level in sorted(int(key) for key in info["levels"]):
                entry = info["levels"][level]
                levels[str(level)] = {
                    "level": int(level),
                    "label": entry.get("label"),
                    "blocks": entry["blocks"],
                }
        detail = None
        error_code = None
        if error_visible:
            detail = job_detail
            error_code = job_error
        elif (
            job_state == "ready"
            and job_model in (None, model_id)
            and job_hash == source_hash
        ):
            detail = job_detail
        if active or pending:
            if progress is None:
                progress = {"stage": "outline", "done": 0, "total": 0, "percent": 0.0}
        else:
            progress = None
        return {
            "video_id": video_id,
            "state": state,
            "max_level": max_level,
            "levels": levels,
            "root_summary": info["root_summary"] if ready else None,
            "model": self._model_info(model_id),
            "progress": progress,
            "detail": detail,
            "error_code": error_code,
        }

    # ---------- постановка/отмена ----------

    def request(
        self,
        video_id: int,
        level: int | None = None,
        force: bool = False,
    ) -> dict[str, Any]:
        target = DEFAULT_LEVEL if level is None else level
        if isinstance(target, bool) or not isinstance(target, int) or target < 1:
            raise SummaryError(
                "invalid_level", "Уровень должен быть целым числом ≥ 1", 400
            )
        self.start()
        conn = connect(self.config.db_path)
        try:
            video = conn.execute(
                "SELECT id, status FROM videos WHERE id = ?", (video_id,)
            ).fetchone()
            if video is None:
                raise SummaryError("video_not_found", "Видео не найдено", 404)
            settings = settings_service.get_all(conn)
            if not settings.get("summary.enabled"):
                raise SummaryError(
                    "summary_disabled", "Саммари отключено в настройках", 409
                )
            if video["status"] != "done":
                raise SummaryError(
                    "transcription_not_ready", "Транскрибация ещё не готова", 409
                )
            count = conn.execute(
                "SELECT COUNT(*) FROM segments WHERE video_id = ?", (video_id,)
            ).fetchone()[0]
            if not count:
                raise SummaryError(
                    "transcription_not_ready", "Нет сегментов транскрибации", 409
                )
            model_id = self._model_id(settings)
        finally:
            conn.close()
        if resolve_summary_gguf(self.config, model_id) is None:
            raise SummaryError(
                "model_missing", f"Модель саммари не установлена: {model_id}", 409
            )
        info = self.pipeline.inspect(video_id, model_id)
        if info["ready"]:
            max_level = int(info["max_level"])
            if target > max_level:
                raise SummaryError(
                    "invalid_level", f"Уровень должен быть 1..{max_level}", 400
                )
            if not force:
                self._write_job(
                    video_id,
                    "ready",
                    level=target,
                    model_id=model_id,
                    source_hash=info["source_hash"],
                    max_level=max_level,
                )
                self._publish_state(video_id, "ready")
                return {"video_id": video_id, "state": "ready", "level": target}
        elif target != DEFAULT_LEVEL:
            raise SummaryError(
                "invalid_level",
                "Пока дерево не готово, доступен только уровень 1",
                400,
            )
        with self._lock:
            already_active = self._active == video_id
            already_pending = video_id in self._pending
            if not already_active and not already_pending:
                self._pending.append(video_id)
                if force:
                    self._forced.add(video_id)
        if already_active or already_pending:
            current = self.status(video_id)
            state = (
                current["state"]
                if current["state"] in ACTIVE_STATES
                else "outlining"
            )
            return {"video_id": video_id, "state": state, "level": target}
        self._write_job(
            video_id,
            "outlining",
            level=target,
            model_id=model_id,
            source_hash=info["source_hash"],
        )
        self._publish_state(video_id, "outlining")
        self._queue.put(video_id)
        return {"video_id": video_id, "state": "outlining", "level": target}

    def cancel(self, video_id: int) -> None:
        """Отмена активного/ожидающего job; готовое дерево не трогает."""
        with self._lock:
            active = self._active == video_id
            pending = video_id in self._pending
            if not active and not pending:
                return
            self._cancelled.add(video_id)
            if pending:
                self._pending.remove(video_id)
            event = self._cancel_event if active else None
        if event is not None:
            event.set()
        if active:
            self.pipeline.cancel_active()
        if pending and not active:
            self._delete_job(video_id)
            self._publish_state(video_id, "absent")

    def invalidate(self, video_id: int) -> None:
        """Удаляет дерево/кэш всех моделей видео; при активном job — 409."""
        with self._lock:
            busy = self._active == video_id or video_id in self._pending
        if busy:
            raise SummaryError(
                "generation_in_progress", "Саммари генерируется", 409
            )
        self._clear_video(video_id)
        self._publish_state(video_id, "absent")

    def on_transcription_done(self, video_id: int) -> None:
        """Автогенерация дерева после транскрипции (``summary.auto``)."""
        try:
            settings = self._settings()
            if not settings.get("summary.enabled") or not settings.get("summary.auto"):
                log.info(
                    "Summary auto-generation skipped for video %s: disabled in settings "
                    "(summary.enabled=%s, summary.auto=%s)",
                    video_id,
                    settings.get("summary.enabled"),
                    settings.get("summary.auto"),
                )
                return
            # Переобработка: старый job надо погасить, иначе он допишет дерево
            # для прежних сегментов уже после очистки.
            if self._active == video_id or video_id in self._pending:
                self.cancel(video_id)
                deadline = time.monotonic() + 2.0
                while time.monotonic() < deadline and (
                    self._active == video_id or video_id in self._pending
                ):
                    time.sleep(0.02)
            self._clear_video(video_id, require_video=False)
            self.request(video_id, level=DEFAULT_LEVEL)
        except SummaryError as exc:
            log.info(
                "Summary auto-generation skipped for video %s: %s", video_id, exc.detail
            )
        except Exception:  # pragma: no cover - авто-генерация не должна ломать очередь
            log.warning(
                "Summary auto-generation failed for video %s", video_id, exc_info=True
            )

    # ---------- worker ----------

    def _worker_loop(self) -> None:
        while not self._stop.is_set():
            try:
                video_id = self._queue.get(timeout=0.2)
            except thread_queue.Empty:
                continue
            with self._lock:
                if video_id in self._pending:
                    self._pending.remove(video_id)
                cancelled = video_id in self._cancelled or self._stop.is_set()
                if not cancelled:
                    self._active = video_id
                    self._cancel_event = threading.Event()
                    self._progress[video_id] = {
                        "stage": "outline",
                        "done": 0,
                        "total": 0,
                        "percent": 0.0,
                    }
            if cancelled:
                self._cancelled.discard(video_id)
                continue
            try:
                self._run_one(video_id)
            except Exception:  # pragma: no cover - worker не должен умирать
                log.exception("Summary job crashed for video %s", video_id)
                self._mark_error(
                    video_id, "summary_failed", "Внутренняя ошибка генерации"
                )
            finally:
                with self._lock:
                    self._active = None
                    self._cancel_event = None
                    self._progress.pop(video_id, None)
                    self._last_progress.pop(video_id, None)
                    self._forced.discard(video_id)
                    self._cancelled.discard(video_id)

    def _run_one(self, video_id: int) -> None:
        conn = connect(self.config.db_path)
        try:
            job = self._job_row(conn, video_id)
            settings = settings_service.get_all(conn)
        finally:
            conn.close()
        if job is None or str(job["state"]) not in ACTIVE_STATES:
            return
        if not settings.get("summary.enabled"):
            self._mark_error(
                video_id, "summary_disabled", "Саммари отключено в настройках"
            )
            return
        model_id = str(job["model"] or self._model_id(settings))
        level = int(job["level"] or DEFAULT_LEVEL)
        force = video_id in self._forced
        if not self._wait_for_gate():
            self._mark_cancelled(video_id)
            return
        try:
            result = self.pipeline.generate(
                video_id,
                model_id,
                level=level,
                force=force,
                thinking=str(settings.get("summary.thinking") or "auto"),
                progress=self._on_progress,
                cancel=self._cancel_event,
            )
        except SummaryError as exc:
            cancelled = (
                exc.code == "cancelled"
                or self._stop.is_set()
                or (self._cancel_event is not None and self._cancel_event.is_set())
            )
            if cancelled:
                self._mark_cancelled(video_id)
            else:
                self._mark_error(video_id, exc.code, exc.detail)
            return
        except Exception:
            log.exception("Summary generation failed for video %s", video_id)
            self._mark_error(video_id, "summary_failed", "Ошибка генерации саммари")
            return
        self._mark_ready(video_id, model_id, level, result)

    def _wait_for_gate(self) -> bool:
        while True:
            if self._stop.is_set():
                return False
            with self._lock:
                event = self._cancel_event
            if event is not None and event.is_set():
                return False
            gate = self._gate
            if gate is None:
                return True
            try:
                allowed = bool(gate())
            except Exception:  # pragma: no cover - gate не должен блокировать навсегда
                log.warning("Compute gate failed, proceeding", exc_info=True)
                allowed = True
            if allowed:
                return True
            time.sleep(GATE_POLL_SECONDS)

    # ---------- прогресс/статусы ----------

    def _on_progress(self, stage: str, done: int, total: int) -> None:
        with self._lock:
            video_id = self._active
        if video_id is None:
            return
        total = max(1, int(total))
        done = max(0, min(int(done), total))
        percent = round(done * 100.0 / total, 1)
        payload = {
            "stage": stage,
            "done": done,
            "total": total,
            "percent": percent,
        }
        with self._lock:
            previous = self._progress.get(video_id) or {}
            stage_changed = previous.get("stage") != stage
            self._progress[video_id] = payload
        job_state = STAGE_STATES.get(stage)
        if job_state is not None and stage_changed:
            self._set_job_state(video_id, job_state)
            self._publish_state(video_id, job_state)
        self._publish_progress(
            video_id, payload, force=stage_changed or done in (0, total)
        )

    def _publish_progress(
        self, video_id: int, payload: dict[str, Any], *, force: bool = False
    ) -> None:
        now = time.monotonic()
        with self._lock:
            last = self._last_progress.get(video_id, 0.0)
            if not force and now - last < PROGRESS_INTERVAL:
                return
            self._last_progress[video_id] = now
        self.bus.publish_threadsafe(
            "summary.progress", {"video_id": video_id, **payload}
        )

    def _publish_state(
        self, video_id: int, state: str, detail: str | None = None
    ) -> None:
        payload: dict[str, Any] = {"video_id": video_id, "state": state}
        if detail:
            payload["detail"] = detail
        self.bus.publish_threadsafe("summary.state", payload)

    # ---------- запись summary_jobs ----------

    def _write_job(
        self,
        video_id: int,
        state: str,
        *,
        level: int | None = None,
        model_id: str | None = None,
        source_hash: str | None = None,
        detail: str | None = None,
        error_code: str | None = None,
        max_level: int | None = None,
    ) -> None:
        conn = connect(self.config.db_path)
        try:
            conn.execute(
                "INSERT INTO summary_jobs(video_id, state, level, max_level, detail, "
                "error_code, source_hash, model, prompt_version, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now')) "
                "ON CONFLICT(video_id) DO UPDATE SET state = excluded.state, "
                "level = excluded.level, max_level = excluded.max_level, "
                "detail = excluded.detail, error_code = excluded.error_code, "
                "source_hash = excluded.source_hash, model = excluded.model, "
                "prompt_version = excluded.prompt_version, updated_at = datetime('now')",
                (
                    video_id,
                    state,
                    level,
                    max_level,
                    detail,
                    error_code,
                    source_hash,
                    model_id,
                    prompts.PROMPT_VERSION,
                ),
            )
            conn.commit()
        finally:
            conn.close()

    def _set_job_state(self, video_id: int, state: str) -> None:
        conn = connect(self.config.db_path)
        try:
            conn.execute(
                "UPDATE summary_jobs SET state = ?, updated_at = datetime('now') "
                "WHERE video_id = ?",
                (state, video_id),
            )
            conn.commit()
        finally:
            conn.close()

    def _delete_job(self, video_id: int) -> None:
        conn = connect(self.config.db_path)
        try:
            conn.execute("DELETE FROM summary_jobs WHERE video_id = ?", (video_id,))
            conn.commit()
        finally:
            conn.close()

    def _clear_video(self, video_id: int, *, require_video: bool = True) -> None:
        conn = connect(self.config.db_path)
        try:
            if require_video:
                row = conn.execute(
                    "SELECT id FROM videos WHERE id = ?", (video_id,)
                ).fetchone()
                if row is None:
                    raise SummaryError("video_not_found", "Видео не найдено", 404)
            conn.execute("DELETE FROM summary_nodes WHERE video_id = ?", (video_id,))
            conn.execute("DELETE FROM summary_levels WHERE video_id = ?", (video_id,))
            conn.execute("DELETE FROM summary_jobs WHERE video_id = ?", (video_id,))
            conn.commit()
        finally:
            conn.close()

    def _mark_ready(
        self,
        video_id: int,
        model_id: str,
        level: int,
        result: dict[str, Any],
    ) -> None:
        detail = FALLBACK_DETAIL if result.get("fallback") else None
        max_level = int(result.get("max_level") or level)
        self._write_job(
            video_id,
            "ready",
            level=level,
            model_id=model_id,
            source_hash=result.get("source_hash"),
            detail=detail,
            max_level=max_level,
        )
        self._publish_state(video_id, "ready", detail)

    def _mark_error(self, video_id: int, code: str, detail: str) -> None:
        self._write_job(
            video_id,
            "error",
            detail=str(detail)[:2000],
            error_code=code or "summary_failed",
        )
        self._publish_state(video_id, "error", str(detail)[:2000])

    def _mark_cancelled(self, video_id: int) -> None:
        self._delete_job(video_id)
        self._publish_state(video_id, "absent")

    def _mark_interrupted(self, video_id: int) -> None:
        conn = connect(self.config.db_path)
        try:
            conn.execute(
                "UPDATE summary_jobs SET state = 'error', detail = ?, "
                "error_code = ?, updated_at = datetime('now') "
                "WHERE video_id = ? AND state IN "
                "('outlining', 'splitting', 'summarizing', 'mapping', 'reducing')",
                (INTERRUPTED_DETAIL, INTERRUPTED_CODE, video_id),
            )
            conn.commit()
        finally:
            conn.close()

    def _recover(self) -> None:
        """Crash-recovery: зависшие активные стадии → error."""
        conn = connect(self.config.db_path)
        try:
            rows = conn.execute(
                "SELECT video_id FROM summary_jobs "
                "WHERE state IN "
                "('outlining', 'splitting', 'summarizing', 'mapping', 'reducing')"
            ).fetchall()
            conn.execute(
                "UPDATE summary_jobs SET state = 'error', detail = ?, error_code = ?, "
                "updated_at = datetime('now') "
                "WHERE state IN "
                "('outlining', 'splitting', 'summarizing', 'mapping', 'reducing')",
                (INTERRUPTED_DETAIL, INTERRUPTED_CODE),
            )
            conn.commit()
        finally:
            conn.close()
        for row in rows:
            self._publish_state(int(row["video_id"]), "error", INTERRUPTED_DETAIL)


__all__ = ["SummaryError", "SummaryManager"]
