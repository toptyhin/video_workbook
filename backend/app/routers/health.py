from __future__ import annotations

import sqlite3

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from ..db import connect

router = APIRouter(prefix="/api", tags=["health"])


@router.get("/health")
def health(request: Request) -> JSONResponse:
    config = request.app.state.config
    db_state = "ok"
    try:
        conn = connect(config.db_path)
        try:
            conn.execute("SELECT 1").fetchone()
        finally:
            conn.close()
    except sqlite3.Error:
        db_state = "error"
    status = "ok" if db_state == "ok" else "degraded"
    body = {"status": status, "version": config.version, "db": db_state}
    return JSONResponse(status_code=200 if status == "ok" else 503, content=body)
