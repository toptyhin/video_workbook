from __future__ import annotations

import sqlite3
from pathlib import Path

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse

from ..deps import get_db

router = APIRouter(prefix="/api", tags=["folders"])


def _folder_rows(conn: sqlite3.Connection) -> list[dict]:
    rows = conn.execute("SELECT id, path, added_at FROM watched_folders ORDER BY path").fetchall()
    result = []
    for row in rows:
        prefix = row["path"].rstrip("/") + "/%"
        total = conn.execute(
            "SELECT COUNT(*) AS n FROM videos WHERE path LIKE ?", (prefix,)
        ).fetchone()["n"]
        done = conn.execute(
            "SELECT COUNT(*) AS n FROM videos WHERE path LIKE ? AND status = 'done'", (prefix,)
        ).fetchone()["n"]
        result.append(
            {"id": row["id"], "path": row["path"], "added_at": row["added_at"], "total": total, "done": done}
        )
    return result


def _watch_roots(request: Request) -> list[str]:
    watcher = getattr(request.app.state, "watcher", None)
    if watcher is None:
        return []
    conn = request.app.state.config
    from ..db import connect

    db = connect(conn.db_path)
    try:
        roots = [row["path"] for row in db.execute("SELECT path FROM watched_folders ORDER BY path")]
        return roots
    finally:
        db.close()


@router.get("/folders")
def list_folders(conn: sqlite3.Connection = Depends(get_db)) -> dict:
    items = _folder_rows(conn)
    return {"items": items, "total": len(items)}


@router.post("/folders")
def add_folder(payload: dict, request: Request, conn: sqlite3.Connection = Depends(get_db)):
    raw = payload.get("path")
    if not isinstance(raw, str) or not raw.strip():
        return JSONResponse(status_code=400, content={"detail": "path обязателен", "code": "invalid_path"})
    path = str(Path(raw).expanduser().resolve())
    if not Path(path).is_dir():
        return JSONResponse(status_code=400, content={"detail": "Папка не найдена", "code": "invalid_path"})
    existing = conn.execute("SELECT id FROM watched_folders WHERE path = ?", (path,)).fetchone()
    if existing:
        return JSONResponse(status_code=409, content={"detail": "Папка уже отслеживается", "code": "folder_exists"})
    cursor = conn.execute("INSERT INTO watched_folders(path) VALUES (?)", (path,))
    conn.commit()
    row = conn.execute("SELECT id, path, added_at FROM watched_folders WHERE id = ?", (cursor.lastrowid,)).fetchone()
    scanner = getattr(request.app.state, "scanner", None)
    if scanner is not None:
        scanner.start_scan(path)
    watcher = getattr(request.app.state, "watcher", None)
    if watcher is not None:
        watcher.start(_watch_roots(request))
    return JSONResponse(
        status_code=201,
        content={"id": row["id"], "path": row["path"], "added_at": row["added_at"], "total": 0, "done": 0},
    )


@router.delete("/folders/{folder_id}")
def delete_folder(folder_id: int, request: Request, conn: sqlite3.Connection = Depends(get_db)):
    row = conn.execute("SELECT id FROM watched_folders WHERE id = ?", (folder_id,)).fetchone()
    if row is None:
        return JSONResponse(status_code=404, content={"detail": "Папка не найдена", "code": "not_found"})
    conn.execute("DELETE FROM watched_folders WHERE id = ?", (folder_id,))
    conn.commit()
    watcher = getattr(request.app.state, "watcher", None)
    if watcher is not None:
        watcher.start(_watch_roots(request))
    return JSONResponse(status_code=204, content=None)
