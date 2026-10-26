from __future__ import annotations

import sqlite3
from typing import Any

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse

from ..deps import get_db
from ..services import annotations_service, library_service, settings_service, tags_service
from ..services.external_player import ExternalPlayerError

router = APIRouter(prefix="/api", tags=["external"])


def _err(exc: ExternalPlayerError) -> JSONResponse:
    return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail, "code": exc.code})


def _marks(conn: sqlite3.Connection, video_id: int) -> list[dict[str, Any]]:
    items, _total = annotations_service.list_annotations(conn, video_id=video_id)
    paths = tags_service._path_map(conn)
    marks = []
    for item in items:
        marks.append(
            {
                "start_ms": item["start_ms"],
                "end_ms": item["end_ms"],
                "label": item["label"],
                "color": item["color"],
                "tags": [paths[t] for t in item.get("tag_ids", []) if t in paths],
            }
        )
    return marks


@router.get("/external/players")
def players(request: Request, conn: sqlite3.Connection = Depends(get_db)):
    return request.app.state.external.players(settings_service.get_all(conn))


@router.get("/external/status")
def status(request: Request):
    return request.app.state.external.status()


@router.post("/external/launch")
def launch(payload: dict, request: Request, conn: sqlite3.Connection = Depends(get_db)):
    video_id = payload.get("video_id")
    if not isinstance(video_id, int):
        return JSONResponse(status_code=400, content={"detail": "video_id обязателен", "code": "invalid_video"})
    row = library_service.get_video(conn, video_id)
    if row is None:
        return JSONResponse(status_code=404, content={"detail": "Видео не найдено", "code": "video_not_found"})
    settings = settings_service.get_all(conn)
    player = str(payload.get("player") or settings.get("external.player") or "mpv")
    pass_marks = payload.get("pass_marks")
    if pass_marks is None:
        pass_marks = bool(settings.get("external.pass_marks", True))
    start_ms = payload.get("start_ms")
    try:
        start = max(0, int(start_ms)) if start_ms is not None else 0
    except (TypeError, ValueError):
        return JSONResponse(status_code=400, content={"detail": "start_ms должен быть числом", "code": "invalid_start"})
    marks = _marks(conn, video_id) if pass_marks else []
    try:
        return request.app.state.external.launch(
            video=dict(row),
            start_ms=start,
            player=player,
            pass_marks=bool(pass_marks),
            marks=marks,
            player_path=payload.get("player_path") or settings.get("external.player_path") or None,
        )
    except ExternalPlayerError as exc:
        return _err(exc)


@router.post("/external/command")
def command(payload: dict, request: Request):
    action = payload.get("action")
    if not isinstance(action, str):
        return JSONResponse(status_code=400, content={"detail": "action обязателен", "code": "invalid_action"})
    try:
        return request.app.state.external.command(action, payload.get("value"))
    except ExternalPlayerError as exc:
        return _err(exc)


@router.post("/external/stop")
def stop(request: Request):
    request.app.state.external.stop()
    return {"active": False, "session": None}
