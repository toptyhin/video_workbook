"""Иерархические теги: дерево, CRUD, связи, экспорт/импорт (M6)."""
from __future__ import annotations

import json
import re
import sqlite3
from typing import Any

COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")
HARD_MAX_DEPTH = 8


class TagError(ValueError):
    def __init__(self, code: str, detail: str, status_code: int = 400) -> None:
        super().__init__(detail)
        self.code = code
        self.detail = detail
        self.status_code = status_code


def _max_depth(conn: sqlite3.Connection) -> int:
    row = conn.execute("SELECT value FROM settings WHERE key = 'tags.max_depth'").fetchone()
    if not row:
        return 5
    try:
        value = int(json.loads(row["value"]))
    except (json.JSONDecodeError, TypeError, ValueError):
        return 5
    return max(1, min(value, HARD_MAX_DEPTH))


def _has_annotation_tags(conn: sqlite3.Connection) -> bool:
    return (
        conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='annotation_tags'"
        ).fetchone()
        is not None
    )


def validate_name(name: Any) -> str:
    if not isinstance(name, str):
        raise TagError("invalid_tag_name", "Имя тега должно быть строкой")
    value = " ".join(name.split())
    if not value:
        raise TagError("invalid_tag_name", "Имя тега не может быть пустым")
    if len(value) > 100:
        raise TagError("invalid_tag_name", "Имя тега длиннее 100 символов")
    if "/" in value or "\\" in value:
        raise TagError("invalid_tag_name", "Символы / и \\ запрещены в имени тега")
    return value


def validate_color(color: Any) -> str | None:
    if color in (None, ""):
        return None
    if not isinstance(color, str) or not COLOR_RE.match(color):
        raise TagError("invalid_color", "Цвет должен быть в формате #rrggbb")
    return color.lower()


def _depth(conn: sqlite3.Connection, tag_id: int | None) -> int:
    """Число предков тега (глубина узла: 0 у корня)."""
    if tag_id is None:
        return -1
    row = conn.execute("SELECT parent_id FROM tags WHERE id = ?", (tag_id,)).fetchone()
    if row is None:
        return 0
    depth = 0
    current = row["parent_id"]
    seen: set[int] = set()
    while current is not None:
        if current in seen:
            raise TagError("tag_cycle", "Обнаружен цикл в иерархии тегов")
        seen.add(current)
        depth += 1
        parent_row = conn.execute("SELECT parent_id FROM tags WHERE id = ?", (current,)).fetchone()
        if parent_row is None:
            break
        current = parent_row["parent_id"]
    return depth


def _node_id(conn: sqlite3.Connection, parent_id: int | None, name: str) -> int | None:
    row = conn.execute(
        "SELECT id FROM tags WHERE COALESCE(parent_id, 0) = COALESCE(?, 0) AND name = ? COLLATE NOCASE",
        (parent_id, name),
    ).fetchone()
    return int(row["id"]) if row else None


def descendant_ids(conn: sqlite3.Connection, ids: list[int]) -> list[int]:
    if not ids:
        return []
    result = set(ids)
    frontier = list(ids)
    while frontier:
        placeholders = ",".join("?" for _ in frontier)
        rows = conn.execute(
            f"SELECT id FROM tags WHERE parent_id IN ({placeholders})", frontier
        ).fetchall()
        children = [int(row["id"]) for row in rows if int(row["id"]) not in result]
        result.update(children)
        frontier = children
    return sorted(result)


def clear_cache() -> None:  # pragma: no cover - кэш счётчиков не используется
    pass


def tree(conn: sqlite3.Connection, include_counts: bool = True) -> list[dict[str, Any]]:
    rows = conn.execute("SELECT id, parent_id, name, color FROM tags ORDER BY name COLLATE NOCASE").fetchall()
    nodes: dict[int, dict[str, Any]] = {}
    for row in rows:
        nodes[int(row["id"])] = {
            "id": int(row["id"]),
            "parent_id": row["parent_id"],
            "name": row["name"],
            "color": row["color"],
            "depth": 0,
            "counts": {"files": 0, "segments": 0, "annotations": 0, "children": 0},
            "children": [],
        }
    for node in nodes.values():
        parent_id = node["parent_id"]
        if parent_id is not None and int(parent_id) in nodes:
            nodes[int(parent_id)]["children"].append(node)
    if include_counts:
        _attach_counts(conn, nodes)
    _attach_depth(nodes)
    roots = [node for node in nodes.values() if node["parent_id"] is None]
    return roots


def _attach_depth(nodes: dict[int, dict[str, Any]]) -> None:
    def walk(node: dict[str, Any], depth: int) -> None:
        node["depth"] = depth
        for child in node["children"]:
            walk(child, depth + 1)

    for node in nodes.values():
        if node["parent_id"] is None:
            walk(node, 0)


def _attach_counts(conn: sqlite3.Connection, nodes: dict[int, dict[str, Any]]) -> None:
    own: dict[int, dict[str, int]] = {tag_id: {"files": 0, "segments": 0, "annotations": 0} for tag_id in nodes}
    for row in conn.execute("SELECT tag_id, COUNT(*) AS n FROM video_tags GROUP BY tag_id"):
        if int(row["tag_id"]) in own:
            own[int(row["tag_id"])]["files"] = int(row["n"])
    for row in conn.execute("SELECT tag_id, COUNT(*) AS n FROM segment_tags GROUP BY tag_id"):
        if int(row["tag_id"]) in own:
            own[int(row["tag_id"])]["segments"] = int(row["n"])
    if _has_annotation_tags(conn):
        for row in conn.execute("SELECT tag_id, COUNT(*) AS n FROM annotation_tags GROUP BY tag_id"):
            if int(row["tag_id"]) in own:
                own[int(row["tag_id"])]["annotations"] = int(row["n"])
    for tag_id, counts in own.items():
        nodes[tag_id]["counts"].update(counts)

    def aggregate(node: dict[str, Any]) -> dict[str, int]:
        totals = {"files": 0, "segments": 0, "annotations": 0}
        for key in totals:
            totals[key] += int(node["counts"].get(key, 0))
        for child in node["children"]:
            child_totals = aggregate(child)
            for key in totals:
                totals[key] += child_totals[key]
        return totals

    def assign(node: dict[str, Any]) -> None:
        for child in node["children"]:
            assign(child)
        totals = aggregate(node)
        node["counts"].update(totals)
        node["counts"]["children"] = len(node["children"])

    for node in nodes.values():
        if node["parent_id"] is None:
            assign(node)


def create(conn: sqlite3.Connection, parent_id: int | None, name: str, color: str | None) -> dict:
    name = validate_name(name)
    color = validate_color(color)
    parent_id = int(parent_id) if parent_id is not None else None
    if parent_id is not None:
        if conn.execute("SELECT id FROM tags WHERE id = ?", (parent_id,)).fetchone() is None:
            raise TagError("tag_not_found", "Родительский тег не найден", 404)
        depth = _depth(conn, parent_id) + 1
        if depth >= _max_depth(conn):
            raise TagError("tag_depth_exceeded", f"Максимальная глубина тегов: {_max_depth(conn)}")
    try:
        cursor = conn.execute(
            "INSERT INTO tags(parent_id, name, color) VALUES (?, ?, ?)", (parent_id, name, color)
        )
        conn.commit()
    except sqlite3.IntegrityError as exc:
        raise TagError("tag_name_conflict", "Тег с таким именем уже существует", 409) from exc
    node = {"id": int(cursor.lastrowid or 0), "parent_id": parent_id, "name": name, "color": color, "depth": 0,
            "counts": {"files": 0, "segments": 0, "annotations": 0, "children": 0}, "children": []}
    return node


def update(conn: sqlite3.Connection, tag_id: int, payload: dict[str, Any]) -> dict:
    row = conn.execute("SELECT id, parent_id, name, color FROM tags WHERE id = ?", (tag_id,)).fetchone()
    if row is None:
        raise TagError("tag_not_found", "Тег не найден", 404)
    name = validate_name(payload["name"]) if "name" in payload else row["name"]
    color = validate_color(payload["color"]) if "color" in payload else row["color"]
    parent_id = row["parent_id"]
    if "parent_id" in payload:
        parent_id = int(payload["parent_id"]) if payload["parent_id"] is not None else None
        if parent_id == int(tag_id):
            raise TagError("tag_cycle", "Тег не может быть родителем сам себе")
        if parent_id is not None:
            if conn.execute("SELECT id FROM tags WHERE id = ?", (parent_id,)).fetchone() is None:
                raise TagError("tag_not_found", "Родительский тег не найден", 404)
            if parent_id in descendant_ids(conn, [int(tag_id)]):
                raise TagError("tag_cycle", "Нельзя переместить тег внутрь своего поддерева")
            if _depth(conn, parent_id) + 1 >= _max_depth(conn):
                raise TagError("tag_depth_exceeded", f"Максимальная глубина тегов: {_max_depth(conn)}")
    try:
        conn.execute(
            "UPDATE tags SET name = ?, color = ?, parent_id = ? WHERE id = ?",
            (name, color, parent_id, tag_id),
        )
        conn.commit()
    except sqlite3.IntegrityError as exc:
        raise TagError("tag_name_conflict", "Тег с таким именем уже существует", 409) from exc
    row = conn.execute("SELECT id, parent_id, name, color FROM tags WHERE id = ?", (tag_id,)).fetchone()
    return {
        "id": int(row["id"]),
        "parent_id": row["parent_id"],
        "name": row["name"],
        "color": row["color"],
        "depth": _depth(conn, tag_id),
        "counts": {"files": 0, "segments": 0, "annotations": 0, "children": 0},
        "children": [],
    }


def delete(conn: sqlite3.Connection, tag_id: int) -> None:
    if conn.execute("SELECT id FROM tags WHERE id = ?", (tag_id,)).fetchone() is None:
        raise TagError("tag_not_found", "Тег не найден", 404)
    conn.execute("DELETE FROM tags WHERE id = ?", (tag_id,))
    conn.commit()


def tag_ids_by_names(conn: sqlite3.Connection, names: list[str]) -> list[int]:
    if not names:
        return []
    paths = _path_map(conn)
    by_leaf: dict[str, list[int]] = {}
    for tag_id, path in paths.items():
        by_leaf.setdefault(path.split("/")[-1].lower(), []).append(tag_id)
    result: set[int] = set()
    for name in names:
        key = name.strip().strip('"').lower()
        for tag_id, path in paths.items():
            if path.lower() == key:
                result.add(tag_id)
        result.update(by_leaf.get(key, []))
    return sorted(result)


def _path_map(conn: sqlite3.Connection) -> dict[int, str]:
    rows = conn.execute("SELECT id, parent_id, name FROM tags").fetchall()
    by_id = {int(row["id"]): row for row in rows}

    def path_of(tag_id: int) -> str:
        parts: list[str] = []
        current: int | None = tag_id
        seen: set[int] = set()
        while current is not None and current in by_id and current not in seen:
            seen.add(current)
            row = by_id[current]
            parts.append(row["name"])
            current = row["parent_id"]
        return "/".join(reversed(parts))

    return {tag_id: path_of(tag_id) for tag_id in by_id}


def assign_video_tag(conn: sqlite3.Connection, video_id: int, tag_id: int) -> None:
    _ensure_exists(conn, "videos", video_id, "video_not_found")
    _ensure_tag(conn, tag_id)
    conn.execute("INSERT OR IGNORE INTO video_tags(video_id, tag_id) VALUES (?, ?)", (video_id, tag_id))
    conn.commit()


def remove_video_tag(conn: sqlite3.Connection, video_id: int, tag_id: int) -> None:
    conn.execute("DELETE FROM video_tags WHERE video_id = ? AND tag_id = ?", (video_id, tag_id))
    conn.commit()


def assign_segment_tag(conn: sqlite3.Connection, segment_id: int, tag_id: int) -> None:
    _ensure_exists(conn, "segments", segment_id, "segment_not_found")
    _ensure_tag(conn, tag_id)
    conn.execute("INSERT OR IGNORE INTO segment_tags(segment_id, tag_id) VALUES (?, ?)", (segment_id, tag_id))
    conn.commit()


def remove_segment_tag(conn: sqlite3.Connection, segment_id: int, tag_id: int) -> None:
    conn.execute("DELETE FROM segment_tags WHERE segment_id = ? AND tag_id = ?", (segment_id, tag_id))
    conn.commit()


def set_annotation_tags(conn: sqlite3.Connection, annotation_id: int, tag_ids: list[int]) -> None:
    conn.execute("DELETE FROM annotation_tags WHERE annotation_id = ?", (annotation_id,))
    for tag_id in tag_ids:
        _ensure_tag(conn, tag_id)
        conn.execute(
            "INSERT OR IGNORE INTO annotation_tags(annotation_id, tag_id) VALUES (?, ?)",
            (annotation_id, tag_id),
        )


def _ensure_tag(conn: sqlite3.Connection, tag_id: int) -> None:
    if conn.execute("SELECT id FROM tags WHERE id = ?", (tag_id,)).fetchone() is None:
        raise TagError("tag_not_found", "Тег не найден", 404)


def _ensure_exists(conn: sqlite3.Connection, table: str, item_id: int, code: str) -> None:
    if conn.execute(f"SELECT id FROM {table} WHERE id = ?", (item_id,)).fetchone() is None:
        raise TagError(code, "Объект не найден", 404)


def export_tree(conn: sqlite3.Connection) -> dict:
    paths = _path_map(conn)
    colors = {int(row["id"]): row["color"] for row in conn.execute("SELECT id, color FROM tags")}
    tags = [
        {"path": paths[tag_id], "color": colors.get(tag_id)}
        for tag_id in sorted(paths, key=lambda value: paths[value])
    ]
    return {"version": 1, "tags": tags}


def import_tree(conn: sqlite3.Connection, data: Any, mode: str = "merge") -> dict:
    if mode not in {"merge", "replace"}:
        raise TagError("invalid_mode", "mode должен быть merge или replace")
    tags = data.get("tags") if isinstance(data, dict) else None
    if not isinstance(tags, list):
        raise TagError("invalid_import", "Ожидается объект с полем tags[]")
    if mode == "replace":
        conn.execute("DELETE FROM tags")
        conn.commit()
    imported = 0
    skipped = 0
    errors: list[str] = []
    for item in tags:
        if not isinstance(item, dict):
            errors.append("элемент не объект")
            skipped += 1
            continue
        path = str(item.get("path", "")).strip()
        if not path:
            errors.append("пустой path")
            skipped += 1
            continue
        parent_id: int | None = None
        try:
            for part in path.split("/"):
                if not part.strip():
                    raise TagError("invalid_tag_name", f"пустая часть пути: {path}")
                name = validate_name(part)
                existing = _node_id(conn, parent_id, name)
                if existing is None:
                    existing = int(create(conn, parent_id, name, None)["id"])
                parent_id = existing
            color = validate_color(item.get("color"))
            if color and parent_id is not None:
                conn.execute("UPDATE tags SET color = ? WHERE id = ?", (color, parent_id))
                conn.commit()
            imported += 1
        except TagError as exc:
            errors.append(exc.detail)
            skipped += 1
    return {"imported": imported, "skipped": skipped, "errors": errors}
