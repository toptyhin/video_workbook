"""Перемещение и копирование файлов в папку (V5, plans/15 §3).

Сервис отвечает за всю логику POST /api/videos/transfer: валидацию запроса,
проверку watched-корней, per-item операции с файлами и строками `videos`,
историю адресатов. Публикация SSE и HTTP-ответ — за роутером `videos.py`.
"""
from __future__ import annotations

import logging
import shutil
import sqlite3
import time
from pathlib import Path
from typing import Any

from ..config import Config
from . import scanner, settings_service

log = logging.getLogger(__name__)

ACTIONS = {"move", "copy"}
MAX_IDS = 500
INDEX_RETRIES = 3


class TransferError(ValueError):
    """Ошибка уровня запроса; per-item ошибки возвращаются в `items`."""

    def __init__(self, code: str, detail: str, status_code: int = 400) -> None:
        super().__init__(detail)
        self.code = code
        self.detail = detail
        self.status_code = status_code


def transfer(
    conn: sqlite3.Connection,
    config: Config,
    *,
    action: Any,
    ids: Any,
    destination: Any,
) -> dict[str, Any]:
    """Перемещает/копирует файлы в папку; частичный успех — не исключение."""
    if action not in ACTIONS:
        raise TransferError("invalid_action", "action должен быть move или copy", 400)
    normalized_ids = _validate_ids(ids)
    roots = _watch_roots(conn)
    target_dir = _validate_destination(destination, roots)

    items = []
    for video_id in normalized_ids:
        if action == "move":
            items.append(_move_item(conn, video_id, target_dir))
        else:
            items.append(_copy_item(conn, config, video_id, target_dir))

    succeeded = [item for item in items if item["ok"]]
    if succeeded:
        recent = settings_service.remember_destination(conn, str(target_dir))
    else:
        current = settings_service.get_all(conn).get(settings_service.RECENT_DESTINATIONS_KEY)
        recent = list(current) if isinstance(current, list) else []
    return {
        "action": action,
        "destination": str(target_dir),
        "items": items,
        "moved": len(succeeded) if action == "move" else 0,
        "copied": len(succeeded) if action == "copy" else 0,
        "failed": len(items) - len(succeeded),
        "recent_destinations": recent,
    }


def _validate_ids(ids: Any) -> list[int]:
    if not isinstance(ids, list) or not ids:
        raise TransferError("invalid_ids", "ids должен быть непустым списком", 400)
    if len(ids) > MAX_IDS:
        raise TransferError("invalid_ids", f"ids: не больше {MAX_IDS} значений", 400)
    normalized: list[int] = []
    for value in ids:
        if not isinstance(value, int) or isinstance(value, bool):
            raise TransferError("invalid_ids", "ids должен содержать целые числа", 400)
        normalized.append(int(value))
    return normalized


def _watch_roots(conn: sqlite3.Connection) -> list[Path]:
    return [
        _resolve(Path(row["path"]))
        for row in conn.execute("SELECT path FROM watched_folders ORDER BY path")
    ]


def _validate_destination(raw: Any, roots: list[Path]) -> Path:
    if not isinstance(raw, str) or not raw.strip():
        raise TransferError("invalid_path", "destination обязателен", 400)
    try:
        destination = Path(raw).expanduser().resolve()
    except (OSError, RuntimeError):
        raise TransferError("invalid_path", "Неверный путь назначения", 400) from None
    if not destination.is_dir():
        raise TransferError("invalid_path", "Каталог назначения не найден", 400)
    if not any(_is_within(destination, root) for root in roots):
        raise TransferError("forbidden_path", "Путь вне отслеживаемых папок", 403)
    return destination


def _is_within(path: Path, root: Path) -> bool:
    return path == root or root in path.parents


def _resolve(path: Path) -> Path:
    try:
        return path.expanduser().resolve()
    except (OSError, RuntimeError):  # pragma: no cover - защита от битых симлинков
        return path.expanduser()


def _get_row(conn: sqlite3.Connection, video_id: int) -> sqlite3.Row | None:
    return conn.execute("SELECT * FROM videos WHERE id = ?", (video_id,)).fetchone()


def _source_path(row: sqlite3.Row) -> Path | None:
    source = _resolve(Path(row["path"]))
    return source if source.is_file() else None


def _target_taken(conn: sqlite3.Connection, target: Path) -> bool:
    if target.exists():
        return True
    row = conn.execute("SELECT 1 FROM videos WHERE path = ?", (str(target),)).fetchone()
    return row is not None


def _video_id_at(conn: sqlite3.Connection, path: Path) -> int | None:
    row = conn.execute("SELECT id FROM videos WHERE path = ?", (str(path),)).fetchone()
    return int(row["id"]) if row is not None else None


def _item(
    video_id: int,
    *,
    ok: bool,
    code: str | None = None,
    detail: str | None = None,
    path: str | None = None,
    new_id: int | None = None,
) -> dict[str, Any]:
    return {
        "id": video_id,
        "ok": ok,
        "code": code,
        "detail": detail,
        "path": path,
        "new_id": new_id,
    }


def _failure(video_id: int, code: str, detail: str) -> dict[str, Any]:
    return _item(video_id, ok=False, code=code, detail=detail)


def _move_item(
    conn: sqlite3.Connection, video_id: int, destination: Path
) -> dict[str, Any]:
    row = _get_row(conn, video_id)
    if row is None:
        return _failure(video_id, "not_found", "Видео не найдено")
    source = _source_path(row)
    if source is None:
        return _failure(video_id, "missing_file", "Файл не найден на диске")
    if source.parent == destination:
        return _failure(video_id, "same_folder", "Файл уже находится в этой папке")
    target = destination / source.name
    if _target_taken(conn, target):
        return _failure(video_id, "target_exists", f"В папке назначения уже есть файл {source.name}")
    try:
        shutil.move(str(source), str(target))
    except OSError as exc:
        return _failure(video_id, "move_failed", f"Не удалось переместить файл: {exc}")
    try:
        conn.execute("UPDATE videos SET path = ? WHERE id = ?", (str(target), video_id))
        conn.commit()
    except sqlite3.Error as exc:
        conn.rollback()
        _rollback_move(target, source)
        if isinstance(exc, sqlite3.IntegrityError):
            detail = "Путь уже занят в индексе"
        else:
            detail = f"Ошибка базы данных при перемещении: {exc}"
        return _failure(video_id, "move_failed", detail)
    return _item(video_id, ok=True, path=str(target))


def _rollback_move(target: Path, source: Path) -> None:
    try:
        if target.exists() and not source.exists():
            shutil.move(str(target), str(source))
    except OSError as exc:  # pragma: no cover - откат best-effort
        log.warning("Не удалось откатить перемещение %s → %s: %s", target, source, exc)


def _copy_item(
    conn: sqlite3.Connection, config: Config, video_id: int, destination: Path
) -> dict[str, Any]:
    row = _get_row(conn, video_id)
    if row is None:
        return _failure(video_id, "not_found", "Видео не найдено")
    source = _source_path(row)
    if source is None:
        return _failure(video_id, "missing_file", "Файл не найден на диске")
    if source.parent == destination:
        return _failure(video_id, "same_folder", "Файл уже находится в этой папке")
    target = destination / source.name
    if _target_taken(conn, target):
        return _failure(video_id, "target_exists", f"В папке назначения уже есть файл {source.name}")
    try:
        shutil.copy2(str(source), str(target))
    except OSError as exc:
        return _failure(video_id, "copy_failed", f"Не удалось скопировать файл: {exc}")

    code: str | None = None
    detail: str | None = None
    new_id: int | None = None
    try:
        outcome, new_id = _upsert_with_retry(conn, config, target)
        if outcome == "errors":
            code = "index_error"
            detail = "Файл скопирован, но проиндексировать его не удалось"
    except sqlite3.Error as exc:
        conn.rollback()
        # Гонка с watcher: строку мог создать он — тогда индексация фактически удалась.
        new_id = _video_id_at(conn, target)
        if new_id is None:
            code = "index_error"
            detail = f"Файл скопирован, но индексация не удалась: {exc}"
    return _item(video_id, ok=True, code=code, detail=detail, path=str(target), new_id=new_id)


def _upsert_with_retry(
    conn: sqlite3.Connection, config: Config, target: Path
) -> tuple[str, int | None]:
    """Индексирует копию; повторяет попытку при гонке UNIQUE(path) с watcher."""
    for attempt in range(INDEX_RETRIES):
        try:
            return scanner.upsert_file(conn, config, target)
        except sqlite3.IntegrityError:
            conn.rollback()
            if attempt == INDEX_RETRIES - 1:
                raise
            time.sleep(0.05 * (attempt + 1))
    raise AssertionError("unreachable")  # pragma: no cover
