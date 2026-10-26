from __future__ import annotations

import sqlite3

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse

from ..deps import get_db
from ..services import settings_service

MODEL_NAMES = ("tiny", "base", "small", "medium")

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


@router.get("/models")
def list_models(request: Request) -> dict:
    config = request.app.state.config
    items = []
    total_size = 0
    for name in MODEL_NAMES:
        path = config.resources_dir / "models" / f"faster-whisper-{name}"
        bundled = (path / "model.bin").exists()
        size_bytes = 0
        if bundled:
            for file in path.rglob("*"):
                if file.is_file():
                    size_bytes += file.stat().st_size
        total_size += size_bytes
        items.append(
            {
                "name": name,
                "path": str(path) if bundled else None,
                "size_bytes": size_bytes,
                "bundled": bundled,
                "quantized": True,
            }
        )
    return {"items": items, "total": total_size}


@router.post("/maintenance/clear-model-cache")
def clear_model_cache(request: Request) -> dict:
    config = request.app.state.config
    cache_dir = config.data_dir / "cache" / "models"
    removed_bytes = 0
    removed_files = 0
    if cache_dir.exists():
        for file in sorted(cache_dir.rglob("*"), reverse=True):
            if file.is_file():
                removed_bytes += file.stat().st_size
                file.unlink(missing_ok=True)
                removed_files += 1
            elif file.is_dir():
                file.rmdir()
    return {"removed_bytes": removed_bytes, "removed_files": removed_files}
