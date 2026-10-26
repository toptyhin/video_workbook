from __future__ import annotations

import sqlite3

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import JSONResponse

from ..deps import get_db
from ..services import annotations_service

router = APIRouter(prefix="/api", tags=["annotations"])


def _err(exc: annotations_service.AnnotationError) -> JSONResponse:
    return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail, "code": exc.code})


def _publish(request: Request, video_id: int, op: str, ids: list[int]) -> None:
    request.app.state.bus.publish("annotations.changed", {"video_id": video_id, "op": op, "ids": ids})


@router.get("/annotations/export")
def export_annotations(video_id: int | None = None, conn: sqlite3.Connection = Depends(get_db)):
    try:
        return annotations_service.export(conn, video_id)
    except annotations_service.AnnotationError as exc:
        return _err(exc)


@router.post("/annotations/import")
def import_annotations(payload: dict, request: Request, conn: sqlite3.Connection = Depends(get_db)):
    try:
        result = annotations_service.import_data(conn, payload, payload.get("video_id"))
    except annotations_service.AnnotationError as exc:
        return _err(exc)
    request.app.state.bus.publish("annotations.changed", {"video_id": payload.get("video_id"), "op": "import", "ids": []})
    return result


@router.post("/annotations/bulk", status_code=201)
def bulk_create(payload: dict, request: Request, conn: sqlite3.Connection = Depends(get_db)):
    video_id = payload.get("video_id")
    items = payload.get("items")
    if not isinstance(video_id, int) or not isinstance(items, list):
        return JSONResponse(
            status_code=400,
            content={"detail": "video_id и items обязательны", "code": "annotation_invalid_range"},
        )
    try:
        created = annotations_service.bulk_create(conn, video_id, items)
    except annotations_service.AnnotationError as exc:
        return _err(exc)
    _publish(request, video_id, "bulk", [item["id"] for item in created])
    return {"items": created, "total": len(created)}


@router.get("/annotations")
def list_annotations(
    video_id: int | None = None,
    tag_id: list[int] | None = Query(default=None),
    color: str | None = None,
    q: str | None = None,
    limit: int = 500,
    offset: int = 0,
    conn: sqlite3.Connection = Depends(get_db),
):
    items, total = annotations_service.list_annotations(
        conn, video_id=video_id, tag_id=tag_id, color=color, q=q, limit=limit, offset=offset
    )
    return {"items": items, "total": total}


@router.post("/annotations")
def create_annotation(payload: dict, request: Request, conn: sqlite3.Connection = Depends(get_db)):
    try:
        annotation = annotations_service.create(conn, payload)
    except annotations_service.AnnotationError as exc:
        return _err(exc)
    _publish(request, int(annotation["video_id"]), "create", [annotation["id"]])
    return JSONResponse(status_code=201, content=annotation)


@router.get("/annotations/{annotation_id}")
def get_annotation(annotation_id: int, conn: sqlite3.Connection = Depends(get_db)):
    try:
        return annotations_service.get(conn, annotation_id)
    except annotations_service.AnnotationError as exc:
        return _err(exc)


@router.patch("/annotations/{annotation_id}")
def update_annotation(annotation_id: int, payload: dict, request: Request, conn: sqlite3.Connection = Depends(get_db)):
    try:
        annotation = annotations_service.update(conn, annotation_id, payload)
    except annotations_service.AnnotationError as exc:
        return _err(exc)
    _publish(request, int(annotation["video_id"]), "update", [annotation_id])
    return annotation


@router.delete("/annotations/{annotation_id}")
def delete_annotation(annotation_id: int, request: Request, conn: sqlite3.Connection = Depends(get_db)):
    row = conn.execute("SELECT video_id FROM annotations WHERE id = ?", (annotation_id,)).fetchone()
    try:
        annotations_service.delete(conn, annotation_id)
    except annotations_service.AnnotationError as exc:
        return _err(exc)
    if row is not None:
        _publish(request, int(row["video_id"]), "delete", [annotation_id])
    return JSONResponse(status_code=204, content=None)
