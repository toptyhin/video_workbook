"""Сессии записи экрана/окна (M11).

Принимает WebM-чанки от renderer (MediaRecorder), по finish() финализирует
файл через ffmpeg (mux/mix с системным звуком) в `recordings/*.webm`, атомарно
публикует его в библиотеку (`videos`, status pending) и в таблицу `recordings`.

Все публичные методы потокобезопасны: FastAPI выполняет sync-эндпоинты в
threadpool, поэтому состояние сессий защищено RLock, а длительные операции
(ffmpeg) выполняются вне блокировки.
"""
from __future__ import annotations

import logging
import os
import re
import shutil
import subprocess
import threading
import time
import uuid
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

from ..config import Config
from ..db import connect
from . import media_info, scanner, system_audio
from .events import EventBus

log = logging.getLogger(__name__)

MAX_CHUNK_BYTES = 32 * 1024 * 1024
MAX_TITLE_LEN = 200
MAX_SOURCE_TITLE_LEN = 300
FINALIZE_TIMEOUT = 180
FINISHED_TTL = 3600.0
SESSION_ID_RE = re.compile(r"^[0-9a-f]{32}$")
SOURCE_KINDS = frozenset({"screen", "window"})
STATE_RECORDING = "recording"
STATE_PAUSED = "paused"
STATE_FINALIZING = "finalizing"
STATE_FINISHED = "finished"
STATE_CANCELLED = "cancelled"
SOURCE_LABELS = {"screen": "Запись экрана", "window": "Запись окна"}


class RecordingError(ValueError):
    def __init__(self, code: str, detail: str, status_code: int = 400) -> None:
        super().__init__(detail)
        self.code = code
        self.detail = detail
        self.status_code = status_code


@dataclass
class _Session:
    id: str
    source_kind: str
    source_title: str | None
    title: str | None
    mime_type: str
    system_audio_requested: bool
    part_path: Path
    state: str = STATE_RECORDING
    bytes_received: int = 0
    duration_ms: int | None = None
    size_bytes: int | None = None
    video_id: int | None = None
    system_audio_active: bool = False
    system_audio_detail: str | None = None
    capture: system_audio.SystemAudioCapture | None = None
    finished_at: float | None = None
    final_path: Path | None = None
    playback_mode: str | None = None


def _invalid(detail: str, code: str = "invalid_payload") -> RecordingError:
    return RecordingError(code, detail, 400)


def not_found(session_id: str) -> RecordingError:
    return RecordingError("recording_not_found", f"Сессия записи не найдена: {session_id}", 404)


def _validate_start(payload: Any) -> tuple[str, str | None, str | None, str, bool]:
    if not isinstance(payload, dict):
        raise _invalid("Тело запроса должно быть JSON-объектом")
    source_kind = payload.get("source_kind")
    if not isinstance(source_kind, str) or source_kind not in SOURCE_KINDS:
        raise _invalid("source_kind должен быть 'screen' или 'window'", "invalid_source")
    source_title = payload.get("source_title")
    if source_title is not None:
        if not isinstance(source_title, str):
            raise _invalid("source_title должен быть строкой")
        source_title = source_title.strip() or None
        if source_title is not None and len(source_title) > MAX_SOURCE_TITLE_LEN:
            raise _invalid(f"source_title длиннее {MAX_SOURCE_TITLE_LEN} символов")
    title = payload.get("title")
    if title is not None:
        if not isinstance(title, str):
            raise _invalid("title должен быть строкой")
        title = title.strip() or None
        if title is not None and len(title) > MAX_TITLE_LEN:
            raise _invalid(f"title длиннее {MAX_TITLE_LEN} символов")
    mime_type = payload.get("mime_type")
    if not isinstance(mime_type, str) or not mime_type.strip().lower().startswith("video/webm"):
        raise _invalid("mime_type должен начинаться с video/webm", "invalid_mime")
    mime_type = mime_type.strip()
    system_audio_requested = payload.get("system_audio", False)
    if not isinstance(system_audio_requested, bool):
        raise _invalid("system_audio должен быть boolean")
    return source_kind, source_title, title, mime_type, system_audio_requested


def _validate_finish(payload: Any) -> tuple[int | None, int | None, int | None]:
    if payload is None:
        return None, None, None
    if not isinstance(payload, dict):
        raise _invalid("Тело запроса должно быть JSON-объектом")
    duration_ms = payload.get("duration_ms")
    if duration_ms is not None:
        try:
            duration_ms = int(duration_ms)
        except (TypeError, ValueError) as exc:
            raise _invalid("duration_ms должен быть числом") from exc
        if duration_ms < 0:
            raise _invalid("duration_ms не может быть отрицательным")
    width = payload.get("width")
    if width is not None:
        try:
            width = int(width)
        except (TypeError, ValueError) as exc:
            raise _invalid("width должен быть числом") from exc
        if width <= 0:
            raise _invalid("width должен быть положительным")
    height = payload.get("height")
    if height is not None:
        try:
            height = int(height)
        except (TypeError, ValueError) as exc:
            raise _invalid("height должен быть числом") from exc
        if height <= 0:
            raise _invalid("height должен быть положительным")
    return duration_ms, width, height


def _default_title(source_kind: str) -> str:
    label = SOURCE_LABELS.get(source_kind, "Запись")
    return f"{label} {datetime.now().strftime('%d.%m.%Y %H:%M')}"


def _tail(process: subprocess.CompletedProcess[str]) -> str:
    lines = (process.stderr or "").strip().splitlines()
    return lines[-1] if lines else ""


class RecordingManager:
    def __init__(self, config: Config, bus: EventBus) -> None:
        self.config = config
        self.bus = bus
        self._lock = threading.RLock()
        self._sessions: dict[str, _Session] = {}

    # ---------- lifecycle ----------

    def cleanup_stale_tmp(self) -> int:
        """Удаляет временные файлы аварийных сессий; вызывается при старте backend."""
        directory = self.config.recording_tmp_dir
        directory.mkdir(parents=True, exist_ok=True)
        removed = 0
        for entry in list(directory.iterdir()):
            try:
                if entry.is_dir():
                    shutil.rmtree(entry, ignore_errors=True)
                else:
                    entry.unlink(missing_ok=True)
                removed += 1
            except OSError as exc:  # pragma: no cover - редкая ошибка ФС
                log.warning("Failed to remove stale recording file %s: %s", entry, exc)
        if removed:
            log.info("Removed %s stale recording temp entries", removed)
        return removed

    def shutdown(self) -> None:
        with self._lock:
            sessions = list(self._sessions.values())
            self._sessions.clear()
        for session in sessions:
            capture = session.capture
            session.capture = None
            if capture is not None:
                try:
                    capture.stop()
                except Exception:  # pragma: no cover - защита при завершении
                    log.exception("Failed to stop system audio capture on shutdown")
        system_audio.stop_all()

    # ---------- public API ----------

    def capabilities(self) -> dict[str, Any]:
        return {
            "system_audio": system_audio.capabilities(self.config),
            "max_chunk_bytes": MAX_CHUNK_BYTES,
        }

    def start(self, payload: Any) -> dict[str, Any]:
        source_kind, source_title, title, mime_type, want_system = _validate_start(payload)
        self._prune_finished()
        self.config.recording_tmp_dir.mkdir(parents=True, exist_ok=True)
        with self._lock:
            session_id = uuid.uuid4().hex
            while session_id in self._sessions:
                session_id = uuid.uuid4().hex
        part_path = self.config.recording_tmp_dir / f"{session_id}.webm.part"
        part_path.open("wb").close()
        capture: system_audio.SystemAudioCapture | None = None
        audio_active = False
        audio_detail: str | None = None
        if want_system:
            candidate = system_audio.SystemAudioCapture(self.config, session_id)
            result = candidate.start()
            audio_active = bool(result.get("active"))
            audio_detail = result.get("detail")
            if audio_active:
                capture = candidate
        session = _Session(
            id=session_id,
            source_kind=source_kind,
            source_title=source_title,
            title=title,
            mime_type=mime_type,
            system_audio_requested=want_system,
            part_path=part_path,
            system_audio_active=audio_active,
            system_audio_detail=audio_detail,
            capture=capture,
        )
        with self._lock:
            self._sessions[session_id] = session
        log.info(
            "Recording session %s started (kind=%s, system_audio=%s)",
            session_id,
            source_kind,
            audio_active,
        )
        return {
            "recording_id": session_id,
            "system_audio": {"active": audio_active, "detail": audio_detail},
        }

    def append_chunk(self, session_id: str, data: bytes) -> dict[str, Any]:
        if not SESSION_ID_RE.match(session_id or ""):
            raise not_found(session_id)
        if not data:
            raise _invalid("Пустой чанк", "invalid_chunk")
        if len(data) > MAX_CHUNK_BYTES:
            raise RecordingError(
                "chunk_too_large",
                f"Чанк больше {MAX_CHUNK_BYTES} байт",
                413,
            )
        with self._lock:
            session = self._sessions.get(session_id)
            if session is None:
                raise not_found(session_id)
            self._ensure_accepting_chunks(session)
            try:
                with session.part_path.open("ab") as handle:
                    handle.write(data)
            except OSError as exc:
                log.exception("Failed to append recording chunk %s", session_id)
                raise RecordingError("chunk_write_failed", f"Ошибка записи чанка: {exc}", 500) from exc
            session.bytes_received += len(data)
        return {"bytes": len(data)}

    def pause(self, session_id: str) -> None:
        self._set_paused(session_id, paused=True)

    def resume(self, session_id: str) -> None:
        self._set_paused(session_id, paused=False)

    def state(self, session_id: str) -> dict[str, Any]:
        with self._lock:
            session = self._sessions.get(session_id)
            if session is None:
                raise not_found(session_id)
            return {
                "recording_id": session.id,
                "state": session.state,
                "bytes": session.bytes_received,
                "duration_ms": session.duration_ms,
                "system_audio": bool(session.system_audio_active),
            }

    def finish(self, session_id: str, payload: Any = None) -> dict[str, Any]:
        if not SESSION_ID_RE.match(session_id or ""):
            raise not_found(session_id)
        duration_ms, _width, _height = _validate_finish(payload)
        with self._lock:
            session = self._sessions.get(session_id)
            if session is None:
                raise not_found(session_id)
            if session.state in (STATE_FINALIZING, STATE_FINISHED):
                raise RecordingError(
                    "recording_finished",
                    "Сессия уже финализируется или завершена",
                    409,
                )
            session.state = STATE_FINALIZING
            if duration_ms is not None:
                session.duration_ms = duration_ms
            capture = session.capture
            session.capture = None
        audio_path: Path | None = None
        if capture is not None:
            try:
                audio_path = capture.stop()
            except Exception:  # pragma: no cover - защита от сбоя ffmpeg
                log.exception("Failed to stop system audio for %s", session_id)
                audio_path = None
        try:
            self._finalize(session, audio_path)
        except RecordingError:
            self._discard_session(session)
            raise
        except Exception as exc:  # pragma: no cover - неожиданный сбой
            log.exception("Recording finalize failed: %s", session_id)
            self._discard_session(session)
            raise RecordingError("finalize_failed", f"Финализация не удалась: {exc}", 500) from exc
        finally:
            self._cleanup_files(session, audio_path)
        with self._lock:
            session.state = STATE_FINISHED
            session.finished_at = time.monotonic()
            return {
                "video_id": session.video_id,
                "title": session.title,
                "duration_ms": session.duration_ms,
                "size_bytes": session.size_bytes,
                "path": str(session.final_path) if session.final_path else None,
                "playback_mode": session.playback_mode,
            }

    def cancel(self, session_id: str) -> None:
        """Идемпотентная отмена: удаляет сессию и временные файлы."""
        if not SESSION_ID_RE.match(session_id or ""):
            return
        with self._lock:
            session = self._sessions.get(session_id)
            if session is None:
                return
            if session.state == STATE_FINALIZING:
                # нельзя удалять временные файлы, пока ffmpeg/регистрация работают
                raise RecordingError(
                    "recording_finished",
                    "Сессия финализируется; отмена невозможна",
                    409,
                )
            self._sessions.pop(session_id, None)
            if session.state == STATE_FINISHED:
                # финальный файл уже в библиотеке — отмена идемпотентна, но ничего не удаляет
                return
            session.state = STATE_CANCELLED
            capture = session.capture
            session.capture = None
        if capture is not None:
            try:
                capture.stop()
            except Exception:  # pragma: no cover - защита при отмене
                log.exception("Failed to stop system audio for cancelled %s", session_id)
        self._cleanup_files(session, None)
        log.info("Recording session %s cancelled", session_id)

    # ---------- internals ----------

    def _ensure_accepting_chunks(self, session: _Session) -> None:
        if session.state in (STATE_FINALIZING, STATE_FINISHED):
            raise RecordingError(
                "recording_finished",
                "Сессия уже финализируется или завершена",
                409,
            )
        if session.state not in (STATE_RECORDING, STATE_PAUSED):
            raise not_found(session.id)

    def _set_paused(self, session_id: str, *, paused: bool) -> None:
        if not SESSION_ID_RE.match(session_id or ""):
            raise not_found(session_id)
        with self._lock:
            session = self._sessions.get(session_id)
            if session is None:
                raise not_found(session_id)
            if session.state in (STATE_FINALIZING, STATE_FINISHED):
                raise RecordingError(
                    "recording_finished",
                    "Сессия уже финализируется или завершена",
                    409,
                )
            session.state = STATE_PAUSED if paused else STATE_RECORDING
            capture = session.capture
        if capture is not None:
            if paused:
                capture.pause()
            else:
                capture.resume()

    def _prune_finished(self) -> None:
        now = time.monotonic()
        with self._lock:
            stale = [
                session_id
                for session_id, session in self._sessions.items()
                if session.state == STATE_FINISHED
                and session.finished_at is not None
                and now - session.finished_at > FINISHED_TTL
            ]
            for session_id in stale:
                self._sessions.pop(session_id, None)

    def _finalize(self, session: _Session, audio_path: Path | None) -> None:
        part = session.part_path
        if not part.exists() or part.stat().st_size <= 0:
            raise RecordingError(
                "recording_empty",
                "Запись пуста: не получено ни одного чанка",
                400,
            )
        final_path = self._final_path()
        self._finalize_media(session, part, audio_path, final_path)
        try:
            self._validate_media(final_path)
            with self._lock:
                session.final_path = final_path
            result = self._register(session, final_path)
        except RecordingError:
            final_path.unlink(missing_ok=True)
            raise
        with self._lock:
            session.video_id = int(result["video_id"])
            session.title = str(result["title"])
            session.duration_ms = int(result["duration_ms"])
            session.size_bytes = int(result["size_bytes"])
            session.playback_mode = str(result["playback_mode"])

    def _validate_media(self, final_path: Path) -> None:
        """Финальный файл должен содержать читаемый видеопоток (иначе — 400)."""
        try:
            streams = media_info.probe_streams(str(final_path), self.config.ffprobe)
        except media_info.MediaInfoError as exc:
            raise RecordingError(
                "invalid_recording",
                f"Файл записи повреждён: {exc}",
                400,
            ) from exc
        if streams.video_codec is None:
            raise RecordingError("invalid_recording", "В записи нет видеопотока", 400)

    def _final_path(self) -> Path:
        directory = self.config.recordings_dir
        directory.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        while True:
            candidate = directory / f"rec-{stamp}-{uuid.uuid4().hex[:8]}.webm"
            if not candidate.exists():
                return candidate

    def _part_has_audio(self, part: Path) -> bool:
        try:
            info = media_info.probe_streams(str(part), self.config.ffprobe)
        except media_info.MediaInfoError:
            return False
        return info.audio_codec is not None

    def _ffmpeg_command(self, part: Path, audio_path: Path | None, output: Path) -> list[str]:
        command = ["-hide_banner", "-loglevel", "error", "-y", "-i", str(part)]
        has_system_audio = audio_path is not None and audio_path.exists() and audio_path.stat().st_size > 0
        if has_system_audio and audio_path is not None:
            if self._part_has_audio(part):
                command.extend(
                    [
                        "-i",
                        str(audio_path),
                        "-filter_complex",
                        "[0:a][1:a]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0[a]",
                        "-map",
                        "0:v",
                        "-map",
                        "[a]",
                        "-c:v",
                        "copy",
                        "-c:a",
                        "libopus",
                        "-b:a",
                        "128k",
                        "-shortest",
                        str(output),
                    ]
                )
            else:
                command.extend(
                    [
                        "-i",
                        str(audio_path),
                        "-map",
                        "0:v",
                        "-map",
                        "1:a",
                        "-c",
                        "copy",
                        "-shortest",
                        str(output),
                    ]
                )
        else:
            command.extend(["-c", "copy", str(output)])
        return command

    def _finalize_media(
        self,
        session: _Session,
        part: Path,
        audio_path: Path | None,
        final_path: Path,
    ) -> None:
        output = self.config.recording_tmp_dir / f"{session.id}.final.webm"
        output.unlink(missing_ok=True)
        command = [self.config.ffmpeg, *self._ffmpeg_command(part, audio_path, output)]
        ok = False
        try:
            proc = subprocess.run(
                command,
                capture_output=True,
                text=True,
                timeout=FINALIZE_TIMEOUT,
                check=False,
            )
            ok = proc.returncode == 0 and output.exists() and output.stat().st_size > 0
            if not ok:
                log.warning(
                    "Recording %s: ffmpeg finalize failed (rc=%s): %s",
                    session.id,
                    proc.returncode,
                    _tail(proc)[-500:],
                )
        except (OSError, subprocess.TimeoutExpired) as exc:
            log.warning("Recording %s: ffmpeg finalize error: %s", session.id, exc)
        if not ok:
            # Fallback: WebM-чанки уже валидный поток — копируем как есть.
            output.unlink(missing_ok=True)
            try:
                shutil.copyfile(part, output)
            except OSError as exc:
                raise RecordingError("finalize_failed", f"Не удалось сохранить запись: {exc}", 500) from exc
            log.warning("Recording %s: used copy fallback without remux", session.id)
        try:
            os.replace(output, final_path)
        except OSError as exc:
            output.unlink(missing_ok=True)
            raise RecordingError("finalize_failed", f"Не удалось сохранить запись: {exc}", 500) from exc

    def _register(self, session: _Session, final_path: Path) -> dict[str, Any]:
        title = session.title or _default_title(session.source_kind)
        conn = connect(self.config.db_path)
        try:
            _outcome, video_id = scanner.upsert_file(conn, self.config, final_path)
            if video_id is None:
                raise RecordingError(
                    "finalize_failed",
                    "Не удалось зарегистрировать запись в библиотеке",
                    500,
                )
            conn.execute("UPDATE videos SET title = ? WHERE id = ?", (title, video_id))
            row = conn.execute(
                "SELECT duration_ms, size_bytes FROM videos WHERE id = ?",
                (video_id,),
            ).fetchone()
            # ffmpeg-remux даёт точную длительность; клиентский таймер — только fallback.
            probed_duration = int((row["duration_ms"] if row else 0) or 0)
            duration_ms = probed_duration if probed_duration > 0 else int(session.duration_ms or 0)
            size_bytes = int(final_path.stat().st_size)
            conn.execute(
                "INSERT INTO recordings(id, video_id, source_kind, source_title, mime_type, "
                "system_audio, duration_ms, size_bytes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    session.id,
                    video_id,
                    session.source_kind,
                    session.source_title,
                    session.mime_type,
                    1 if session.system_audio_active else 0,
                    duration_ms,
                    size_bytes,
                ),
            )
            conn.commit()
        finally:
            conn.close()
        try:
            playback_mode = media_info.probe_streams(str(final_path), self.config.ffprobe).mode
        except media_info.MediaInfoError:
            playback_mode = "unknown"
        payload = {
            "video_id": video_id,
            "title": title,
            "path": str(final_path),
            "duration_ms": duration_ms,
            "size_bytes": size_bytes,
        }
        self.bus.publish_threadsafe("recording.finished", payload)
        self.bus.publish_threadsafe(
            "video.status",
            {"video_id": video_id, "status": "added", "path": str(final_path)},
        )
        log.info("Recording %s finalized: video %s (%s bytes)", session.id, video_id, size_bytes)
        return {**payload, "playback_mode": playback_mode}

    def _discard_session(self, session: _Session) -> None:
        with self._lock:
            self._sessions.pop(session.id, None)
        if session.final_path is not None:
            try:
                session.final_path.unlink(missing_ok=True)
            except OSError:  # pragma: no cover - редкая ошибка ФС
                log.warning("Failed to remove orphaned recording %s", session.final_path)

    def _cleanup_files(self, session: _Session, audio_path: Path | None) -> None:
        candidates = {
            session.part_path,
            self.config.recording_tmp_dir / f"{session.id}.final.webm",
        }
        if audio_path is not None:
            candidates.add(audio_path)
        for path in candidates:
            try:
                path.unlink(missing_ok=True)
            except OSError:  # pragma: no cover - редкая ошибка ФС
                log.warning("Failed to remove recording temp file %s", path)
        try:
            for leftover in self.config.recording_tmp_dir.glob(f"{session.id}.*"):
                if leftover.is_file():
                    leftover.unlink(missing_ok=True)
                elif leftover.is_dir():
                    shutil.rmtree(leftover, ignore_errors=True)
        except OSError:  # pragma: no cover - редкая ошибка ФС
            log.warning("Failed to clean recording temp files for %s", session.id)
