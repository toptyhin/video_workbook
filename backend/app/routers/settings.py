from __future__ import annotations

import sqlite3

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse

from ..deps import get_db
from ..services import settings_service

router = APIRouter(prefix="/api", tags=["settings"])


@router.get("/settings")
def get_settings(conn: sqlite3.Connection = Depends(get_db)) -> dict:
    return settings_service.get_all(conn)


@router.patch("/settings")
def patch_settings(
    payload: dict,
    request: Request,
    conn: sqlite3.Connection = Depends(get_db),
) -> JSONResponse:
    try:
        values = settings_service.patch(conn, payload)
    except settings_service.SettingsError as exc:
        return JSONResponse(status_code=400, content={"detail": exc.detail, "code": exc.code})
    request.app.state.bus.publish("settings.changed", {"keys": list(payload.keys())})
    return JSONResponse(content=values)


@router.post("/maintenance/clear-preview-cache")
def clear_preview_cache(request: Request) -> dict:
    return request.app.state.preview.clear_cache()
