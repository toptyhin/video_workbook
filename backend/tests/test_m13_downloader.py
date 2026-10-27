"""M13: загрузчик моделей (plans/13 §5 T-13.2) — локальный HTTP, без сети.

Проверяются: успешная загрузка + прогресс/SSE, Range-докачка после обрыва,
неверный sha256, отмена, нехватка места, офлайн-режим, восстановление статусов.
"""
from __future__ import annotations

import json

import pytest

from app.services import model_store
from app.services.model_store import ModelError, ModelStore
from tests.test_m13_common import (
    DEFAULT_ID,
    DEFAULT_LOCAL_DIR,
    MI_B,
    ModelHTTPServer,
    RecordingBus,
    install_entry,
    migrate_db,
    model_entry,
    model_item,
    use_manifest,
    wait_status,
    wait_until,
)


@pytest.fixture(autouse=True)
def _db(config):
    migrate_db(config)


@pytest.fixture(autouse=True)
def _big_disk(monkeypatch):
    monkeypatch.setattr(model_store, "_free_disk_bytes", lambda path: 10**12)
    monkeypatch.setattr(model_store, "RETRY_BACKOFF", 0.01)


@pytest.fixture
def server():
    instance = ModelHTTPServer()
    try:
        yield instance
    finally:
        instance.close()


@pytest.fixture
def store_factory(config):
    stores: list[ModelStore] = []

    def make(bus=None) -> ModelStore:
        instance = ModelStore(config, bus or RecordingBus())
        instance.start()
        stores.append(instance)
        return instance

    try:
        yield make
    finally:
        for instance in stores:
            instance.shutdown()


@pytest.fixture
def model_env(server, config, monkeypatch):
    data = b"model-weights-" + bytes(range(256)) * 400  # ~100 КиБ
    entry, contents = model_entry([("weights.bin", data), ("config.json", b'{"v":1}')])
    use_manifest(monkeypatch, [entry])
    for remote, payload in contents.items():
        server.add(remote, payload)
    monkeypatch.setenv("VL_MODELS_ENDPOINT", server.url)
    return entry, contents


def test_download_success_and_events(config, store_factory, model_env):
    entry, contents = model_env
    bus = RecordingBus()
    store = store_factory(bus)
    assert store.list_models()["items"][0]["status"] == "absent"

    result = store.download(entry["id"])
    assert result == {"id": entry["id"], "status": "queued"}
    item = wait_status(store, entry["id"], {"ready"})
    assert item["installed"] is True
    assert item["bundled"] is False
    assert item["path"] == str(config.models_dir / DEFAULT_LOCAL_DIR)
    assert item["size_bytes"] > 0
    assert item["progress"] is None
    assert item["revision"] == entry["source"]["revision"]

    base = config.models_dir / DEFAULT_LOCAL_DIR
    for local, payload in contents.items():
        assert (base / local).read_bytes() == payload
    marker = json.loads((base / ".installed.json").read_text(encoding="utf-8"))
    assert marker["id"] == entry["id"]
    assert marker["revision"] == entry["source"]["revision"]
    assert marker["installed_at"]

    types = bus.types()
    assert "model.progress" in types and "model.state" in types
    assert bus.states(entry["id"])[0] == "queued"
    assert "downloading" in bus.states(entry["id"])
    assert bus.states(entry["id"])[-1] == "ready"
    progress = bus.last("model.progress")
    assert progress is not None and progress["percent"] == 100
    assert "percent" in progress and progress["total_bytes"] > 0

    listing = store.list_models()
    assert listing["total_installed_bytes"] == item["size_bytes"]
    assert listing["total_available_bytes"] >= listing["total_installed_bytes"]
    assert listing["models_dir"] == str(config.models_dir)
    assert listing["offline"] is False


def test_download_twice_reports_already_installed(store_factory, model_env):
    entry, _contents = model_env
    store = store_factory()
    store.download(entry["id"])
    wait_status(store, entry["id"], {"ready"})
    with pytest.raises(ModelError) as error:
        store.download(entry["id"])
    assert error.value.code == "already_installed"
    assert error.value.status_code == 409


def test_download_resumes_after_short_response(config, store_factory, model_env, server):
    entry, contents = model_env
    remote = f"/{entry['source']['repo']}/resolve/{entry['source']['revision']}/weights.bin"
    server.short_once.add(remote)
    store = store_factory()
    store.download(entry["id"])
    wait_status(store, entry["id"], {"ready"})
    assert (config.models_dir / DEFAULT_LOCAL_DIR / "weights.bin").read_bytes() == contents[
        "weights.bin"
    ]
    assert len(server.requests) >= 3  # короткий ответ + Range-докачка + config.json
    ranged = [req for req in server.requests if req["headers"].get("Range")]
    assert ranged, "докачка должна использовать Range"
    assert ranged[0]["headers"]["Range"].startswith("bytes=")
    assert not (config.models_dir / DEFAULT_LOCAL_DIR / "weights.bin.part").exists()


def test_download_retries_after_connection_drop(config, store_factory, model_env, server):
    entry, contents = model_env
    remote = f"/{entry['source']['repo']}/resolve/{entry['source']['revision']}/weights.bin"
    server.truncate_once.add(remote)
    store = store_factory()
    store.download(entry["id"])
    wait_status(store, entry["id"], {"ready"})
    assert (config.models_dir / DEFAULT_LOCAL_DIR / "weights.bin").read_bytes() == contents[
        "weights.bin"
    ]
    assert len(server.requests) >= 3


def test_download_checksum_mismatch(config, store_factory, server, monkeypatch):
    data = b"corrupted" * 1000
    entry, contents = model_entry([("weights.bin", data)], sha256s=False)
    entry["source"]["files"][0]["sha256"] = "0" * 64
    use_manifest(monkeypatch, [entry])
    server.add("weights.bin", contents["weights.bin"])
    monkeypatch.setenv("VL_MODELS_ENDPOINT", server.url)
    store = store_factory()
    store.download(DEFAULT_ID)
    item = wait_status(store, DEFAULT_ID, {"error"})
    assert item["error_code"] == "checksum_mismatch"
    assert item["installed"] is False
    assert not (config.models_dir / DEFAULT_LOCAL_DIR).exists()
    assert not list((config.models_dir / ".tmp").glob(f"{DEFAULT_ID}-*"))


def test_download_cancel(config, store_factory, server, monkeypatch):
    data = b"x" * (2 * MI_B)
    entry, contents = model_entry([("weights.bin", data)])
    use_manifest(monkeypatch, [entry])
    server.add("weights.bin", contents["weights.bin"])
    server.chunk_delay = 0.02
    monkeypatch.setenv("VL_MODELS_ENDPOINT", server.url)
    store = store_factory()
    store.download(DEFAULT_ID)
    wait_status(store, DEFAULT_ID, {"downloading"})
    result = store.cancel(DEFAULT_ID)
    assert result == {"id": DEFAULT_ID, "status": "absent"}
    wait_until(lambda: model_item(store, DEFAULT_ID)["status"] == "absent")
    assert not (config.models_dir / DEFAULT_LOCAL_DIR).exists()
    wait_until(
        lambda: not list((config.models_dir / ".tmp").glob(f"{DEFAULT_ID}-*")),
        timeout=5,
    )
    # идемпотентность
    assert store.cancel(DEFAULT_ID) == {"id": DEFAULT_ID, "status": "absent"}


def test_download_insufficient_disk(store_factory, model_env, monkeypatch):
    entry, _contents = model_env
    monkeypatch.setattr(model_store, "_free_disk_bytes", lambda path: 1024)
    store = store_factory()
    with pytest.raises(ModelError) as error:
        store.download(entry["id"])
    assert error.value.code == "insufficient_disk"
    assert error.value.status_code == 409
    assert model_item(store, entry["id"])["status"] == "absent"


def test_download_offline_mode(config, store_factory, model_env, monkeypatch):
    entry, _contents = model_env
    monkeypatch.setattr(config, "offline", True)
    store = store_factory()
    with pytest.raises(ModelError) as error:
        store.download(entry["id"])
    assert error.value.code == "offline_mode"
    assert error.value.status_code == 403


def test_download_offline_setting(config, store_factory, model_env):
    from app.db import connect
    from app.services import settings_service

    entry, _contents = model_env
    conn = connect(config.db_path)
    try:
        settings_service.patch(conn, {"models.offline": True})
    finally:
        conn.close()
    store = store_factory()
    assert store.list_models()["offline"] is True
    with pytest.raises(ModelError) as error:
        store.download(entry["id"])
    assert error.value.code == "offline_mode"


def test_download_http_error(store_factory, model_env, server):
    entry, _contents = model_env
    server.files.clear()  # сервер отвечает 404
    store = store_factory()
    store.download(entry["id"])
    item = wait_status(store, entry["id"], {"error"})
    assert item["error_code"] == "download_failed"
    assert item["error"]


def test_unknown_model(store_factory):
    store = store_factory()
    for operation in (store.download, store.cancel, store.delete):
        with pytest.raises(ModelError) as error:
            operation("nope")
        assert error.value.code == "unknown_model"
        assert error.value.status_code == 404


def test_start_recovers_interrupted_statuses(config, monkeypatch):
    entry, contents = model_entry([("weights.bin", b"payload")])
    entry2, _contents2 = model_entry(
        [("weights.bin", b"payload2")],
        model_id="test-other",
        local_dir="test-other-dir",
    )
    use_manifest(monkeypatch, [entry, entry2])
    install_entry(config, entry, contents)
    store = ModelStore(config, RecordingBus())
    store.start()
    try:
        conn_store = store
        conn_store._set_status(DEFAULT_ID, "downloading", bytes_received=3, total_bytes=7)
        conn_store._set_status("test-other", "downloading", bytes_received=3, total_bytes=7)
        store.shutdown()
        store2 = ModelStore(config, RecordingBus())
        store2.start()
        try:
            assert model_item(store2, DEFAULT_ID)["status"] == "ready"
            assert model_item(store2, "test-other")["status"] == "absent"
        finally:
            store2.shutdown()
    finally:
        store.shutdown()
