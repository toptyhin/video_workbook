"""M13: интеграция — list_models (data/legacy), очередь и эмбеддинги через resolver."""
from __future__ import annotations

from pathlib import Path

import pytest

from app.db import connect
from app.services import model_resolver, model_store, settings_service
from app.services.embeddings import SemanticIndexManager
from app.services.model_store import ModelStore
from app.services.queue import TranscriptionQueue
from tests.helpers import add_video
from tests.test_m13_common import (
    DEFAULT_ID,
    DEFAULT_LOCAL_DIR,
    RecordingBus,
    install_entry,
    migrate_db,
    model_entry,
    model_item,
    use_manifest,
)


@pytest.fixture(autouse=True)
def _db(config):
    migrate_db(config)


@pytest.fixture(autouse=True)
def _isolated_resources(config, tmp_path, monkeypatch):
    resources = tmp_path / "resources"
    monkeypatch.setattr(config, "resources_dir", resources)
    monkeypatch.setattr(
        config, "embedding_model_dir", resources / "models" / "multilingual-e5-small-onnx"
    )
    (resources / "models").mkdir(parents=True, exist_ok=True)


def test_list_models_data_and_legacy(config, monkeypatch):
    data_entry, data_contents = model_entry([("weights.bin", b"data-payload")])
    legacy_entry, legacy_contents = model_entry(
        [("weights.bin", b"legacy-payload")],
        model_id="test-legacy",
        local_dir="legacy-dir",
        recommended=False,
        default=False,
    )
    use_manifest(monkeypatch, [data_entry, legacy_entry])
    data_base = install_entry(config, data_entry, data_contents)
    install_entry(config, legacy_entry, legacy_contents, legacy=True)
    store = ModelStore(config, RecordingBus())
    listing = store.list_models()
    data_item = model_item(store, DEFAULT_ID)
    legacy_item = model_item(store, "test-legacy")
    assert data_item["status"] == "ready"
    assert data_item["installed"] is True and data_item["bundled"] is False
    assert data_item["path"] == str(data_base)
    assert data_item["revision"] == data_entry["source"]["revision"]
    assert data_item["update_available"] is False
    assert legacy_item["status"] == "bundled"
    assert legacy_item["installed"] is True and legacy_item["bundled"] is True
    assert legacy_item["path"] is None
    assert listing["total_installed_bytes"] == data_item["size_bytes"]
    assert listing["total_available_bytes"] == (
        data_entry["estimate_bytes"] + legacy_entry["estimate_bytes"]
    )
    assert listing["items"][0]["id"] == DEFAULT_ID
    assert listing["offline"] is False


def test_list_models_update_available(config, monkeypatch):
    entry, contents = model_entry([("weights.bin", b"payload")])
    use_manifest(monkeypatch, [entry])
    install_entry(config, entry, contents, marker_revision="previous-revision")
    store = ModelStore(config, RecordingBus())
    item = model_item(store, DEFAULT_ID)
    assert item["status"] == "ready"
    assert item["update_available"] is True
    assert item["revision"] == "previous-revision"


def test_list_models_error_state(config, monkeypatch):
    entry, _contents = model_entry([("weights.bin", b"payload")])
    use_manifest(monkeypatch, [entry])
    store = ModelStore(config, RecordingBus())
    store._set_status(
        DEFAULT_ID,
        "error",
        bytes_received=10,
        total_bytes=100,
        revision=entry["source"]["revision"],
        error="boom",
        error_code="checksum_mismatch",
    )
    item = model_item(store, DEFAULT_ID)
    assert item["status"] == "error"
    assert item["error"] == "boom"
    assert item["error_code"] == "checksum_mismatch"
    assert item["progress"] == {"bytes_received": 10, "total_bytes": 100, "percent": 10}


def test_embeddings_resolver_data_wins_then_fallback(config, monkeypatch, tmp_path):
    legacy_entry, legacy_contents = model_entry(
        [("tokenizer.json", b"{}"), ("onnx/model_quantized.onnx", b"legacy")],
        model_id="embedding-e5-small",
        kind="embedding",
        local_dir="multilingual-e5-small-onnx",
    )
    use_manifest(monkeypatch, [legacy_entry])
    install_entry(config, legacy_entry, legacy_contents, legacy=True)
    legacy_manager = SemanticIndexManager(config, RecordingBus())
    assert Path(legacy_manager.encoder.model_dir) == (
        config.resources_dir / "models" / "multilingual-e5-small-onnx"
    )
    data_contents = dict(legacy_contents)
    data_contents["onnx/model_quantized.onnx"] = b"dataxx"  # тот же размер, что legacy
    data_base = install_entry(config, legacy_entry, data_contents)
    data_manager = SemanticIndexManager(config, RecordingBus())
    assert Path(data_manager.encoder.model_dir) == data_base


def test_embeddings_refresh_after_model_appears(config, monkeypatch):
    entry, contents = model_entry(
        [("tokenizer.json", b"{}"), ("onnx/model_quantized.onnx", b"weights")],
        model_id="embedding-e5-small",
        kind="embedding",
        local_dir="multilingual-e5-small-onnx",
    )
    use_manifest(monkeypatch, [entry])
    manager = SemanticIndexManager(config, RecordingBus())
    assert manager._available() is False
    install_entry(config, entry, contents)
    assert manager._available() is True
    assert Path(manager.encoder.model_dir) == (
        config.models_dir / "multilingual-e5-small-onnx"
    )


def test_embeddings_resolver_fallback_without_model(config, monkeypatch):
    use_manifest(monkeypatch, [])
    manager = SemanticIndexManager(config, RecordingBus())
    assert Path(manager.encoder.model_dir) == config.embedding_model_dir
    assert manager.encoder.available is False


def test_queue_is_idle(config):
    bus = RecordingBus()
    queue = TranscriptionQueue(config, bus)
    assert queue.is_idle() is True
    video_id = add_video(config, path="/tmp/videos/idle.mp4", status="pending")
    queue.enqueue([video_id])
    assert queue.is_idle() is False
    queue.cancel(video_id)
    assert queue.is_idle() is True


def test_queue_marks_model_missing(config, tmp_path):
    bus = RecordingBus()
    queue = TranscriptionQueue(config, bus)
    video_path = tmp_path / "lesson.mp4"
    video_path.write_bytes(b"fake-video")
    video_id = add_video(config, path=str(video_path), status="pending")
    queue._run_one(video_id)
    conn = connect(config.db_path)
    try:
        row = conn.execute(
            "SELECT status, error, error_code FROM videos WHERE id = ?", (video_id,)
        ).fetchone()
    finally:
        conn.close()
    assert row["status"] == "error"
    assert row["error_code"] == "model_missing"
    assert "Модель" in row["error"]
    status_event = next(
        payload
        for event_type, payload in bus.events
        if event_type == "video.status" and payload["status"] == "error"
    )
    assert status_event["code"] == "model_missing"


def test_resolver_uses_manifest_sizes_for_presence(config, monkeypatch):
    entry, contents = model_entry([("weights.bin", b"payload")])
    use_manifest(monkeypatch, [entry])
    assert model_resolver.resolve_model(config, entry) is None
    install_entry(config, entry, contents)
    assert model_resolver.resolve_model(config, entry) == config.models_dir / DEFAULT_LOCAL_DIR


def test_offline_from_settings(config, monkeypatch):
    entry, _contents = model_entry([("weights.bin", b"payload")])
    use_manifest(monkeypatch, [entry])
    conn = connect(config.db_path)
    try:
        settings_service.patch(conn, {"models.offline": True})
    finally:
        conn.close()
    store = ModelStore(config, RecordingBus())
    assert store.list_models()["offline"] is True


def test_delete_removes_db_row(config, monkeypatch):
    entry, contents = model_entry([("weights.bin", b"payload")])
    use_manifest(monkeypatch, [entry])
    install_entry(config, entry, contents)
    store = ModelStore(config, RecordingBus())
    store.delete(DEFAULT_ID)
    conn = connect(config.db_path)
    try:
        row = conn.execute(
            "SELECT status FROM model_downloads WHERE model_id = ?", (DEFAULT_ID,)
        ).fetchone()
    finally:
        conn.close()
    assert row is None
    assert model_item(store, DEFAULT_ID)["status"] == "absent"


def test_unknown_model_listing_is_manifest_driven(config, monkeypatch):
    use_manifest(monkeypatch, [])
    store = ModelStore(config, RecordingBus())
    listing = store.list_models()
    assert listing["items"] == []
    with pytest.raises(model_store.ModelError) as error:
        store.download("anything")
    assert error.value.code == "unknown_model"

