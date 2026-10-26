from __future__ import annotations

import sqlite3
from pathlib import Path

from fastapi import APIRouter, Depends, Request
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse

from ..db import connect
from ..deps import get_db
from ..services import library_service
from ..services.queue import QueueError
from ..services.streaming import RangeNotSatisfiable, iter_file, parse_range
from ..services.thumbnail import drop_thumbs, ensure_thumb

router = APIRouter(prefix="/api", tags=["videos"])

MEDIA_TYPES = {
    ".mp4": "video/mp4",
    ".m4v": "video/mp4",
    ".webm": "video/webm",
    ".mkv": "video/x-matroska",
    ".mov": "video/quicktime",
    ".avi": "video/x-msvideo",
}


def _error(status: int, detail: str, code: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"detail": detail, "code": code})


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


@router.get("/videos")
def list_videos(
    folder: str | None = None,
    tag_ids: str | None = None,
    tag_mode: str = "any",
    include_children: int = 1,
    status: str | None = None,
    q: str | None = None,
    sort: str = "added_at",
    dir: str = "desc",
    limit: int = 50,
    offset: int = 0,
    conn: sqlite3.Connection = Depends(get_db),
):
    try:
        items, total = library_service.list_videos(
            conn,
            folder=folder,
            tag_ids=_csv_int(tag_ids),
            tag_mode=tag_mode,
            include_children=bool(include_children),
            statuses=_csv(status),
            query=q,
            sort=sort,
            direction=dir,
            limit=limit,
            offset=offset,
        )
    except library_service.LibraryError as exc:
        return _error(exc.status_code, exc.detail, exc.code)
    return {"items": items, "total": total}


@router.delete("/videos/{video_id}")
def delete_video(video_id: int, request: Request, conn: sqlite3.Connection = Depends(get_db)):
    path = library_service.delete_video(conn, video_id)
    if path is None:
        return _error(404, "Видео не найдено", "not_found")
    drop_thumbs(request.app.state.config, video_id)
    queue = getattr(request.app.state, "queue", None)
    if queue is not None:
        try:
            queue.cancel(video_id)
        except QueueError:
            pass
    request.app.state.bus.publish("video.status", {"video_id": video_id, "status": "deleted"})
    return JSONResponse(status_code=204, content=None)


@router.post("/videos/scan")
def scan(payload: dict, request: Request):
    raw = payload.get("path")
    if not isinstance(raw, str) or not raw.strip():
        return _error(400, "path обязателен", "invalid_path")
    target = Path(raw).expanduser().resolve()
    if not target.exists():
        return _error(400, "Путь не найден", "invalid_path")
    if target.is_dir():
        conn = connect(request.app.state.config.db_path)
        try:
            existing = conn.execute(
                "SELECT id, path FROM watched_folders WHERE path = ?", (str(target),)
            ).fetchone()
            if existing is None:
                conn.execute("INSERT INTO watched_folders(path) VALUES (?)", (str(target),))
                conn.commit()
                watcher = getattr(request.app.state, "watcher", None)
                if watcher is not None:
                    roots = [
                        row["path"] for row in conn.execute("SELECT path FROM watched_folders ORDER BY path")
                    ]
                    watcher.start(roots)
        finally:
            conn.close()
    scanner = request.app.state.scanner
    scan_id = scanner.start_scan(str(target))
    return JSONResponse(
        status_code=202, content={"scan_id": scan_id, "state": "running", "root": str(target)}
    )


@router.post("/videos/enqueue")
def enqueue(payload: dict, request: Request):
    ids = payload.get("ids")
    if not isinstance(ids, list) or not ids:
        return _error(400, "ids должен быть непустым списком", "invalid_ids")
    try:
        result = request.app.state.queue.enqueue([int(value) for value in ids])
    except (TypeError, ValueError):
        return _error(400, "ids должен содержать числа", "invalid_ids")
    except QueueError as exc:
        return _error(exc.status_code, exc.detail, exc.code)
    return result


@router.post("/videos/{video_id}/cancel")
def cancel(video_id: int, request: Request):
    try:
        return request.app.state.queue.cancel(video_id)
    except QueueError as exc:
        return _error(exc.status_code, exc.detail, exc.code)


@router.post("/videos/{video_id}/reprocess")
def reprocess(video_id: int, request: Request):
    conn = connect(request.app.state.config.db_path)
    try:
        row = conn.execute("SELECT id, status FROM videos WHERE id = ?", (video_id,)).fetchone()
        if row is None:
            return _error(404, "Видео не найдено", "not_found")
        if row["status"] in {"queued", "processing"}:
            return _error(409, "Файл уже обрабатывается", "invalid_state")
        conn.execute("DELETE FROM segments WHERE video_id = ?", (video_id,))
        conn.execute(
            "UPDATE videos SET status = 'queued', progress = 0, error = NULL, processed_at = NULL "
            "WHERE id = ?",
            (video_id,),
        )
        conn.commit()
    finally:
        conn.close()
    request.app.state.queue.enqueue([video_id])
    return JSONResponse(status_code=202, content={"id": video_id, "status": "queued"})


@router.get("/queue")
def queue_state(request: Request):
    return request.app.state.queue.state()


@router.get("/videos/{video_id}/segments")
def segments(video_id: int, conn: sqlite3.Connection = Depends(get_db)):
    if library_service.get_video(conn, video_id) is None:
        return _error(404, "Видео не найдено", "not_found")
    return library_service.list_segments(conn, video_id)


def _range_response(request: Request, path: Path, media_type: str):
    size = path.stat().st_size
    headers = {
        "Accept-Ranges": "bytes",
        "Referrer-Policy": "no-referrer",
        "Cache-Control": "no-store",
    }
    try:
        parsed = parse_range(request.headers.get("range"), size)
    except RangeNotSatisfiable:
        return JSONResponse(
            status_code=416,
            content={"detail": "Диапазон неудовлетворителен", "code": "range_not_satisfiable"},
            headers={"Content-Range": f"bytes */{size}"},
        )
    if parsed is None:
        return StreamingResponse(
            iter_file(path, 0, size - 1),
            media_type=media_type,
            headers={**headers, "Content-Length": str(size)},
        )
    start, end = parsed
    return StreamingResponse(
        iter_file(path, start, end),
        status_code=206,
        media_type=media_type,
        headers={
            **headers,
            "Content-Range": f"bytes {start}-{end}/{size}",
            "Content-Length": str(end - start + 1),
        },
    )


@router.get("/videos/{video_id}/stream")
def stream(video_id: int, request: Request, conn: sqlite3.Connection = Depends(get_db)):
    row = library_service.get_video(conn, video_id)
    if row is None:
        return _error(404, "Видео не найдено", "not_found")
    path = Path(row["path"])
    if not path.exists():
        return _error(404, "Файл не найден на диске", "file_missing")
    return _range_response(request, path, MEDIA_TYPES.get(path.suffix.lower(), "application/octet-stream"))


@router.get("/videos/{video_id}/playback")
def playback_info(video_id: int, request: Request, conn: sqlite3.Connection = Depends(get_db)):
    row = library_service.get_video(conn, video_id)
    if row is None:
        return _error(404, "Видео не найдено", "not_found")
    return request.app.state.preview.plan(dict(row))


@router.post("/videos/{video_id}/prepare-preview")
def prepare_preview(video_id: int, request: Request, conn: sqlite3.Connection = Depends(get_db)):
    row = library_service.get_video(conn, video_id)
    if row is None:
        return _error(404, "Видео не найдено", "not_found")
    info = request.app.state.preview.start(dict(row))
    if info.get("mode") == "unsupported":
        return JSONResponse(
            status_code=422,
            content={"detail": info.get("error") or "Неподдерживаемый файл", "code": "preview_unsupported"},
        )
    return JSONResponse(
        status_code=202 if info.get("state") in {"queued", "preparing"} else 200,
        content=info,
    )


@router.get("/videos/{video_id}/preview")
def preview_stream(video_id: int, request: Request, conn: sqlite3.Connection = Depends(get_db)):
    row = library_service.get_video(conn, video_id)
    if row is None:
        return _error(404, "Видео не найдено", "not_found")
    manager = request.app.state.preview
    path = manager.preview_file(dict(row))
    if path is not None:
        return _range_response(request, path, "video/mp4")
    info = manager.plan(dict(row))
    if info.get("mode") == "direct":
        return JSONResponse(status_code=409, content={"detail": "Превью не требуется", "code": "preview_direct"})
    if info.get("state") in {"queued", "preparing"}:
        return JSONResponse(
            status_code=409,
            content={"detail": "Превью готовится", "code": "preview_preparing", "progress": info.get("progress", 0)},
        )
    if info.get("state") == "error":
        return JSONResponse(
            status_code=422,
            content={"detail": info.get("error") or "Не удалось подготовить превью", "code": "preview_failed"},
        )
    return JSONResponse(status_code=409, content={"detail": "Превью не готово", "code": "preview_not_ready"})


@router.get("/videos/{video_id}/thumb")
def thumb(video_id: int, request: Request, at_ms: int | None = None, conn: sqlite3.Connection = Depends(get_db)):
    row = library_service.get_video(conn, video_id)
    if row is None:
        return _error(404, "Видео не найдено", "not_found")
    config = request.app.state.config
    path = ensure_thumb(config, video_id, row["path"], row["duration_ms"], row["mtime_ms"], at_ms)
    if path is None:
        return _error(404, "Превью недоступно", "thumb_unavailable")
    return FileResponse(path, media_type="image/jpeg", headers={"Cache-Control": "private, max-age=3600"})
