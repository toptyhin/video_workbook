"""M13: менеджер моделей — загрузка, импорт, удаление, офлайн-режим.

Модели живут вне бандла: `$VL_DATA_DIR/models` (`config.models_dir`), реестр —
`backend/app/model_manifest.json` (`services/model_resolver.py`). Загрузчик
собственный (httpx, синхронный клиент в фоновом потоке): потоковая запись
чанками 1 МиБ, прогресс через SSE, `.part` + `Range`-докачка, sha256/размер,
атомарная установка каталога, `.installed.json`, single-flight на модель.

Сеть — только по явному вызову `download()` (D-13.7): при `config.offline` или
настройке `models.offline` эндпоинт загрузки отвечает `403 offline_mode`.
Импорт из каталога/архива сети не требует.

Контракт — `plans/13-model-store.md` §3–§4.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import queue as thread_queue
import re
import shutil
import sqlite3
import stat
import tarfile
import threading
import time
import uuid
import zipfile
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath
from typing import Any
from urllib.parse import quote, urlparse

import httpx

from ..config import Config
from ..db import connect
from . import model_resolver, settings_service
from .events import EventBus

log = logging.getLogger(__name__)

CHUNK_SIZE = 1024 * 1024
PROGRESS_INTERVAL = 0.2  # ≤5 событий model.progress/с
DB_INTERVAL = 1.0
HTTP_TIMEOUT = 30.0
DOWNLOAD_RETRIES = 3
RETRY_BACKOFF = 0.5
DEFAULT_ENDPOINT = "https://huggingface.co"
USER_AGENT = "VideoLessons/0.1 model-manager"
DISK_FACTOR = 1.05
DISK_MARGIN = 200 * 1024 * 1024
INSTALLED_MARKER = ".installed.json"
ACTIVE_STATUSES = ("queued", "downloading", "verifying")
ARCHIVE_SUFFIXES = (".zip", ".tar.gz", ".tgz", ".tar")


class ModelError(ValueError):
    """Ошибка операции с моделью: машинный `code` + HTTP-статус (00 §4)."""

    def __init__(self, code: str, detail: str, status_code: int = 400) -> None:
        super().__init__(detail)
        self.code = code
        self.detail = detail
        self.status_code = status_code


class _Cancelled(Exception):
    """Внутренняя отмена загрузки по запросу пользователя."""


class _Retryable(Exception):
    """Внутренняя ошибка скачивания, после которой нужен повтор/Range-докачка."""


@dataclass
class _Job:
    model_id: str
    job_id: str = field(default_factory=lambda: uuid.uuid4().hex)
    cancel: threading.Event = field(default_factory=threading.Event)
    status: str = "queued"
    bytes_received: int = 0
    total_bytes: int = 0
    tmp_dir: Path | None = None
    last_publish: float = 0.0
    last_db: float = 0.0


def _now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def _free_disk_bytes(path: Path) -> int:
    """Свободное место; ``-1`` — проверить не удалось (не блокируем загрузку)."""
    try:
        return int(shutil.disk_usage(path).free)
    except OSError:  # pragma: no cover - экзотическая ФС
        return -1


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(CHUNK_SIZE), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _copy_and_hash(source: Path, target: Path) -> str:
    digest = hashlib.sha256()
    target.parent.mkdir(parents=True, exist_ok=True)
    with source.open("rb") as src, target.open("wb") as dst:
        for chunk in iter(lambda: src.read(CHUNK_SIZE), b""):
            digest.update(chunk)
            dst.write(chunk)
    return digest.hexdigest()


def _source_files(entry: dict[str, Any]) -> list[dict[str, Any]]:
    files = (entry.get("source") or {}).get("files") or []
    if not files:
        raise ModelError(
            "model_not_found",
            f"В манифесте нет файлов для модели {entry.get('id')}",
            404,
        )
    return files


def _local_name(file: dict[str, Any]) -> str:
    return str(file.get("local") or file.get("path"))


def _present(base: Path, entry: dict[str, Any]) -> bool:
    """Все файлы записи присутствуют и совпадают по размеру."""
    try:
        files = (entry.get("source") or {}).get("files") or []
        if not files:
            return False
        for file in files:
            target = base / _local_name(file)
            if not target.is_file():
                return False
            size = file.get("size")
            if isinstance(size, int) and size > 0 and target.stat().st_size != size:
                return False
        return True
    except OSError:  # pragma: no cover - гонка с удалением каталога
        return False


def _display_size(num_bytes: int) -> str:
    if num_bytes >= 1024 * 1024:
        return f"{num_bytes / (1024 * 1024):.0f} МиБ"
    if num_bytes >= 1024:
        return f"{num_bytes / 1024:.0f} КиБ"
    return f"{num_bytes} Б"


def _decode_setting(settings: dict[str, Any], key: str, default: Any) -> Any:
    value = settings.get(key, default)
    if isinstance(value, str):
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            return value
    return value


def _safe_relative(value: str) -> PurePosixPath | None:
    """Проверяет относительный POSIX-путь (защита от traversal/absolute)."""
    text = value.replace("\\", "/").strip()
    if not text or "\x00" in text:
        return None
    path = PurePosixPath(text)
    if path.is_absolute():
        return None
    parts = [part for part in path.parts if part not in ("", ".")]
    if not parts or any(part == ".." for part in parts):
        return None
    if re.match(r"^[A-Za-z]:", parts[0]):
        return None
    return PurePosixPath(*parts)


class ModelStore:
    """Единственный владелец состояния моделей в data dir.

    Один worker-thread выполняет загрузки последовательно (single-flight на
    файловую систему); одновременно активна загрузка только одной модели, но
    запросы на другие модели ставятся в очередь.
    """

    def __init__(self, config: Config, bus: EventBus) -> None:
        self.config = config
        self.bus = bus
        self._lock = threading.RLock()
        self._jobs: dict[str, _Job] = {}
        self._queue: thread_queue.Queue[tuple[str, _Job] | None] = thread_queue.Queue()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._started = False
        self._in_use_checker: Callable[[str], bool] | None = None

    # ---------- lifecycle ----------

    def start(self) -> None:
        """Создать каталог моделей, восстановить статусы и запустить worker."""
        if self._started:
            return
        self.config.models_dir.mkdir(parents=True, exist_ok=True)
        (self.config.models_dir / ".tmp").mkdir(parents=True, exist_ok=True)
        (self.config.models_dir / ".old").mkdir(parents=True, exist_ok=True)
        self._cleanup_tmp()
        self._recover()
        self._stop.clear()
        self._thread = threading.Thread(
            target=self._worker_loop, name="model-download", daemon=True
        )
        self._thread.start()
        self._started = True

    def shutdown(self) -> None:
        if not self._started:
            return
        self._started = False
        self._stop.set()
        with self._lock:
            jobs = list(self._jobs.values())
        for job in jobs:
            job.cancel.set()
        self._queue.put(None)
        thread = self._thread
        if thread is not None and thread.is_alive():
            thread.join(timeout=10)
        self._thread = None
        self._finalize_interrupted()

    # ---------- публичный API ----------

    def set_in_use_checker(self, fn: Callable[[str], bool] | None) -> None:
        """Регистрирует проверку занятости модели (транскрипция/индексация/саммари)."""
        self._in_use_checker = fn

    def is_in_use(self, model_id: str) -> bool:
        checker = self._in_use_checker
        if checker is None:
            return False
        try:
            return bool(checker(model_id))
        except Exception:  # pragma: no cover - проверка не должна ломать операцию
            log.warning("Model in-use checker failed for %s", model_id, exc_info=True)
            return False

    def list_models(self) -> dict[str, Any]:
        """Полный реестр моделей в форме `ModelListResponse` (§4.3)."""
        settings = self._settings()
        offline = self._offline(settings)
        rows = self._all_rows()
        with self._lock:
            jobs = dict(self._jobs)
        items: list[dict[str, Any]] = []
        total_installed = 0
        total_available = 0
        for entry in model_resolver.models():
            item = self._item(entry, rows.get(str(entry["id"])), jobs.get(str(entry["id"])))
            estimate = int(entry.get("estimate_bytes") or 0)
            if estimate <= 0:
                estimate = int(item["size_bytes"] or 0)
            total_available += estimate
            if item["installed"] and not item["bundled"]:
                total_installed += int(item["size_bytes"] or 0)
            items.append(item)
        return {
            "items": items,
            "total_installed_bytes": total_installed,
            "total_available_bytes": total_available,
            "models_dir": str(self.config.models_dir),
            "offline": offline,
        }

    def download(self, model_id: str) -> dict[str, Any]:
        """Ставит модель в очередь загрузки (single-flight, 202-контракт)."""
        entry = self._entry(model_id)
        settings = self._settings()
        if self._offline(settings):
            raise ModelError(
                "offline_mode",
                "Офлайн-режим: загрузка моделей запрещена. Используйте импорт из файла.",
                403,
            )
        files = _source_files(entry)
        if self._data_installed(entry) and not self._update_available(entry):
            raise ModelError("already_installed", f"Модель {model_id} уже установлена", 409)
        if self._data_installed(entry) and self.is_in_use(model_id):
            # D-13.9: занятую модель нельзя обновлять (как и удалять).
            raise ModelError(
                "model_in_use",
                "Модель используется активной задачей. Дождитесь её завершения.",
                409,
            )
        with self._lock:
            active = self._jobs.get(model_id)
            if active is not None and not active.cancel.is_set():
                raise ModelError(
                    "download_in_progress", f"Модель {model_id} уже загружается", 409
                )
        self._check_disk(entry, len(files))
        job = _Job(model_id=model_id, total_bytes=self._download_size(entry))
        with self._lock:
            self._jobs[model_id] = job
        revision = str((entry.get("source") or {}).get("revision") or "")
        self._set_status(
            model_id,
            "queued",
            bytes_received=0,
            total_bytes=job.total_bytes,
            revision=revision,
        )
        self._publish_state(model_id, "queued")
        self._publish_progress(job, force=True)
        self._queue.put((model_id, job))
        return {"id": model_id, "status": "queued"}

    def cancel(self, model_id: str) -> dict[str, Any]:
        """Отменяет загрузку; идемпотентно возвращает `absent`."""
        self._entry(model_id)
        with self._lock:
            job = self._jobs.pop(model_id, None)
            if job is not None:
                job.cancel.set()
                job.status = "absent"
        if job is not None:
            self._set_status(model_id, "absent", bytes_received=0, total_bytes=0)
            self._publish_progress(job, force=True)
            self._publish_state(model_id, "absent")
        else:
            row = self._all_rows().get(model_id)
            if row is not None and row.get("status") in ACTIVE_STATUSES:
                self._set_status(model_id, "absent", bytes_received=0, total_bytes=0)
                self._publish_state(model_id, "absent")
        return {"id": model_id, "status": "absent"}

    def delete(self, model_id: str) -> dict[str, Any]:
        """Удаляет модель из data dir; bundled и занятую модель удалять нельзя."""
        entry = self._entry(model_id)
        with self._lock:
            active = self._jobs.get(model_id)
            if active is not None and not active.cancel.is_set():
                raise ModelError(
                    "download_in_progress",
                    "Нельзя удалить модель во время загрузки — сначала отмените её",
                    409,
                )
        if self.is_in_use(model_id):
            raise ModelError(
                "model_in_use",
                "Модель используется активной задачей. Дождитесь её завершения.",
                409,
            )
        data_base = self._safe_model_dir(entry)
        legacy_installed = _present(self._legacy_dir(entry), entry)
        data_installed = _present(data_base, entry)
        if legacy_installed and not data_installed:
            raise ModelError(
                "model_bundled",
                "Модель встроена в поставку (resources/models) и доступна только для чтения",
                409,
            )
        if data_base.exists():
            self._remove_path(data_base)
        self._cleanup_model_tmp(model_id)
        self._delete_row(model_id)
        self._publish_state(model_id, "absent")
        return {"id": model_id, "status": "absent"}

    def import_model(self, model_id: str, path: str) -> dict[str, Any]:
        """Импорт каталога или архива (.zip/.tar.gz) без сети.

        Валидация раскладки/размеров/sha256 и атомарная установка выполняются
        синхронно: ошибки `import_path_invalid`/`archive_unsafe`/
        `checksum_mismatch` возвращаются как 400. Статус в SSE: verifying → ready.
        """
        entry = self._entry(model_id)
        files = _source_files(entry)
        raw_path = (path or "").strip()
        if not raw_path:
            raise ModelError("import_path_invalid", "Путь для импорта не указан", 400)
        source = Path(raw_path).expanduser()
        if not source.exists():
            raise ModelError(
                "import_path_invalid", f"Путь для импорта не найден: {source}", 400
            )
        with self._lock:
            active = self._jobs.get(model_id)
            if active is not None and not active.cancel.is_set():
                raise ModelError(
                    "download_in_progress", f"Модель {model_id} уже загружается", 409
                )
        revision = str((entry.get("source") or {}).get("revision") or "")
        self._publish_state(model_id, "verifying")
        self._set_status(
            model_id,
            "verifying",
            bytes_received=0,
            total_bytes=self._download_size(entry),
            revision=revision,
        )
        install_dir = self._tmp_dir(f"{model_id}-import")
        extract_dir: Path | None = None
        try:
            if source.is_dir():
                base = source
            elif source.is_file():
                if not source.name.lower().endswith(ARCHIVE_SUFFIXES):
                    raise ModelError(
                        "import_path_invalid",
                        "Поддерживаются каталог или архив .zip/.tar.gz",
                        400,
                    )
                extract_dir = self._tmp_dir(f"extract-{model_id}")
                self._extract_archive(source, extract_dir)
                base = extract_dir
            else:  # pragma: no cover - особые файлы ФС
                raise ModelError("import_path_invalid", "Неизвестный тип пути импорта", 400)
            layout = self._locate_layout(base, entry)
            if layout is None:
                raise ModelError(
                    "import_path_invalid",
                    "Не найдена ожидаемая раскладка файлов модели: "
                    + ", ".join(_local_name(file) for file in files),
                    400,
                )
            hashes: dict[str, str] = {}
            for file in files:
                local = _local_name(file)
                relative = _safe_relative(local)
                if relative is None:
                    raise ModelError("import_path_invalid", f"Некорректный путь: {local}", 400)
                src = layout.joinpath(*relative.parts)
                if not src.is_file():
                    raise ModelError(
                        "import_path_invalid", f"В источнике нет файла {local}", 400
                    )
                expected = file.get("size")
                if isinstance(expected, int) and expected > 0 and src.stat().st_size != expected:
                    raise ModelError(
                        "checksum_mismatch",
                        f"Размер {local} не совпадает с манифестом "
                        f"({src.stat().st_size} вместо {expected})",
                        400,
                    )
                dst = install_dir.joinpath(*relative.parts)
                digest = _copy_and_hash(src, dst)
                expected_sha = file.get("sha256")
                if expected_sha and digest != str(expected_sha):
                    raise ModelError(
                        "checksum_mismatch", f"SHA-256 файла {local} не совпадает", 400
                    )
                hashes[local] = digest
            self._write_marker(install_dir, entry, revision, hashes)
            self._install_staged(install_dir, entry)
        except ModelError as exc:
            shutil.rmtree(install_dir, ignore_errors=True)
            if extract_dir is not None:
                shutil.rmtree(extract_dir, ignore_errors=True)
            self._set_status(
                model_id,
                "error",
                bytes_received=0,
                total_bytes=self._download_size(entry),
                revision=revision,
                error=exc.detail,
                error_code=exc.code,
            )
            self._publish_state(model_id, "error", exc.detail, exc.code)
            raise
        except BaseException:
            shutil.rmtree(install_dir, ignore_errors=True)
            if extract_dir is not None:
                shutil.rmtree(extract_dir, ignore_errors=True)
            raise
        finally:
            if extract_dir is not None:
                shutil.rmtree(extract_dir, ignore_errors=True)
        self._set_status(
            model_id,
            "ready",
            bytes_received=self._download_size(entry),
            total_bytes=self._download_size(entry),
            revision=revision,
        )
        self._publish_state(model_id, "ready")
        self._publish_state_progress(model_id, "ready", self._download_size(entry))
        return {"id": model_id, "status": "ready"}

    # ---------- worker ----------

    def _worker_loop(self) -> None:
        while not self._stop.is_set():
            try:
                item = self._queue.get(timeout=0.2)
            except thread_queue.Empty:
                continue
            if item is None:
                break
            model_id, job = item
            if job.cancel.is_set() or not self._is_current(job):
                self._cleanup_job(job)
                continue
            self._run_job(model_id, job)

    def _run_job(self, model_id: str, job: _Job) -> None:
        entry = model_resolver.get_model(model_id)
        revision = str(((entry or {}).get("source") or {}).get("revision") or "")
        try:
            if entry is None:
                raise ModelError("unknown_model", f"Неизвестная модель: {model_id}", 404)
            with self._lock:
                if not self._is_current(job):
                    return
                job.status = "downloading"
            self._publish_state(model_id, "downloading")
            self._set_status(
                model_id,
                "downloading",
                bytes_received=job.bytes_received,
                total_bytes=job.total_bytes,
                revision=revision,
            )
            self._download_model(entry, job)
            if not self._is_current(job):  # отменили в самом конце
                return
            job.status = "ready"
            self._set_status(
                model_id,
                "ready",
                bytes_received=job.bytes_received or self._download_size(entry),
                total_bytes=job.total_bytes,
                revision=revision,
            )
            self._publish_state(model_id, "ready")
            self._publish_state_progress(model_id, "ready", job.bytes_received)
        except _Cancelled:
            if self._is_current(job):
                self._set_status(model_id, "absent", bytes_received=0, total_bytes=0)
                self._publish_state(model_id, "absent")
        except ModelError as exc:
            log.warning("Model download failed for %s: %s (%s)", model_id, exc.detail, exc.code)
            if self._is_current(job):
                self._set_status(
                    model_id,
                    "error",
                    bytes_received=job.bytes_received,
                    total_bytes=job.total_bytes,
                    revision=revision,
                    error=exc.detail,
                    error_code=exc.code,
                )
                self._publish_state(model_id, "error", exc.detail, exc.code)
        except Exception as exc:  # pragma: no cover - защита worker-потока
            log.exception("Unexpected model download failure for %s", model_id)
            if self._is_current(job):
                detail = f"Внутренняя ошибка загрузки: {type(exc).__name__}: {exc}"
                self._set_status(
                    model_id,
                    "error",
                    bytes_received=job.bytes_received,
                    total_bytes=job.total_bytes,
                    revision=revision,
                    error=detail,
                    error_code="internal_error",
                )
                self._publish_state(model_id, "error", detail, "internal_error")
        finally:
            with self._lock:
                if self._jobs.get(model_id) is job:
                    self._jobs.pop(model_id, None)
            self._cleanup_job(job)

    def _download_model(self, entry: dict[str, Any], job: _Job) -> None:
        files = _source_files(entry)
        source = entry.get("source") or {}
        revision = str(source.get("revision") or "")
        endpoint = self._endpoint()
        self._check_disk(entry, len(files))
        job.total_bytes = self._download_size(entry)
        job.tmp_dir = self._tmp_dir(entry["id"])
        hashes: dict[str, str] = {}
        base_received = 0
        for file in files:
            local = _local_name(file)
            relative = _safe_relative(local)
            if relative is None:  # pragma: no cover - манифест доверенный
                raise ModelError("model_not_found", f"Некорректный путь файла: {local}", 404)
            target = job.tmp_dir.joinpath(*relative.parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            url = self._file_url(endpoint, source, file, revision)
            self._download_file(url, target, file, job, base_received)
            digest = _sha256_file(target)
            expected_sha = file.get("sha256")
            if expected_sha and digest != str(expected_sha):
                target.unlink(missing_ok=True)
                raise ModelError(
                    "checksum_mismatch", f"SHA-256 файла {local} не совпадает с манифестом", 400
                )
            hashes[local] = digest
            base_received = job.bytes_received
        job.status = "verifying"
        self._publish_state(entry["id"], "verifying")
        self._set_status(
            entry["id"],
            "verifying",
            bytes_received=job.bytes_received,
            total_bytes=job.total_bytes,
            revision=revision,
        )
        self._write_marker(job.tmp_dir, entry, revision, hashes)
        self._install_staged(job.tmp_dir, entry)
        job.tmp_dir = None

    def _download_file(
        self,
        url: str,
        target: Path,
        file: dict[str, Any],
        job: _Job,
        base_received: int,
    ) -> None:
        partial = target.with_name(target.name + ".part")
        expected = int(file.get("size") or 0)
        last_error: str = "неизвестная ошибка"
        for attempt in range(1, DOWNLOAD_RETRIES + 1):
            existing = partial.stat().st_size if partial.exists() else 0
            if expected and existing > expected:
                partial.unlink(missing_ok=True)
                existing = 0
            if expected and existing == expected:
                os.replace(partial, target)
                job.bytes_received = base_received + existing
                self._report_progress(job, force=True)
                return
            headers = {"User-Agent": USER_AGENT}
            if existing:
                headers["Range"] = f"bytes={existing}-"
            try:
                with httpx.Client(
                    timeout=HTTP_TIMEOUT, follow_redirects=True, headers={"User-Agent": USER_AGENT}
                ) as client, client.stream("GET", url, headers=headers) as response:
                    if response.status_code == 416 and expected and existing == expected:
                        os.replace(partial, target)
                        job.bytes_received = base_received + existing
                        self._report_progress(job, force=True)
                        return
                    if response.status_code == 200:
                        mode, written = "wb", 0
                    elif response.status_code == 206 and existing:
                        mode, written = "ab", existing
                    else:
                        if response.status_code in (401, 403, 404):
                            raise ModelError(
                                "download_failed",
                                f"Сервер моделей ответил HTTP {response.status_code}",
                                502,
                            )
                        raise _Retryable(f"HTTP {response.status_code}")
                    with partial.open(mode) as handle:
                        for chunk in response.iter_bytes(CHUNK_SIZE):
                            if job.cancel.is_set():
                                raise _Cancelled
                            if not chunk:
                                continue
                            handle.write(chunk)
                            written += len(chunk)
                            job.bytes_received = base_received + written
                            self._report_progress(job)
                actual = partial.stat().st_size if partial.exists() else 0
                if expected and actual < expected:
                    raise _Retryable("соединение оборвалось до конца файла")
                if expected and actual > expected:
                    partial.unlink(missing_ok=True)
                    raise _Retryable("получено больше байт, чем ожидалось")
                os.replace(partial, target)
                job.bytes_received = base_received + actual
                self._report_progress(job, force=True)
                return
            except (_Cancelled, ModelError):
                raise
            except (httpx.HTTPError, OSError, _Retryable) as exc:
                last_error = str(exc) or type(exc).__name__
                log.info(
                    "Model file download attempt %s/%s failed (%s): %s",
                    attempt,
                    DOWNLOAD_RETRIES,
                    file.get("path"),
                    last_error,
                )
                partial = target.with_name(target.name + ".part")
                if attempt >= DOWNLOAD_RETRIES:
                    break
                if job.cancel.wait(RETRY_BACKOFF * attempt):
                    raise _Cancelled from None
        raise ModelError(
            "download_failed",
            f"Не удалось скачать {file.get('path')}: {last_error}",
            502,
        )

    # ---------- импорт: архивы и раскладка ----------

    def _extract_archive(self, archive: Path, dest: Path) -> None:
        dest.mkdir(parents=True, exist_ok=True)
        name = archive.name.lower()
        try:
            if name.endswith(".zip"):
                self._extract_zip(archive, dest)
            elif name.endswith((".tar.gz", ".tgz", ".tar")):
                self._extract_tar(archive, dest)
            else:
                raise ModelError(
                    "import_path_invalid",
                    "Поддерживаются архивы .zip и .tar.gz",
                    400,
                )
        except ModelError:
            raise
        except (zipfile.BadZipFile, tarfile.TarError, OSError) as exc:
            raise ModelError(
                "import_path_invalid", f"Не удалось прочитать архив: {exc}", 400
            ) from exc

    def _extract_zip(self, archive: Path, dest: Path) -> None:
        with zipfile.ZipFile(archive) as bundle:
            for info in bundle.infolist():
                if info.is_dir():
                    continue
                if stat.S_ISLNK(info.external_attr >> 16):
                    raise ModelError(
                        "archive_unsafe", f"Символическая ссылка в архиве: {info.filename}", 400
                    )
                target = self._safe_archive_target(dest, info.filename)
                target.parent.mkdir(parents=True, exist_ok=True)
                with bundle.open(info) as src, target.open("wb") as dst:
                    shutil.copyfileobj(src, dst, CHUNK_SIZE)

    def _extract_tar(self, archive: Path, dest: Path) -> None:
        mode = "r:gz" if archive.name.lower().endswith((".tar.gz", ".tgz")) else "r:"
        with tarfile.open(archive, mode) as bundle:
            for member in bundle:
                if member.isdir():
                    continue
                if member.issym() or member.islnk() or member.isdev() or not member.isfile():
                    raise ModelError(
                        "archive_unsafe",
                        f"Недопустимый элемент архива: {member.name}",
                        400,
                    )
                target = self._safe_archive_target(dest, member.name)
                target.parent.mkdir(parents=True, exist_ok=True)
                stream = bundle.extractfile(member)
                if stream is None:  # pragma: no cover - не-регулярный файл
                    raise ModelError("archive_unsafe", f"Нет данных элемента: {member.name}", 400)
                with stream, target.open("wb") as dst:
                    shutil.copyfileobj(stream, dst, CHUNK_SIZE)

    def _safe_archive_target(self, dest: Path, member_name: str) -> Path:
        relative = _safe_relative(member_name)
        if relative is None:
            raise ModelError(
                "archive_unsafe", f"Небезопасный путь в архиве: {member_name}", 400
            )
        target = dest.joinpath(*relative.parts)
        resolved_dest = dest.resolve()
        try:
            target.resolve().relative_to(resolved_dest)
        except ValueError:
            raise ModelError(
                "archive_unsafe", f"Путь выходит за каталог распаковки: {member_name}", 400
            ) from None
        return target

    def _locate_layout(self, root: Path, entry: dict[str, Any]) -> Path | None:
        files = _source_files(entry)

        def complete(base: Path) -> bool:
            return all(
                base.joinpath(
                    *(_safe_relative(_local_name(file)) or PurePosixPath("_")).parts
                ).is_file()
                for file in files
            )

        if complete(root):
            return root
        local_dir = str(entry.get("local_dir") or "")
        candidates: list[Path] = []
        if local_dir:
            candidates.append(root / local_dir)
        candidates.extend(path for path in sorted(root.iterdir()) if path.is_dir())
        for candidate in candidates:
            if complete(candidate):
                return candidate
            if local_dir and (candidate / local_dir).is_dir() and complete(candidate / local_dir):
                return candidate / local_dir
        return None

    # ---------- статусы, файлы, БД ----------

    def _item(
        self,
        entry: dict[str, Any],
        row: dict[str, Any] | None,
        job: _Job | None,
    ) -> dict[str, Any]:
        model_id = str(entry["id"])
        data_base = self._safe_model_dir(entry)
        legacy_base = self._legacy_dir(entry)
        data_installed = _present(data_base, entry)
        legacy_installed = _present(legacy_base, entry)
        bundled = legacy_installed and not data_installed
        installed = data_installed or legacy_installed
        marker_revision = self._installed_revision(data_base) if data_installed else None
        manifest_revision = str((entry.get("source") or {}).get("revision") or "")
        revision = marker_revision if data_installed else (manifest_revision if bundled else None)
        update_available = bool(
            data_installed
            and marker_revision is not None
            and marker_revision != manifest_revision
        )
        if installed:
            size_bytes = self._payload_size(
                data_base if data_installed else legacy_base, entry
            )
        else:
            size_bytes = int(entry.get("estimate_bytes") or self._download_size(entry))
        status = "absent"
        error = error_code = None
        progress = None
        if job is not None and job.status in ACTIVE_STATUSES:
            status = job.status
            progress = _progress_payload(job)
        elif bundled:
            status = "bundled"
        elif data_installed:
            status = "ready"
        elif row is not None and row.get("status") == "error":
            status = "error"
            error = row.get("error")
            error_code = row.get("error_code")
            if row.get("total_bytes"):
                progress = _progress_from_row(row)
        if status == "error" and not installed:
            revision = manifest_revision or revision
        return {
            "id": model_id,
            "kind": str(entry.get("kind") or ""),
            "label": str(entry.get("label") or model_id),
            "installed": installed,
            "bundled": bundled,
            "status": status,
            "revision": revision,
            "update_available": update_available,
            "size_bytes": int(size_bytes or 0),
            "progress": progress,
            "license": dict(entry.get("license") or {"name": "unknown", "url": ""}),
            "recommended": bool(entry.get("recommended")),
            "default": bool(entry.get("default")),
            "meta": dict(entry.get("meta") or {}),
            "path": str(data_base) if data_installed else None,
            "error": error,
            "error_code": error_code,
        }

    def _installed_revision(self, base: Path) -> str | None:
        marker = base / INSTALLED_MARKER
        if not marker.is_file():
            return None
        try:
            data = json.loads(marker.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
        revision = data.get("revision")
        if revision:
            return str(revision)
        manifest = data.get("manifest") or {}
        revision = (manifest.get("source") or {}).get("revision")
        return str(revision) if revision else None

    def _write_marker(
        self, base: Path, entry: dict[str, Any], revision: str, hashes: dict[str, str]
    ) -> None:
        files = []
        for file in _source_files(entry):
            local = _local_name(file)
            relative = _safe_relative(local)
            target = base.joinpath(*(relative.parts if relative else [local]))
            files.append(
                {
                    "path": file.get("path"),
                    "local": local,
                    "size": target.stat().st_size if target.is_file() else 0,
                    "sha256": hashes.get(local),
                }
            )
        marker = {
            "schema": 1,
            "id": entry["id"],
            "kind": entry.get("kind"),
            "label": entry.get("label"),
            "local_dir": entry.get("local_dir"),
            "revision": revision,
            "installed_at": _now_iso(),
            "manifest": entry,
            "files": files,
        }
        (base / INSTALLED_MARKER).write_text(
            json.dumps(marker, ensure_ascii=False, indent=2), encoding="utf-8"
        )

    def _install_staged(self, staged: Path, entry: dict[str, Any]) -> None:
        target = self._safe_model_dir(entry)
        target.parent.mkdir(parents=True, exist_ok=True)
        old_root = self.config.models_dir / ".old"
        old_root.mkdir(parents=True, exist_ok=True)
        backup: Path | None = None
        if target.exists():
            backup = old_root / f"{entry['local_dir']}-{uuid.uuid4().hex}"
            os.replace(target, backup)
        try:
            os.replace(staged, target)
        except OSError:
            if backup is not None and not target.exists():
                os.replace(backup, target)
            raise
        if backup is not None and backup.exists():
            shutil.rmtree(backup, ignore_errors=True)

    def _cleanup_tmp(self) -> None:
        tmp_root = self.config.models_dir / ".tmp"
        if not tmp_root.is_dir():
            return
        for child in list(tmp_root.iterdir()):
            try:
                if child.is_dir():
                    # D-13.3: .part-файлы сохраняются для докачки; пустые/готовые каталоги — нет
                    if any(path.name.endswith(".part") for path in child.rglob("*")):
                        continue
                    shutil.rmtree(child, ignore_errors=True)
                else:
                    child.unlink(missing_ok=True)
            except OSError:  # pragma: no cover
                log.debug("Failed to clean tmp path %s", child, exc_info=True)

    def _cleanup_job(self, job: _Job) -> None:
        if job.tmp_dir is None:
            return
        shutil.rmtree(job.tmp_dir, ignore_errors=True)
        job.tmp_dir = None

    def _cleanup_model_tmp(self, model_id: str) -> None:
        for pattern in (f"{model_id}-*", f"extract-{model_id}*"):
            for child in (self.config.models_dir / ".tmp").glob(pattern):
                if child.is_dir():
                    shutil.rmtree(child, ignore_errors=True)
                else:
                    child.unlink(missing_ok=True)

    def _recover(self) -> None:
        rows = self._all_rows()
        for model_id, row in rows.items():
            if row.get("status") not in ACTIVE_STATUSES:
                continue
            entry = model_resolver.get_model(model_id)
            if entry is not None and self._data_installed(entry):
                base = self._safe_model_dir(entry)
                size = self._payload_size(base, entry)
                revision = self._installed_revision(base)
                self._set_status(
                    model_id,
                    "ready",
                    bytes_received=size,
                    total_bytes=size,
                    revision=revision,
                )
            else:
                self._set_status(model_id, "absent", bytes_received=0, total_bytes=0)

    def _finalize_interrupted(self) -> None:
        self._recover()

    # ---------- настройки/офлайн/размеры ----------

    def _settings(self) -> dict[str, Any]:
        try:
            conn = connect(self.config.db_path)
        except sqlite3.Error:  # pragma: no cover
            return dict(settings_service.DEFAULTS)
        try:
            return settings_service.get_all(conn)
        except sqlite3.Error:  # pragma: no cover - до миграций
            return dict(settings_service.DEFAULTS)
        finally:
            conn.close()

    def _offline(self, settings: dict[str, Any] | None = None) -> bool:
        if bool(getattr(self.config, "offline", False)):
            return True
        values = settings if settings is not None else self._settings()
        return bool(values.get("models.offline", False))

    def _endpoint(self) -> str:
        settings = self._settings()
        value = str(settings.get("models.endpoint") or "").strip()
        if not value:
            value = os.environ.get("VL_MODELS_ENDPOINT", "").strip()
        value = value or DEFAULT_ENDPOINT
        return value.rstrip("/")

    def _download_size(self, entry: dict[str, Any]) -> int:
        try:
            files = _source_files(entry)
        except ModelError:
            return int(entry.get("estimate_bytes") or 0)
        total = sum(int(file.get("size") or 0) for file in files)
        return total or int(entry.get("estimate_bytes") or 0)

    def _check_disk(self, entry: dict[str, Any], file_count: int = 1) -> None:
        del file_count  # размер уже учтён в estimate/сумме файлов
        free = _free_disk_bytes(self.config.models_dir)
        if free < 0:
            return
        required = int(self._download_size(entry) * DISK_FACTOR) + DISK_MARGIN
        if free < required:
            raise ModelError(
                "insufficient_disk",
                "Недостаточно места для загрузки модели: нужно "
                f"{_display_size(required)}, свободно {_display_size(free)}",
                409,
            )

    # ---------- события ----------

    def _publish(self, event_type: str, payload: dict[str, Any]) -> None:
        try:
            self.bus.publish_threadsafe(event_type, payload)
        except Exception:  # pragma: no cover - SSE не должен ломать загрузку
            log.warning("Failed to publish %s", event_type, exc_info=True)

    def _publish_state(
        self,
        model_id: str,
        status: str,
        error: str | None = None,
        error_code: str | None = None,
    ) -> None:
        self._publish(
            "model.state",
            {
                "model_id": model_id,
                "status": status,
                "error": error,
                "error_code": error_code,
            },
        )

    def _publish_state_progress(self, model_id: str, status: str, total: int) -> None:
        self._publish(
            "model.progress",
            {
                "model_id": model_id,
                "status": status,
                "bytes_received": total,
                "total_bytes": total,
                "percent": 100 if total else 0,
            },
        )

    def _report_progress(self, job: _Job, force: bool = False) -> None:
        now = time.monotonic()
        if force or now - job.last_publish >= PROGRESS_INTERVAL:
            job.last_publish = now
            self._publish_progress(job, force=True)
        if force or now - job.last_db >= DB_INTERVAL:
            job.last_db = now
            self._update_progress_row(job)

    def _publish_progress(self, job: _Job, force: bool = False) -> None:
        del force  # троттлинг выполняет вызывающая сторона
        self._publish("model.progress", _progress_payload(job))

    def _update_progress_row(self, job: _Job) -> None:
        try:
            conn = connect(self.config.db_path)
        except sqlite3.Error:  # pragma: no cover
            return
        try:
            conn.execute(
                "UPDATE model_downloads SET bytes_received = ?, total_bytes = ?, "
                "updated_at = CURRENT_TIMESTAMP WHERE model_id = ?",
                (int(job.bytes_received), int(job.total_bytes), job.model_id),
            )
            conn.commit()
        except sqlite3.Error:  # pragma: no cover - до миграций
            pass
        finally:
            conn.close()

    # ---------- БД ----------

    def _set_status(
        self,
        model_id: str,
        status: str,
        *,
        bytes_received: int = 0,
        total_bytes: int = 0,
        revision: str | None = None,
        error: str | None = None,
        error_code: str | None = None,
    ) -> None:
        try:
            conn = connect(self.config.db_path)
        except sqlite3.Error:  # pragma: no cover
            return
        try:
            conn.execute(
                "INSERT INTO model_downloads(model_id, status, bytes_received, total_bytes, "
                "revision, error, error_code, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP) "
                "ON CONFLICT(model_id) DO UPDATE SET status = excluded.status, "
                "bytes_received = excluded.bytes_received, "
                "total_bytes = excluded.total_bytes, revision = excluded.revision, "
                "error = excluded.error, error_code = excluded.error_code, "
                "updated_at = CURRENT_TIMESTAMP",
                (
                    model_id,
                    status,
                    int(bytes_received),
                    int(total_bytes),
                    revision,
                    error,
                    error_code,
                ),
            )
            conn.commit()
        except sqlite3.Error:  # pragma: no cover - до миграций
            log.debug("model_downloads write failed for %s", model_id, exc_info=True)
        finally:
            conn.close()

    def _delete_row(self, model_id: str) -> None:
        try:
            conn = connect(self.config.db_path)
        except sqlite3.Error:  # pragma: no cover
            return
        try:
            conn.execute("DELETE FROM model_downloads WHERE model_id = ?", (model_id,))
            conn.commit()
        except sqlite3.Error:  # pragma: no cover - до миграций
            log.debug("model_downloads delete failed for %s", model_id, exc_info=True)
        finally:
            conn.close()

    def _all_rows(self) -> dict[str, dict[str, Any]]:
        try:
            conn = connect(self.config.db_path)
        except sqlite3.Error:  # pragma: no cover
            return {}
        try:
            rows = conn.execute("SELECT * FROM model_downloads").fetchall()
            return {str(row["model_id"]): dict(row) for row in rows}
        except sqlite3.Error:  # pragma: no cover - до миграций
            return {}
        finally:
            conn.close()

    # ---------- пути ----------

    def _entry(self, model_id: str) -> dict[str, Any]:
        entry = model_resolver.get_model(model_id)
        if entry is None:
            raise ModelError("unknown_model", f"Неизвестная модель: {model_id}", 404)
        return entry

    def _safe_model_dir(self, entry: dict[str, Any]) -> Path:
        local_dir = str(entry.get("local_dir") or "")
        relative = _safe_relative(local_dir)
        if relative is None or len(relative.parts) != 1:
            raise ModelError(
                "model_not_found",
                f"Некорректный local_dir в манифесте: {local_dir!r}",
                404,
            )
        return self.config.models_dir / relative.parts[0]

    def _legacy_dir(self, entry: dict[str, Any]) -> Path:
        relative = _safe_relative(str(entry.get("local_dir") or ""))
        if relative is None or len(relative.parts) != 1:
            return self.config.resources_dir / "models" / "_invalid"
        return self.config.resources_dir / "models" / relative.parts[0]

    def _tmp_dir(self, label: str) -> Path:
        root = self.config.models_dir / ".tmp"
        root.mkdir(parents=True, exist_ok=True)
        path = root / f"{label}-{uuid.uuid4().hex}"
        path.mkdir(parents=True, exist_ok=True)
        return path

    def _data_installed(self, entry: dict[str, Any]) -> bool:
        return _present(self._safe_model_dir(entry), entry)

    def _update_available(self, entry: dict[str, Any]) -> bool:
        if not self._data_installed(entry):
            return False
        revision = self._installed_revision(self._safe_model_dir(entry))
        if revision is None:
            return False
        return revision != str((entry.get("source") or {}).get("revision") or "")

    def _is_current(self, job: _Job) -> bool:
        with self._lock:
            return self._jobs.get(job.model_id) is job

    def _payload_size(self, base: Path, entry: dict[str, Any]) -> int:
        """Суммарный размер payload-файлов модели (без служебных marker-файлов)."""
        total = 0
        for file in (entry.get("source") or {}).get("files") or []:
            relative = _safe_relative(_local_name(file))
            if relative is None:  # pragma: no cover - манифест доверенный
                continue
            path = base.joinpath(*relative.parts)
            try:
                if path.is_file():
                    total += path.stat().st_size
            except OSError:  # pragma: no cover
                continue
        return total or self._dir_size(base)

    def _dir_size(self, base: Path) -> int:
        total = 0
        try:
            for path in base.rglob("*"):
                if path.is_file():
                    total += path.stat().st_size
        except OSError:  # pragma: no cover - гонка с удалением
            return total
        return total

    def _file_url(
        self,
        endpoint: str,
        source: dict[str, Any],
        file: dict[str, Any],
        revision: str,
    ) -> str:
        repo = str(source.get("repo") or "").strip("/")
        revision = revision or str(source.get("revision") or "main")
        remote = str(file.get("path") or _local_name(file))
        parsed = urlparse(endpoint)
        if not parsed.scheme or not parsed.netloc:
            raise ModelError(
                "download_failed", f"Некорректный адрес зеркала моделей: {endpoint}", 502
            )
        return (
            f"{endpoint}/{repo}/resolve/{quote(revision, safe='')}/"
            f"{quote(remote, safe='/')}"
        )

    def _remove_path(self, path: Path) -> None:
        try:
            path.relative_to(self.config.models_dir)
        except ValueError:  # pragma: no cover - защита от выхода за models_dir
            raise ModelError("model_not_found", "Некорректный путь модели", 404) from None
        if path.is_symlink() or path.is_file():
            path.unlink(missing_ok=True)
        elif path.exists():
            shutil.rmtree(path, ignore_errors=True)


def _progress_payload(job: _Job) -> dict[str, Any]:
    total = int(job.total_bytes or 0)
    received = int(job.bytes_received or 0)
    percent = min(100, int(round(received * 100 / total))) if total > 0 else 0
    return {
        "model_id": job.model_id,
        "status": job.status,
        "bytes_received": received,
        "total_bytes": total,
        "percent": percent,
    }


def _progress_from_row(row: dict[str, Any]) -> dict[str, Any]:
    total = int(row.get("total_bytes") or 0)
    received = int(row.get("bytes_received") or 0)
    percent = min(100, int(round(received * 100 / total))) if total > 0 else 0
    return {
        "bytes_received": received,
        "total_bytes": total,
        "percent": percent,
    }


__all__ = [
    "ACTIVE_STATUSES",
    "ModelError",
    "ModelStore",
]
