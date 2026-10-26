"""Запросы библиотеки: список файлов, удаление, сегменты (M2/M5)."""
from __future__ import annotations

import sqlite3
from typing import Any

SORT_COLUMNS = {
    "title": "v.title",
    "duration_ms": "v.duration_ms",
    "size_bytes": "v.size_bytes",
    "status": "v.status",
    "added_at": "v.added_at",
    "mtime_ms": "v.mtime_ms",
    "progress": "v.progress",
}
STATUSES = {"pending", "queued", "processing", "done", "error", "duplicate", "missing"}


class LibraryError(ValueError):
    def __init__(self, code: str, detail: str, status_code: int = 400) -> None:
        super().__init__(detail)
        self.code = code
        self.detail = detail
        self.status_code = status_code


def _row_to_video(row: sqlite3.Row) -> dict[str, Any]:
    video = dict(row)
    video["tags_count"] = int(video.get("tags_count") or 0)
    return video


def _descendants(conn: sqlite3.Connection, tag_ids: list[int]) -> list[int]:
    if not tag_ids:
        return []
    result = set(tag_ids)
    frontier = list(tag_ids)
    while frontier:
        placeholders = ",".join("?" for _ in frontier)
        rows = conn.execute(
            f"SELECT id FROM tags WHERE parent_id IN ({placeholders})", frontier
        ).fetchall()
        children = [row["id"] for row in rows if row["id"] not in result]
        result.update(children)
        frontier = children
    return sorted(result)


def list_videos(
    conn: sqlite3.Connection,
    *,
    folder: str | None = None,
    tag_ids: list[int] | None = None,
    tag_mode: str = "any",
    include_children: bool = True,
    statuses: list[str] | None = None,
    query: str | None = None,
    sort: str = "added_at",
    direction: str = "desc",
    limit: int = 50,
    offset: int = 0,
) -> tuple[list[dict[str, Any]], int]:
    if sort not in SORT_COLUMNS:
        raise LibraryError("invalid_sort", f"Неизвестная сортировка: {sort}")
    if direction not in {"asc", "desc"}:
        raise LibraryError("invalid_dir", "dir должен быть asc или desc")
    if not 1 <= limit <= 500:
        raise LibraryError("invalid_limit", "limit должен быть 1..500")
    if offset < 0:
        raise LibraryError("invalid_offset", "offset должен быть >= 0")
    where: list[str] = ["1=1"]
    params: list[Any] = []
    if folder:
        where.append("v.path LIKE ? AND instr(substr(v.path, length(?) + 2), '/') = 0")
        params.extend([folder.rstrip("/") + "/%", folder.rstrip("/")])
    if statuses:
        unknown = set(statuses) - STATUSES
        if unknown:
            raise LibraryError("invalid_status", f"Неизвестный статус: {', '.join(sorted(unknown))}")
        placeholders = ",".join("?" for _ in statuses)
        where.append(f"v.status IN ({placeholders})")
        params.extend(statuses)
    if query:
        where.append("(LOWER(v.title) LIKE ? OR LOWER(v.path) LIKE ?)")
        like = f"%{query.lower()}%"
        params.extend([like, like])
    tag_filter = ""
    if tag_ids:
        effective = _descendants(conn, tag_ids) if include_children else tag_ids
        placeholders = ",".join("?" for _ in effective)
        if tag_mode == "all":
            tag_filter = (
                " AND (SELECT COUNT(DISTINCT vt.tag_id) FROM video_tags vt "
                f"WHERE vt.video_id = v.id AND vt.tag_id IN ({placeholders})) = ?"
            )
            params.extend(effective)
            params.append(len(effective))
        else:
            tag_filter = (
                " AND EXISTS (SELECT 1 FROM video_tags vt WHERE vt.video_id = v.id "
                f"AND vt.tag_id IN ({placeholders}))"
            )
            params.extend(effective)
    base = (
        "FROM videos v WHERE " + " AND ".join(where) + tag_filter
    )
    total = conn.execute(f"SELECT COUNT(*) AS total {base}", params).fetchone()["total"]
    order = SORT_COLUMNS[sort]
    direction_sql = "DESC" if direction == "desc" else "ASC"
    rows = conn.execute(
        "SELECT v.*, (SELECT COUNT(*) FROM video_tags vt WHERE vt.video_id = v.id) AS tags_count "
        f"{base} ORDER BY {order} {direction_sql}, v.id DESC LIMIT ? OFFSET ?",
        [*params, limit, offset],
    ).fetchall()
    return [_row_to_video(row) for row in rows], int(total)


def get_video(conn: sqlite3.Connection, video_id: int) -> sqlite3.Row | None:
    return conn.execute("SELECT * FROM videos WHERE id = ?", (video_id,)).fetchone()


def delete_video(conn: sqlite3.Connection, video_id: int) -> str | None:
    row = get_video(conn, video_id)
    if row is None:
        return None
    path = row["path"]
    conn.execute("DELETE FROM videos WHERE id = ?", (video_id,))
    conn.commit()
    return path


def _has_annotation_tags(conn: sqlite3.Connection) -> bool:
    row = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='annotation_tags'"
    ).fetchone()
    return row is not None


def list_segments(conn: sqlite3.Connection, video_id: int) -> dict[str, Any]:
    segments = []
    for row in conn.execute(
        "SELECT id, video_id, start_ms, end_ms, text FROM segments WHERE video_id = ? ORDER BY start_ms",
        (video_id,),
    ):
        segment = dict(row)
        tag_rows = conn.execute(
            "SELECT tag_id FROM segment_tags WHERE segment_id = ?", (row["id"],)
        ).fetchall()
        segment["tag_ids"] = [r["tag_id"] for r in tag_rows]
        segments.append(segment)
    annotations = []
    has_tags = _has_annotation_tags(conn)
    for row in conn.execute(
        "SELECT * FROM annotations WHERE video_id = ? ORDER BY start_ms", (video_id,)
    ):
        annotation = dict(row)
        if has_tags:
            tag_rows = conn.execute(
                "SELECT tag_id FROM annotation_tags WHERE annotation_id = ?", (row["id"],)
            ).fetchall()
            annotation["tag_ids"] = [r["tag_id"] for r in tag_rows]
        else:
            annotation["tag_ids"] = []
        annotations.append(annotation)
    return {"segments": segments, "annotations": annotations}
