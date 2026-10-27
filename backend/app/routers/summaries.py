"""API смыслового дерева саммари (M14 rev2).

GET отдаёт ``SummaryResponse`` с динамическими уровнями дерева
(``max_level``/``levels``/``root_summary``), POST ставит генерацию
``{level?, force?}`` и отвечает 202 ``{video_id, state, level}``, DELETE
инвалидирует дерево. Формы совпадают с ``frontend/src/api/types.ts``;
доменные ошибки — ``{detail, code}``.
"""
from __future__ import annotations

from fastapi import APIRouter, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from ..services.summary.manager import SummaryError, SummaryManager

router = APIRouter(prefix="/api", tags=["summaries"])


class SummaryGenerateIn(BaseModel):
    model_config = {"extra": "forbid"}
    level: int | None = None
    force: bool = False


def _manager(request: Request) -> SummaryManager:
    manager = getattr(request.app.state, "summary", None)
    if manager is None:
        raise SummaryError("summary_unavailable", "Саммари недоступно", 409)
    return manager


def _error(exc: SummaryError) -> JSONResponse:
    return JSONResponse(
        status_code=exc.status_code,
        content={"detail": exc.detail, "code": exc.code},
    )


@router.get("/videos/{video_id}/summary")
def get_summary(video_id: int, request: Request):
    try:
        return _manager(request).status(video_id)
    except SummaryError as exc:
        return _error(exc)


@router.post("/videos/{video_id}/summary", status_code=202)
def generate_summary(
    video_id: int,
    request: Request,
    payload: SummaryGenerateIn | None = None,
):
    level = payload.level if payload is not None else None
    force = bool(payload.force) if payload is not None else False
    try:
        result = _manager(request).request(video_id, level=level, force=force)
    except SummaryError as exc:
        return _error(exc)
    return JSONResponse(status_code=202, content=result)


@router.delete("/videos/{video_id}/summary", status_code=204)
def delete_summary(video_id: int, request: Request):
    try:
        _manager(request).invalidate(video_id)
    except SummaryError as exc:
        return _error(exc)
    return Response(status_code=204)


__all__ = ["router"]
