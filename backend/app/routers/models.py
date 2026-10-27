"""API менеджера моделей (M13, plans/13-model-store.md §4.3).

Роутер не содержит бизнес-логики: все операции делегируются
`app.state.models` (`services/model_store.ModelStore`), ошибки — `{detail, code}`.
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response

from ..services.model_store import ModelError, ModelStore

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["models"])


def _store(request: Request) -> ModelStore | JSONResponse:
    store = getattr(request.app.state, "models", None)
    if store is None:
        return JSONResponse(
            status_code=503,
            content={
                "detail": "Менеджер моделей недоступен",
                "code": "models_unavailable",
            },
        )
    return store


def _error(exc: ModelError) -> JSONResponse:
    return JSONResponse(
        status_code=exc.status_code,
        content={"detail": exc.detail, "code": exc.code},
    )


@router.get("/models")
def list_models(request: Request) -> JSONResponse:
    store = _store(request)
    if isinstance(store, JSONResponse):
        return store
    return JSONResponse(status_code=200, content=store.list_models())


@router.post("/models/{model_id}/download")
def download_model(model_id: str, request: Request) -> JSONResponse:
    store = _store(request)
    if isinstance(store, JSONResponse):
        return store
    try:
        result = store.download(model_id)
    except ModelError as exc:
        return _error(exc)
    return JSONResponse(status_code=202, content=result)


@router.post("/models/{model_id}/cancel")
def cancel_model(model_id: str, request: Request) -> JSONResponse:
    store = _store(request)
    if isinstance(store, JSONResponse):
        return store
    try:
        result = store.cancel(model_id)
    except ModelError as exc:
        return _error(exc)
    return JSONResponse(status_code=200, content=result)


@router.delete("/models/{model_id}")
def delete_model(model_id: str, request: Request) -> Response:
    store = _store(request)
    if isinstance(store, JSONResponse):
        return store
    try:
        store.delete(model_id)
    except ModelError as exc:
        return _error(exc)
    return Response(status_code=204)


@router.post("/models/{model_id}/import")
def import_model(model_id: str, request: Request, payload: dict | None = None) -> JSONResponse:
    store = _store(request)
    if isinstance(store, JSONResponse):
        return store
    path = (payload or {}).get("path") if isinstance(payload, dict) else None
    if not isinstance(path, str) or not path.strip():
        return JSONResponse(
            status_code=400,
            content={"detail": "Ожидается непустой путь {path}", "code": "import_path_invalid"},
        )
    try:
        store.import_model(model_id, path)
    except ModelError as exc:
        return _error(exc)
    # Контракт §4.3: 202 {"id","status":"verifying"}. Импорт из каталога/архива
    # выполняется синхронно (валидация и атомарная установка), SSE завершает
    # состояние событием model.state ready; ответ оставлен асинхронным по контракту.
    return JSONResponse(status_code=202, content={"id": model_id, "status": "verifying"})


__all__ = ["router"]
