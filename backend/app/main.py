"""FastAPI-приложение VideoLessons (A1–A5)."""
from __future__ import annotations

import asyncio
import hmac
import logging
import os
import re
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .config import Config, get_config
from .db import connect, migrate
from .routers import annotations, events, folders, fs, health, search, settings, tags, videos
from .services.events import EventBus
from .services.queue import TranscriptionQueue
from .services.scanner import Scanner
from .services.watcher import LibraryWatcher
from .utils.logging import setup_logging

log = logging.getLogger(__name__)

_QUERY_TOKEN_PATHS = (
    re.compile(r"^/api/events$"),
    re.compile(r"^/api/videos/\d+/stream$"),
)


def _query_token_allowed(path: str) -> bool:
    return any(pattern.match(path) for pattern in _QUERY_TOKEN_PATHS)


def _extract_token(request: Request) -> str:
    token = request.headers.get("x-vl-token") or ""
    if not token and _query_token_allowed(request.url.path):
        token = request.query_params.get("token") or ""
    return token


def create_app(config: Config | None = None) -> FastAPI:
    cfg = config or get_config()
    cfg.ensure_dirs()
    setup_logging(cfg.logs_dir)
    bus = EventBus()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        conn = connect(cfg.db_path)
        try:
            version = migrate(conn, cfg.migrations_dir)
            log.info("Database ready, schema version %s", version)
            roots = [row["path"] for row in conn.execute("SELECT path FROM watched_folders ORDER BY path")]
        finally:
            conn.close()
        bus.bind_loop(asyncio.get_running_loop())
        scanner = Scanner(cfg, bus)
        scanner.bind_loop(asyncio.get_running_loop())
        transcription_queue = TranscriptionQueue(cfg, bus)
        watcher = LibraryWatcher(cfg, bus)
        transcription_queue.start()
        watcher.start(roots)
        app.state.bus = bus
        app.state.scanner = scanner
        app.state.queue = transcription_queue
        app.state.watcher = watcher
        try:
            yield
        finally:
            transcription_queue.stop()
            watcher.stop()

    app = FastAPI(
        title="VideoLessons",
        version=cfg.version,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        lifespan=lifespan,
    )
    app.state.config = cfg
    app.state.bus = bus

    @app.middleware("http")
    async def require_token(request: Request, call_next):
        if request.url.path.startswith("/api/"):
            supplied = _extract_token(request)
            if not hmac.compare_digest(supplied, cfg.token):
                return JSONResponse(
                    status_code=401,
                    content={"detail": "unauthorized", "code": "unauthorized"},
                )
        return await call_next(request)

    app.include_router(health.router)
    app.include_router(settings.router)
    app.include_router(events.router)
    app.include_router(folders.router)
    app.include_router(fs.router)
    app.include_router(videos.router)
    app.include_router(tags.router)
    app.include_router(search.router)
    app.include_router(annotations.router)

    _mount_frontend(app, cfg)
    return app


def _mount_frontend(app: FastAPI, cfg: Config) -> None:
    frontend = cfg.frontend_dir
    index = frontend / "index.html"
    if not index.exists():
        log.info("Frontend build not found at %s; running API-only", frontend)
        return
    assets = frontend / "assets"
    if assets.exists():
        app.mount("/assets", StaticFiles(directory=str(assets)), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    async def spa(full_path: str):
        if full_path.startswith("api/"):
            raise HTTPException(status_code=404, detail="not found")
        candidate = (frontend / full_path).resolve()
        try:
            candidate.relative_to(frontend.resolve())
        except ValueError:
            raise HTTPException(status_code=404, detail="not found") from None
        if full_path and candidate.is_file():
            return FileResponse(candidate)
        return FileResponse(index, headers={"Cache-Control": "no-cache"})


def run() -> None:
    """Sidecar entrypoint: печатает VL_READY:{"port": N} после старта."""
    import uvicorn

    cfg = get_config()
    port = int(os.environ.get("VL_PORT", "0"))
    server = uvicorn.Server(
        uvicorn.Config(
            create_app(cfg),
            host=cfg.host,
            port=port,
            log_config=None,
            access_log=False,
            lifespan="on",
        )
    )

    async def runner() -> None:
        task = asyncio.create_task(server.serve())
        while not server.started:
            if task.done():
                break
            await asyncio.sleep(0.01)
        if server.started:
            sock = server.servers[0].sockets[0]
            actual_port = sock.getsockname()[1]
            print(f'VL_READY:{{"port":{actual_port}}}', flush=True)
            if cfg.token_generated:
                print(f'VL_TOKEN:{cfg.token}', flush=True)
        await task

    try:
        asyncio.run(runner())
    except KeyboardInterrupt:  # pragma: no cover
        pass


if __name__ == "__main__":
    run()
