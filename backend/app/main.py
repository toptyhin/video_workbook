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
from .routers import (
    annotations,
    events,
    external,
    folders,
    fs,
    health,
    recordings,
    search,
    settings,
    summaries,
    tags,
    videos,
)
from .routers import (
    models as models_router,
)
from .services.embeddings import SemanticIndexManager
from .services.events import EventBus
from .services.external_player import ExternalPlayerManager
from .services.model_store import ModelStore
from .services.preview import PreviewManager
from .services.queue import TranscriptionQueue
from .services.recording import RecordingManager
from .services.scanner import Scanner
from .services.summary.manager import SummaryManager
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
        embeddings = SemanticIndexManager(cfg, bus)
        transcription_queue = TranscriptionQueue(cfg, bus, embeddings)
        watcher = LibraryWatcher(cfg, bus)
        preview = PreviewManager(cfg, bus)
        external_player = ExternalPlayerManager(cfg, bus)
        recording = RecordingManager(cfg, bus)
        recording.cleanup_stale_tmp()
        summary = SummaryManager(cfg, bus)
        model_store = ModelStore(cfg, bus)

        def _model_in_use(model_id: str) -> bool:
            try:
                conn = connect(cfg.db_path)
                try:
                    from .services.settings_service import get_all

                    settings_values = get_all(conn)
                    indexing = bool(embeddings.status(conn).get("indexing"))
                finally:
                    conn.close()
            except Exception:  # pragma: no cover - занятость не должна ломать удаление
                settings_values = {}
                indexing = False
            if model_id == f"whisper-{settings_values.get('whisper_model', 'small')}":
                return not transcription_queue.is_idle()
            if model_id == "embedding-e5-small":
                return indexing
            if model_id == settings_values.get("summary.model"):
                return summary.is_busy()
            return False

        model_store.set_in_use_checker(_model_in_use)
        # M14: саммари не конкурирует за CPU с транскрипцией/индексацией.
        summary.set_compute_gate(
            lambda: not transcription_queue.state().get("current")
            and not transcription_queue.state().get("pending")
        )
        transcription_queue.start()
        embeddings.start()
        summary.start()
        model_store.start()
        transcription_queue.set_done_callback(summary.on_transcription_done)
        watcher.start(roots)
        app.state.bus = bus
        app.state.scanner = scanner
        app.state.embeddings = embeddings
        app.state.queue = transcription_queue
        app.state.watcher = watcher
        app.state.preview = preview
        app.state.external = external_player
        app.state.recording = recording
        app.state.summary = summary
        app.state.models = model_store
        try:
            yield
        finally:
            model_store.shutdown()
            summary.shutdown()
            transcription_queue.stop()
            embeddings.shutdown()
            watcher.stop()
            preview.stop()
            external_player.stop()
            recording.shutdown()

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
    app.include_router(external.router)
    app.include_router(recordings.router)
    app.include_router(summaries.router)
    app.include_router(models_router.router)

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
