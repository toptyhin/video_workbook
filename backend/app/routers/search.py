from __future__ import annotations

import sqlite3

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse

from ..deps import get_db
from ..services import search_service
from ..utils.fts_query import QueryError

router = APIRouter(prefix="/api", tags=["search"])


def _csv(value: str | None) -> list[str]:
    if not value:
        return []
    return [part.strip() for part in value.split(",") if part.strip()]


def _csv_int(value: str | None) -> list[int]:
    result = []
    for part in _csv(value):
        try:
            result.append(int(part))
        except ValueError:
            continue
    return result


@router.get("/search")
def search(
    q: str = "",
    scope: str = "all",
    video_id: int | None = None,
    tag_ids: str | None = None,
    tag_mode: str = "any",
    include_children: int = 1,
    colors: str | None = None,
    limit: int = 20,
    offset: int = 0,
    conn: sqlite3.Connection = Depends(get_db),
):
    try:
        return search_service.search(
            conn,
            q=q,
            scope=scope,
            video_id=video_id,
            tag_ids=_csv_int(tag_ids),
            tag_mode=tag_mode,
            include_children=bool(include_children),
            colors=_csv(colors),
            limit=limit,
            offset=offset,
        )
    except (QueryError, search_service.SearchError) as exc:
        return JSONResponse(
            status_code=getattr(exc, "status_code", 422),
            content={"detail": getattr(exc, "detail", str(exc)), "code": getattr(exc, "code", "invalid_query")},
        )
