"""Единый поиск: файлы, сегменты, метки (M4/M7)."""
from __future__ import annotations

import html
import sqlite3
import time
from typing import Any

from ..utils.fts_query import parse_query
from . import tags_service

SCOPES = ("all", "files", "segments", "annotations")
KIND_ORDER = {"segment": 0, "annotation": 1, "file": 2}
PER_PROVIDER_LIMIT = 500


class SearchError(ValueError):
    def __init__(self, code: str, detail: str, status_code: int = 422) -> None:
        super().__init__(detail)
        self.code = code
        self.detail = detail
        self.status_code = status_code


def _tag_filter(kind: str, ids: list[int], mode: str) -> tuple[str, list[Any]]:
    if not ids:
        return "", []
    placeholders = ",".join("?" for _ in ids)
    params: list[Any] = list(ids)
    if kind == "file":
        if mode == "all":
            params.append(len(ids))
            return (
                " AND (SELECT COUNT(DISTINCT vt.tag_id) FROM video_tags vt "
                f"WHERE vt.video_id = v.id AND vt.tag_id IN ({placeholders})) = ?",
                params,
            )
        return (
            f" AND EXISTS (SELECT 1 FROM video_tags vt WHERE vt.video_id = v.id "
            f"AND vt.tag_id IN ({placeholders}))",
            params,
        )
    if kind == "segment":
        alias, column = "s", "segment_id"
        table = "segment_tags"
    else:
        alias, column = "a", "annotation_id"
        table = "annotation_tags"
    if mode == "all":
        params.append(len(ids))
        return (
            f" AND (SELECT COUNT(DISTINCT t.tag_id) FROM {table} t "
            f"WHERE t.{column} = {alias}.id AND t.tag_id IN ({placeholders})) = ?",
            params,
        )
    return (
        f" AND EXISTS (SELECT 1 FROM {table} t WHERE t.{column} = {alias}.id "
        f"AND t.tag_id IN ({placeholders}))",
        params,
    )


def _decode_snippet(raw: str | None) -> str:
    text = html.escape(raw or "", quote=False)
    return text.replace("\x01", "<mark>").replace("\x02", "</mark>")


def _title_snippet(title: str, terms: list[str]) -> tuple[str, int]:
    if not terms:
        return html.escape(title, quote=False), 0
    lowered = title.lower()
    matches = 0
    for term in terms:
        index = lowered.find(term.lower())
        if index < 0:
            continue
        matches += 1
    if matches == 0:
        return html.escape(title, quote=False), 0
    first = min(lowered.find(term.lower()) for term in terms if lowered.find(term.lower()) >= 0)
    length = max(len(term) for term in terms if lowered.find(term.lower()) == first)
    before = html.escape(title[:first], quote=False)
    marked = html.escape(title[first : first + length], quote=False)
    after = html.escape(title[first + length :], quote=False)
    return f"{before}<mark>{marked}</mark>{after}", matches


def _files(
    conn: sqlite3.Connection,
    parsed: Any,
    video_id: int | None,
    tag_ids: list[int],
    tag_mode: str,
    file_prefix: str | None,
) -> list[dict[str, Any]]:
    text_terms = parsed.terms
    if not text_terms and not file_prefix and not tag_ids:
        return []
    where = ["1=1"]
    params: list[Any] = []
    if video_id is not None:
        where.append("v.id = ?")
        params.append(video_id)
    if text_terms:
        clauses = []
        for term in text_terms:
            clauses.append("(LOWER(v.title) LIKE ? OR LOWER(v.path) LIKE ?)")
            like = f"%{term.lower()}%"
            params.extend([like, like])
        where.append("(" + " OR ".join(clauses) + ")")
    if file_prefix:
        where.append("LOWER(v.title) LIKE ?")
        params.append(f"%{file_prefix.lower()}%")
    tag_sql, tag_params = _tag_filter("file", tag_ids, tag_mode)
    rows = conn.execute(
        "SELECT v.id, v.title, v.path, v.duration_ms FROM videos v WHERE "
        + " AND ".join(where)
        + tag_sql
        + " ORDER BY v.added_at DESC LIMIT ?",
        [*params, *tag_params, PER_PROVIDER_LIMIT],
    ).fetchall()
    items = []
    for row in rows:
        title = row["title"] or row["path"]
        snippet, matches = _title_snippet(title, text_terms)
        score = 1.0 + 0.5 * matches
        lowered = title.lower()
        if text_terms and any(lowered.startswith(term.lower()) for term in text_terms):
            score += 0.5
        if file_prefix:
            score += 1.0
        items.append(
            {
                "kind": "file",
                "video_id": row["id"],
                "video_title": title,
                "path": row["path"],
                "duration_ms": row["duration_ms"],
                "snippet_html": snippet,
                "score": round(score, 3),
            }
        )
    return items


def _segments(
    conn: sqlite3.Connection,
    parsed: Any,
    video_id: int | None,
    tag_ids: list[int],
    tag_mode: str,
    file_prefix: str | None,
) -> list[dict[str, Any]]:
    if not parsed.fts and not tag_ids and video_id is None:
        return []
    where = ["1=1"]
    params: list[Any] = []
    if parsed.fts:
        where.append("segments_fts MATCH ?")
        params.append(parsed.fts)
    if video_id is not None:
        where.append("s.video_id = ?")
        params.append(video_id)
    if file_prefix:
        where.append("LOWER(v.title) LIKE ?")
        params.append(f"%{file_prefix.lower()}%")
    tag_sql, tag_params = _tag_filter("segment", tag_ids, tag_mode)
    score_sql = "-bm25(segments_fts)" if parsed.fts else "1.0"
    snippet_sql = (
        "snippet(segments_fts, 0, char(1), char(2), '…', 12)" if parsed.fts else "s.text"
    )
    rows = conn.execute(
        f"""SELECT s.id, s.video_id, s.start_ms, s.end_ms, s.text,
                   v.title AS video_title, {score_sql} AS score, {snippet_sql} AS snip
            FROM segments_fts
            JOIN segments s ON s.id = segments_fts.rowid
            JOIN videos v ON v.id = s.video_id
            WHERE {' AND '.join(where)}{tag_sql}
            ORDER BY score DESC, s.start_ms
            LIMIT ?""",
        [*params, *tag_params, PER_PROVIDER_LIMIT],
    ).fetchall()
    return [
        {
            "kind": "segment",
            "video_id": row["video_id"],
            "video_title": row["video_title"],
            "segment_id": row["id"],
            "start_ms": row["start_ms"],
            "end_ms": row["end_ms"],
            "text": row["text"][:400],
            "snippet_html": _decode_snippet(row["snip"]),
            "score": round(float(row["score"]), 3),
        }
        for row in rows
    ]


def _annotations(
    conn: sqlite3.Connection,
    parsed: Any,
    video_id: int | None,
    tag_ids: list[int],
    tag_mode: str,
    file_prefix: str | None,
    colors: list[str] | None,
) -> list[dict[str, Any]]:
    if not parsed.fts and not tag_ids and video_id is None and not colors:
        return []
    where = ["1=1"]
    params: list[Any] = []
    if parsed.fts:
        where.append("annotations_fts MATCH ?")
        params.append(parsed.fts)
    if video_id is not None:
        where.append("a.video_id = ?")
        params.append(video_id)
    if file_prefix:
        where.append("LOWER(v.title) LIKE ?")
        params.append(f"%{file_prefix.lower()}%")
    if colors:
        placeholders = ",".join("?" for _ in colors)
        where.append(f"a.color IN ({placeholders})")
        params.extend(colors)
    tag_sql, tag_params = _tag_filter("annotation", tag_ids, tag_mode)
    score_sql = "-bm25(annotations_fts)" if parsed.fts else "1.0"
    snippet_sql = (
        "snippet(annotations_fts, -1, char(1), char(2), '…', 10)" if parsed.fts else "a.label"
    )
    rows = conn.execute(
        f"""SELECT a.id, a.video_id, a.start_ms, a.end_ms, a.label, a.note, a.color,
                   v.title AS video_title, {score_sql} AS score, {snippet_sql} AS snip
            FROM annotations_fts
            JOIN annotations a ON a.id = annotations_fts.rowid
            JOIN videos v ON v.id = a.video_id
            WHERE {' AND '.join(where)}{tag_sql}
            ORDER BY score DESC, a.start_ms
            LIMIT ?""",
        [*params, *tag_params, PER_PROVIDER_LIMIT],
    ).fetchall()
    items = []
    for row in rows:
        tag_rows = conn.execute(
            "SELECT tag_id FROM annotation_tags WHERE annotation_id = ?", (row["id"],)
        ).fetchall()
        items.append(
            {
                "kind": "annotation",
                "video_id": row["video_id"],
                "video_title": row["video_title"],
                "annotation_id": row["id"],
                "start_ms": row["start_ms"],
                "end_ms": row["end_ms"],
                "label": row["label"],
                "note": row["note"],
                "color": row["color"],
                "tag_ids": [int(tag["tag_id"]) for tag in tag_rows],
                "snippet_html": _decode_snippet(row["snip"]),
                "score": round(float(row["score"]), 3),
            }
        )
    return items


def search(
    conn: sqlite3.Connection,
    *,
    q: str = "",
    scope: str = "all",
    video_id: int | None = None,
    tag_ids: list[int] | None = None,
    tag_mode: str = "any",
    include_children: bool = True,
    colors: list[str] | None = None,
    limit: int = 20,
    offset: int = 0,
) -> dict[str, Any]:
    if scope not in SCOPES:
        raise SearchError("invalid_scope", f"scope должен быть одним из: {', '.join(SCOPES)}")
    if not 1 <= limit <= 100:
        raise SearchError("invalid_limit", "limit должен быть 1..100")
    if offset < 0:
        raise SearchError("invalid_limit", "offset должен быть >= 0")
    started = time.monotonic()
    parsed = parse_query(q)
    requested = list(dict.fromkeys([*(tag_ids or []), *tags_service.tag_ids_by_names(conn, parsed.tags)]))
    effective = tags_service.descendant_ids(conn, requested) if include_children else requested
    items: list[dict[str, Any]] = []
    if scope in ("all", "files"):
        items.extend(_files(conn, parsed, video_id, effective, tag_mode, parsed.file))
    if scope in ("all", "segments"):
        items.extend(_segments(conn, parsed, video_id, effective, tag_mode, parsed.file))
    if scope in ("all", "annotations"):
        items.extend(_annotations(conn, parsed, video_id, effective, tag_mode, parsed.file, colors))
    items.sort(
        key=lambda item: (
            -item["score"],
            KIND_ORDER[item["kind"]],
            item["video_id"],
            item.get("start_ms") or 0,
        )
    )
    total = len(items)
    elapsed = round((time.monotonic() - started) * 1000, 1)
    return {
        "query": {**parsed.echo(), "scope": scope, "took_ms": elapsed},
        "total": total,
        "items": items[offset : offset + limit],
    }


__all__ = ["search", "SearchError"]
