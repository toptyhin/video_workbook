from __future__ import annotations

import sqlite3

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse

from ..deps import get_db
from ..services import tags_service

router = APIRouter(prefix="/api", tags=["tags"])


def _err(exc: tags_service.TagError) -> JSONResponse:
    return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail, "code": exc.code})


def _publish(request: Request, action: str, tag_ids: list[int] | None = None) -> None:
    request.app.state.bus.publish("tags.changed", {"action": action, "tag_ids": tag_ids or []})


@router.get("/tags/tree")
def tags_tree(include_counts: int = 1, conn: sqlite3.Connection = Depends(get_db)):
    items = tags_service.tree(conn, include_counts=bool(include_counts))
    return {"items": items, "total": len(items)}


@router.post("/tags")
def create_tag(payload: dict, request: Request, conn: sqlite3.Connection = Depends(get_db)):
    try:
        node = tags_service.create(
            conn, payload.get("parent_id"), payload.get("name", ""), payload.get("color")
        )
    except tags_service.TagError as exc:
        return _err(exc)
    _publish(request, "create", [node["id"]])
    return JSONResponse(status_code=201, content=node)


@router.patch("/tags/{tag_id}")
def update_tag(tag_id: int, payload: dict, request: Request, conn: sqlite3.Connection = Depends(get_db)):
    try:
        node = tags_service.update(conn, tag_id, payload)
    except tags_service.TagError as exc:
        return _err(exc)
    _publish(request, "update", [tag_id])
    return node


@router.delete("/tags/{tag_id}")
def delete_tag(tag_id: int, request: Request, conn: sqlite3.Connection = Depends(get_db)):
    try:
        tags_service.delete(conn, tag_id)
    except tags_service.TagError as exc:
        return _err(exc)
    _publish(request, "delete", [tag_id])
    return JSONResponse(status_code=204, content=None)


@router.get("/tags/export")
def export_tags(conn: sqlite3.Connection = Depends(get_db)):
    return tags_service.export_tree(conn)


@router.post("/tags/import")
def import_tags(payload: dict, request: Request, conn: sqlite3.Connection = Depends(get_db)):
    data = payload.get("data", payload)
    mode = payload.get("mode", "merge")
    try:
        result = tags_service.import_tree(conn, data, mode)
    except tags_service.TagError as exc:
        return _err(exc)
    _publish(request, "import")
    return result


@router.post("/videos/{video_id}/tags")
def assign_video_tag(video_id: int, payload: dict, request: Request, conn: sqlite3.Connection = Depends(get_db)):
    tag_id = payload.get("tag_id")
    if not isinstance(tag_id, int):
        return JSONResponse(status_code=400, content={"detail": "tag_id обязателен", "code": "invalid_tag_id"})
    try:
        tags_service.assign_video_tag(conn, video_id, tag_id)
    except tags_service.TagError as exc:
        return _err(exc)
    _publish(request, "assign", [tag_id])
    return JSONResponse(status_code=204, content=None)


@router.delete("/videos/{video_id}/tags/{tag_id}")
def remove_video_tag(video_id: int, tag_id: int, request: Request, conn: sqlite3.Connection = Depends(get_db)):
    tags_service.remove_video_tag(conn, video_id, tag_id)
    _publish(request, "unassign", [tag_id])
    return JSONResponse(status_code=204, content=None)


@router.post("/segments/{segment_id}/tags")
def assign_segment_tag(segment_id: int, payload: dict, request: Request, conn: sqlite3.Connection = Depends(get_db)):
    tag_id = payload.get("tag_id")
    if not isinstance(tag_id, int):
        return JSONResponse(status_code=400, content={"detail": "tag_id обязателен", "code": "invalid_tag_id"})
    try:
        tags_service.assign_segment_tag(conn, segment_id, tag_id)
    except tags_service.TagError as exc:
        return _err(exc)
    _publish(request, "assign", [tag_id])
    return JSONResponse(status_code=204, content=None)


@router.delete("/segments/{segment_id}/tags/{tag_id}")
def remove_segment_tag(segment_id: int, tag_id: int, request: Request, conn: sqlite3.Connection = Depends(get_db)):
    tags_service.remove_segment_tag(conn, segment_id, tag_id)
    _publish(request, "unassign", [tag_id])
    return JSONResponse(status_code=204, content=None)
