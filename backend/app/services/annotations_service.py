"""Пользовательские метки: CRUD, валидация, теги, экспорт/импорт (M7)."""
from __future__ import annotations

import re
import sqlite3
from datetime import UTC, datetime
from typing import Any

from . import tags_service

COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")
DEFAULT_COLOR = "#3b82f6"
MIN_DURATION_MS = 300
MAX_LABEL = 200
MAX_NOTE = 2000


class AnnotationError(ValueError):
    def __init__(self, code: str, detail: str, status_code: int = 400) -> None:
        super().__init__(detail)
        self.code = code
        self.detail = detail
        self.status_code = status_code


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def _video(conn: sqlite3.Connection, video_id: int) -> sqlite3.Row:
    row = conn.execute("SELECT id, duration_ms FROM videos WHERE id = ?", (video_id,)).fetchone()
    if row is None:
        raise AnnotationError("video_not_found", "Видео не найдено", 404)
    return row


def _validate_payload(
    conn: sqlite3.Connection,
    payload: dict[str, Any],
    *,
    video_id: int,
    current: dict[str, Any] | None = None,
) -> dict[str, Any]:
    video = _video(conn, video_id)
    start = payload.get("start_ms", current.get("start_ms") if current else None)
    end = payload.get("end_ms", current.get("end_ms") if current else None)
    label = payload.get("label", current.get("label") if current else None)
    color = payload.get("color", current.get("color") if current else DEFAULT_COLOR)
    note = payload.get("note", current.get("note") if current else None)
    if not isinstance(start, int) or not isinstance(end, int) or isinstance(start, bool) or isinstance(end, bool):
        raise AnnotationError("annotation_invalid_range", "start_ms и end_ms должны быть целыми")
    if start < 0 or end <= start:
        raise AnnotationError("annotation_invalid_range", "Конец должен быть позже начала")
    if end - start < MIN_DURATION_MS:
        raise AnnotationError("annotation_invalid_range", f"Минимальная длина метки: {MIN_DURATION_MS} мс")
    duration = video["duration_ms"]
    if duration and end > duration + 50:
        raise AnnotationError("annotation_invalid_range", "Метка выходит за пределы видео")
    if not isinstance(label, str) or not label.strip():
        raise AnnotationError("annotation_empty_label", "Название метки обязательно")
    label = label.strip()
    if len(label) > MAX_LABEL:
        raise AnnotationError("annotation_label_too_long", f"Название длиннее {MAX_LABEL} символов")
    if note is not None:
        if not isinstance(note, str):
            raise AnnotationError("annotation_note_too_long", "Заметка должна быть строкой")
        if len(note) > MAX_NOTE:
            raise AnnotationError("annotation_note_too_long", f"Заметка длиннее {MAX_NOTE} символов")
    if color is None:
        color = DEFAULT_COLOR
    if not isinstance(color, str) or not COLOR_RE.match(color):
        raise AnnotationError("annotation_invalid_color", "Цвет должен быть в формате #rrggbb")
    return {
        "start_ms": start,
        "end_ms": end,
        "label": label,
        "color": color.lower(),
        "note": note or None,
    }


def _serialize(conn: sqlite3.Connection, row: sqlite3.Row) -> dict[str, Any]:
    data = dict(row)
    tag_rows = conn.execute(
        "SELECT tag_id FROM annotation_tags WHERE annotation_id = ? ORDER BY tag_id", (row["id"],)
    ).fetchall()
    data["tag_ids"] = [int(tag["tag_id"]) for tag in tag_rows]
    return data


def get(conn: sqlite3.Connection, annotation_id: int) -> dict[str, Any]:
    row = conn.execute("SELECT * FROM annotations WHERE id = ?", (annotation_id,)).fetchone()
    if row is None:
        raise AnnotationError("annotation_not_found", "Метка не найдена", 404)
    return _serialize(conn, row)


def list_annotations(
    conn: sqlite3.Connection,
    *,
    video_id: int | None = None,
    tag_id: list[int] | None = None,
    color: str | None = None,
    q: str | None = None,
    limit: int = 500,
    offset: int = 0,
) -> tuple[list[dict[str, Any]], int]:
    where = ["1=1"]
    params: list[Any] = []
    if video_id is not None:
        where.append("a.video_id = ?")
        params.append(video_id)
    if color:
        where.append("a.color = ?")
        params.append(color.lower())
    if q:
        where.append("(LOWER(a.label) LIKE ? OR LOWER(COALESCE(a.note, '')) LIKE ?)")
        like = f"%{q.lower()}%"
        params.extend([like, like])
    tag_clause = ""
    if tag_id:
        placeholders = ",".join("?" for _ in tag_id)
        effective = tags_service.descendant_ids(conn, tag_id)
        placeholders = ",".join("?" for _ in effective)
        tag_clause = (
            " AND EXISTS (SELECT 1 FROM annotation_tags t WHERE t.annotation_id = a.id "
            f"AND t.tag_id IN ({placeholders}))"
        )
        params.extend(effective)
    total = conn.execute(
        f"SELECT COUNT(*) AS n FROM annotations a WHERE {' AND '.join(where)}{tag_clause}", params
    ).fetchone()["n"]
    rows = conn.execute(
        f"SELECT a.* FROM annotations a WHERE {' AND '.join(where)}{tag_clause} "
        "ORDER BY a.video_id, a.start_ms LIMIT ? OFFSET ?",
        [*params, min(max(limit, 1), 2000), max(offset, 0)],
    ).fetchall()
    return [_serialize(conn, row) for row in rows], int(total)


def create(conn: sqlite3.Connection, payload: dict[str, Any]) -> dict[str, Any]:
    video_id = payload.get("video_id")
    if not isinstance(video_id, int):
        raise AnnotationError("video_not_found", "video_id обязателен", 404)
    values = _validate_payload(conn, payload, video_id=video_id)
    tag_ids = _validate_tag_ids(conn, payload.get("tag_ids"))
    cursor = conn.execute(
        "INSERT INTO annotations(video_id, start_ms, end_ms, label, color, note, updated_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (
            video_id,
            values["start_ms"],
            values["end_ms"],
            values["label"],
            values["color"],
            values["note"],
            _now(),
        ),
    )
    annotation_id = int(cursor.lastrowid or 0)
    tags_service.set_annotation_tags(conn, annotation_id, tag_ids)
    conn.commit()
    return get(conn, annotation_id)


def bulk_create(conn: sqlite3.Connection, video_id: int, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    _video(conn, video_id)
    if not isinstance(items, list) or not items:
        raise AnnotationError("annotation_invalid_range", "items должен быть непустым списком")
    prepared: list[tuple[dict[str, Any], list[int]]] = []
    for item in items:
        values = _validate_payload(conn, {**item, "video_id": video_id}, video_id=video_id)
        prepared.append((values, _validate_tag_ids(conn, item.get("tag_ids"))))
    created: list[int] = []
    for values, tag_ids in prepared:
        cursor = conn.execute(
            "INSERT INTO annotations(video_id, start_ms, end_ms, label, color, note, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                video_id,
                values["start_ms"],
                values["end_ms"],
                values["label"],
                values["color"],
                values["note"],
                _now(),
            ),
        )
        annotation_id = int(cursor.lastrowid or 0)
        tags_service.set_annotation_tags(conn, annotation_id, tag_ids)
        created.append(annotation_id)
    conn.commit()
    return [get(conn, annotation_id) for annotation_id in created]


def update(conn: sqlite3.Connection, annotation_id: int, patch: dict[str, Any]) -> dict[str, Any]:
    row = conn.execute("SELECT * FROM annotations WHERE id = ?", (annotation_id,)).fetchone()
    if row is None:
        raise AnnotationError("annotation_not_found", "Метка не найдена", 404)
    values = _validate_payload(conn, patch, video_id=int(row["video_id"]), current=dict(row))
    tag_ids: list[int] | None = None
    if "tag_ids" in patch:
        tag_ids = _validate_tag_ids(conn, patch.get("tag_ids"))
    conn.execute(
        "UPDATE annotations SET start_ms = ?, end_ms = ?, label = ?, color = ?, note = ?, updated_at = ? "
        "WHERE id = ?",
        (
            values["start_ms"],
            values["end_ms"],
            values["label"],
            values["color"],
            values["note"],
            _now(),
            annotation_id,
        ),
    )
    if tag_ids is not None:
        tags_service.set_annotation_tags(conn, annotation_id, tag_ids)
    conn.commit()
    return get(conn, annotation_id)


def delete(conn: sqlite3.Connection, annotation_id: int) -> None:
    row = conn.execute("SELECT id FROM annotations WHERE id = ?", (annotation_id,)).fetchone()
    if row is None:
        raise AnnotationError("annotation_not_found", "Метка не найдена", 404)
    conn.execute("DELETE FROM annotations WHERE id = ?", (annotation_id,))
    conn.commit()


def _validate_tag_ids(conn: sqlite3.Connection, tag_ids: Any) -> list[int]:
    if tag_ids is None:
        return []
    if not isinstance(tag_ids, list):
        raise AnnotationError("invalid_tag_ids", "tag_ids должен быть списком")
    result = []
    for tag_id in tag_ids:
        if not isinstance(tag_id, int):
            raise AnnotationError("invalid_tag_ids", "tag_ids должен содержать числа")
        if conn.execute("SELECT id FROM tags WHERE id = ?", (tag_id,)).fetchone() is None:
            raise AnnotationError("tag_not_found", f"Тег {tag_id} не найден", 404)
        result.append(tag_id)
    return sorted(set(result))


def export(conn: sqlite3.Connection, video_id: int | None = None) -> dict[str, Any]:
    paths = tags_service._path_map(conn)
    where = "WHERE a.video_id = ?" if video_id is not None else ""
    params = [video_id] if video_id is not None else []
    if video_id is not None:
        _video(conn, video_id)
        video = conn.execute("SELECT id, path, duration_ms FROM videos WHERE id = ?", (video_id,)).fetchone()
        video_payload: dict[str, Any] | None = {
            "id": video["id"],
            "path": video["path"],
            "duration_ms": video["duration_ms"],
        }
    else:
        video_payload = None
    annotations = []
    for row in conn.execute(f"SELECT a.* FROM annotations a {where} ORDER BY a.video_id, a.start_ms", params):
        tag_rows = conn.execute(
            "SELECT tag_id FROM annotation_tags WHERE annotation_id = ?", (row["id"],)
        ).fetchall()
        tags = [paths[int(tag["tag_id"])] for tag in tag_rows if int(tag["tag_id"]) in paths]
        annotations.append(
            {
                "video_id": row["video_id"],
                "start_ms": row["start_ms"],
                "end_ms": row["end_ms"],
                "label": row["label"],
                "color": row["color"],
                "note": row["note"],
                "tags": tags,
                "created_at": row["created_at"],
                "updated_at": row["updated_at"],
            }
        )
    return {
        "version": 1,
        "exported_at": _now(),
        "video": video_payload,
        "annotations": annotations,
    }


def import_data(
    conn: sqlite3.Connection, payload: dict[str, Any], video_id: int | None = None
) -> dict[str, Any]:
    data = payload.get("data", payload)
    mode = payload.get("mode", "merge")
    if mode not in {"merge", "replace"}:
        raise AnnotationError("invalid_mode", "mode должен быть merge или replace")
    if not isinstance(data, dict) or not isinstance(data.get("annotations"), list):
        raise AnnotationError("annotation_invalid_import", "Ожидается поле annotations[]")
    target_video = video_id
    if target_video is None and isinstance(data.get("video"), dict):
        target_video = data["video"].get("id")
    annotations = data["annotations"]
    if target_video is None:
        if not annotations:
            return {"imported": 0, "skipped": 0, "errors": []}
        try:
            target_video = int(annotations[0].get("video_id"))
        except (TypeError, ValueError) as exc:
            raise AnnotationError("annotation_invalid_import", "Не указан video_id") from exc
    _video(conn, target_video)
    if mode == "replace":
        conn.execute("DELETE FROM annotations WHERE video_id = ?", (target_video,))
        conn.commit()
    imported = 0
    skipped = 0
    errors: list[str] = []
    for index, item in enumerate(annotations):
        if len(annotations) > 5000:
            errors.append("слишком много меток (максимум 5000)")
            break
        if not isinstance(item, dict):
            errors.append(f"[{index}] элемент не объект")
            skipped += 1
            continue
        try:
            values = _validate_payload(conn, item, video_id=target_video)
            tag_ids = []
            for name in item.get("tags", []) or []:
                found = tags_service.tag_ids_by_names(conn, [str(name)])
                if not found:
                    created = tags_service.create(conn, None, str(name), None)
                    found = [int(created["id"])]
                tag_ids.extend(found)
            existing = conn.execute(
                "SELECT id FROM annotations WHERE video_id = ? AND start_ms = ? AND end_ms = ? "
                "AND label = ?",
                (target_video, values["start_ms"], values["end_ms"], values["label"]),
            ).fetchone()
            if existing:
                skipped += 1
                continue
            create(
                conn,
                {
                    "video_id": target_video,
                    "start_ms": values["start_ms"],
                    "end_ms": values["end_ms"],
                    "label": values["label"],
                    "color": values["color"],
                    "note": values["note"],
                    "tag_ids": sorted(set(tag_ids)),
                },
            )
            imported += 1
        except (AnnotationError, tags_service.TagError) as exc:
            errors.append(f"[{index}] {exc.detail}")
            skipped += 1
    return {"imported": imported, "skipped": skipped, "errors": errors}
