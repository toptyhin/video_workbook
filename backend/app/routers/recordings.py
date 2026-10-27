"""API записи экрана/окна (M11, plan §4)."""
from __future__ import annotations

from fastapi import APIRouter, Body, Request
from fastapi.responses import JSONResponse

from ..services.recording import RecordingError, RecordingManager

router = APIRouter(prefix="/api", tags=["recordings"])


def _manager(request: Request) -> RecordingManager:
    return request.app.state.recording


def _error(exc: RecordingError) -> JSONResponse:
    return JSONResponse(
        status_code=exc.status_code,
        content={"detail": exc.detail, "code": exc.code},
    )


def _no_content() -> JSONResponse:
    return JSONResponse(status_code=204, content=None)


@router.get("/recordings/capabilities")
def capabilities(request: Request):
    return _manager(request).capabilities()


@router.post("/recordings")
def start_recording(payload: dict, request: Request):
    try:
        result = _manager(request).start(payload)
    except RecordingError as exc:
        return _error(exc)
    return JSONResponse(status_code=201, content=result)


@router.post("/recordings/{recording_id}/chunks")
def append_chunk(recording_id: str, request: Request, body: bytes = Body(default=b"")):
    try:
        result = _manager(request).append_chunk(recording_id, body)
    except RecordingError as exc:
        return _error(exc)
    return JSONResponse(status_code=202, content=result)


@router.post("/recordings/{recording_id}/pause")
def pause_recording(recording_id: str, request: Request):
    try:
        _manager(request).pause(recording_id)
    except RecordingError as exc:
        return _error(exc)
    return _no_content()


@router.post("/recordings/{recording_id}/resume")
def resume_recording(recording_id: str, request: Request):
    try:
        _manager(request).resume(recording_id)
    except RecordingError as exc:
        return _error(exc)
    return _no_content()


@router.post("/recordings/{recording_id}/finish")
def finish_recording(recording_id: str, request: Request, payload: dict | None = None):
    try:
        result = _manager(request).finish(recording_id, payload)
    except RecordingError as exc:
        return _error(exc)
    return JSONResponse(status_code=201, content=result)


@router.post("/recordings/{recording_id}/cancel")
def cancel_recording(recording_id: str, request: Request):
    try:
        _manager(request).cancel(recording_id)
    except RecordingError as exc:  # pragma: no cover - cancel идемпотентен
        return _error(exc)
    return _no_content()


@router.get("/recordings/{recording_id}")
def recording_state(recording_id: str, request: Request):
    try:
        return _manager(request).state(recording_id)
    except RecordingError as exc:
        return _error(exc)
