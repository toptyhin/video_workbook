from __future__ import annotations

import sqlite3
from pathlib import Path

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse

from ..deps import get_db

router = APIRouter(prefix="/api", tags=["fs"])


def _is_within(path: Path, root: Path) -> bool:
    return path == root or root in path.parents


@router.get("/fs/list")
def list_dir(path: str = "", conn: sqlite3.Connection = Depends(get_db)):
    roots = [Path(row["path"]).resolve() for row in conn.execute("SELECT path FROM watched_folders ORDER BY path")]
    if not path:
        entries = []
        for root in roots:
            try:
                mtime_ms = int(root.stat().st_mtime * 1000)
            except OSError:
                mtime_ms = 0
            entries.append({"name": root.name, "path": str(root), "mtime_ms": mtime_ms, "watched": True})
        return {"path": "", "parent": None, "entries": entries}
    try:
        target = Path(path).expanduser().resolve()
    except OSError:
        return JSONResponse(status_code=400, content={"detail": "Неверный путь", "code": "invalid_path"})
    if not target.is_dir():
        return JSONResponse(status_code=404, content={"detail": "Каталог не найден", "code": "not_found"})
    parent: str | None = None
    allowed = False
    for root in roots:
        if _is_within(target, root):
            allowed = True
            if target != root:
                parent = str(target.parent)
            break
    if not allowed:
        return JSONResponse(
            status_code=403,
            content={"detail": "Путь вне отслеживаемых папок", "code": "forbidden_path"},
        )
    entries = []
    try:
        children = sorted((child for child in target.iterdir() if child.is_dir()), key=lambda p: p.name.lower())
    except OSError as exc:
        return JSONResponse(status_code=400, content={"detail": str(exc), "code": "invalid_path"})
    for child in children:
        try:
            mtime_ms = int(child.stat().st_mtime * 1000)
        except OSError:
            mtime_ms = 0
        entries.append(
            {
                "name": child.name,
                "path": str(child),
                "mtime_ms": mtime_ms,
                "watched": any(child.resolve() == root for root in roots),
            }
        )
    return {"path": str(target), "parent": parent, "entries": entries}
