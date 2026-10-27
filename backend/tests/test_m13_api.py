"""M13: API менеджера моделей (plans/13 §4.3) через TestClient, без сети."""
from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.routers import models as models_router
from app.services import model_store, settings_service
from app.services.model_store import ModelStore
from tests.test_m13_common import (
    DEFAULT_ID,
    DEFAULT_LOCAL_DIR,
    ModelHTTPServer,
    RecordingBus,
    install_entry,
    migrate_db,
    model_entry,
    use_manifest,
    wait_status,
)


@pytest.fixture(autouse=True)
def _db(config):
    migrate_db(config)


@pytest.fixture(autouse=True)
def _big_disk(monkeypatch):
    monkeypatch.setattr(model_store, "_free_disk_bytes", lambda path: 10**12)


@pytest.fixture
def server():
    instance = ModelHTTPServer()
    try:
        yield instance
    finally:
        instance.close()


@pytest.fixture
def entry(server, monkeypatch):
    payload = b"api-model-data" * 100
    entry, contents = model_entry([("weights.bin", payload)])
    use_manifest(monkeypatch, [entry])
    for remote, data in contents.items():
        server.add(remote, data)
    monkeypatch.setenv("VL_MODELS_ENDPOINT", server.url)
    return entry, contents


@pytest.fixture
def api(config, entry):
    app = FastAPI()
    app.include_router(models_router.router)
    app.state.config = config
    bus = RecordingBus()
    store = ModelStore(config, bus)
    store.start()
    app.state.bus = bus
    app.state.models = store
    try:
        with TestClient(app) as client:
            yield client, store, app, config
    finally:
        store.shutdown()


def test_list_models(api):
    client, _store, _app, config = api
    response = client.get("/api/models")
    assert response.status_code == 200
    body = response.json()
    assert set(body) == {
        "items",
        "total_installed_bytes",
        "total_available_bytes",
        "models_dir",
        "offline",
    }
    assert body["models_dir"] == str(config.models_dir)
    assert body["offline"] is False
    item = body["items"][0]
    for field in (
        "id",
        "kind",
        "label",
        "installed",
        "bundled",
        "status",
        "revision",
        "update_available",
        "size_bytes",
        "progress",
        "license",
        "recommended",
        "default",
        "meta",
        "path",
        "error",
        "error_code",
    ):
        assert field in item
    assert item["status"] == "absent"
    assert item["recommended"] is True and item["default"] is True


def test_download_cancel_delete_flow(api, entry):
    client, store, _app, config = api
    entry_data, _contents = entry
    model_id = entry_data["id"]
    response = client.post(f"/api/models/{model_id}/download")
    assert response.status_code == 202
    assert response.json() == {"id": model_id, "status": "queued"}
    wait_status(store, model_id, {"ready"})
    # повторная загрузка установленной модели — 409
    again = client.post(f"/api/models/{model_id}/download")
    assert again.status_code == 409
    assert again.json()["code"] == "already_installed"
    installed = client.get("/api/models").json()["items"][0]
    assert installed["status"] == "ready"
    assert installed["installed"] is True
    assert client.post(f"/api/models/{model_id}/cancel").status_code == 200
    assert client.delete(f"/api/models/{model_id}").status_code == 204
    assert not (config.models_dir / DEFAULT_LOCAL_DIR).exists()
    assert client.get("/api/models").json()["items"][0]["status"] == "absent"


def test_cancel_idempotent(api, entry):
    client, _store, _app, _config = api
    response = client.post(f"/api/models/{DEFAULT_ID}/cancel")
    assert response.status_code == 200
    assert response.json() == {"id": DEFAULT_ID, "status": "absent"}
    assert client.post(f"/api/models/{DEFAULT_ID}/cancel").status_code == 200


def test_download_unknown_model(api):
    client, _store, _app, _config = api
    response = client.post("/api/models/nope/download")
    assert response.status_code == 404
    assert response.json()["code"] == "unknown_model"


def test_download_offline(api, entry):
    client, _store, _app, config = api
    config.offline = True
    response = client.post(f"/api/models/{DEFAULT_ID}/download")
    assert response.status_code == 403
    assert response.json()["code"] == "offline_mode"


def test_download_insufficient_disk(api, entry, monkeypatch):
    client, _store, _app, _config = api
    monkeypatch.setattr(model_store, "_free_disk_bytes", lambda path: 1)
    response = client.post(f"/api/models/{DEFAULT_ID}/download")
    assert response.status_code == 409
    assert response.json()["code"] == "insufficient_disk"


def test_delete_bundled(api, config, entry):
    client, _store, _app, _config = api
    entry_data, contents = entry
    install_entry(config, entry_data, contents, legacy=True)
    response = client.delete(f"/api/models/{DEFAULT_ID}")
    assert response.status_code == 409
    assert response.json()["code"] == "model_bundled"


def test_delete_in_use(api, config):
    client, store, _app, _config = api
    entry, contents = model_entry([("weights.bin", b"data")])
    install_entry(config, entry, contents)
    store.set_in_use_checker(lambda model_id: True)
    response = client.delete(f"/api/models/{DEFAULT_ID}")
    assert response.status_code == 409
    assert response.json()["code"] == "model_in_use"


def test_import_validation(api, tmp_path):
    client, _store, _app, _config = api
    response = client.post(f"/api/models/{DEFAULT_ID}/import", json={})
    assert response.status_code == 400
    assert response.json()["code"] == "import_path_invalid"
    missing = client.post(
        f"/api/models/{DEFAULT_ID}/import", json={"path": str(tmp_path / "nope")}
    )
    assert missing.status_code == 400
    assert missing.json()["code"] == "import_path_invalid"


def test_import_success(api, entry, config, tmp_path):
    client, _store, _app, _config = api
    entry_data, contents = entry
    model_id = entry_data["id"]
    source = tmp_path / "src"
    for local, data in contents.items():
        target = source / local
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    response = client.post(f"/api/models/{model_id}/import", json={"path": str(source)})
    assert response.status_code == 202
    assert response.json() == {"id": model_id, "status": "verifying"}
    installed = client.get("/api/models").json()["items"][0]
    assert installed["status"] == "ready"
    assert installed["installed"] is True
    assert (config.models_dir / DEFAULT_LOCAL_DIR / "weights.bin").is_file()


def test_import_checksum_mismatch(api, entry, tmp_path):
    client, _store, _app, _config = api
    _model_id, contents = entry
    source = tmp_path / "src"
    for local, data in contents.items():
        target = source / local
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    (source / "weights.bin").write_bytes(b"tampered")
    response = client.post(f"/api/models/{DEFAULT_ID}/import", json={"path": str(source)})
    assert response.status_code == 400
    assert response.json()["code"] == "checksum_mismatch"


def test_api_without_store_returns_503(config):
    app = FastAPI()
    app.include_router(models_router.router)
    app.state.config = config
    with TestClient(app) as client:
        response = client.get("/api/models")
    assert response.status_code == 503
    assert response.json()["code"] == "models_unavailable"


def test_list_models_reflects_settings_offline(api, config):
    client, _store, _app, _config = api
    from app.db import connect

    conn = connect(config.db_path)
    try:
        settings_service.patch(conn, {"models.offline": True})
    finally:
        conn.close()
    body = client.get("/api/models").json()
    assert body["offline"] is True
