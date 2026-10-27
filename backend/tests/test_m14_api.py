"""M14 rev2: API дерева саммари — коды ошибок, форма SummaryResponse, SSE."""
from __future__ import annotations

import threading
import time
import uuid

import pytest
from fastapi.testclient import TestClient

from app.db import connect, migrate
from app.services.llm import LLMCancelled
from app.services.model_resolver import get_model
from tests.helpers import add_segment, add_video

TOKEN = "test-token"
MODEL_LFM = "summary-lfm2.5-350m"
MODEL_QWEN = "summary-qwen2.5-0.5b"
TEXTS = [
    "Сегодня мы разберём устройство нейронных сетей и функцию потерь.",
    "Градиентный спуск обновляет веса в направлении антиградиента.",
    "Скорость обучения влияет на сходимость модели и обучение.",
    "Регуляризация помогает бороться с переобучением сети.",
    "Батч-нормализация стабилизирует обучение и ускоряет сходимость.",
    "Функции активации добавляют нелинейность в нейронную сеть.",
    "Свёрточные слои извлекают локальные признаки изображения.",
    "Рекуррентные сети обрабатывают последовательности и контекст.",
]
ACTIVE_STATES = ("outlining", "splitting", "summarizing")


class SlowClient:
    name = "slow"

    def __init__(self) -> None:
        self.event = threading.Event()

    def generate(self, prompt, **kwargs):
        self.event.wait(5)
        raise LLMCancelled

    def cancel(self) -> None:
        self.event.set()


def _migrate(config) -> None:
    conn = connect(config.db_path)
    try:
        migrate(conn, config.migrations_dir)
    finally:
        conn.close()


def _install_models(config) -> None:
    for model_id in (MODEL_LFM, MODEL_QWEN):
        entry = get_model(model_id)
        file_info = entry["source"]["files"][0]
        target_dir = config.models_dir / entry["local_dir"]
        target_dir.mkdir(parents=True, exist_ok=True)
        target = target_dir / str(file_info.get("local") or file_info["path"])
        if not target.exists():
            with target.open("wb") as stream:
                stream.truncate(int(file_info["size"]))


@pytest.fixture
def api_env(config, monkeypatch):
    _migrate(config)
    _install_models(config)
    monkeypatch.setenv("VL_SUMMARY_FAKE", "1")
    from app.main import create_app

    app = create_app(config)
    with TestClient(app, headers={"X-VL-Token": TOKEN}) as client:
        yield config, app, client, app.state.summary


def _video(config, *, count: int = 8, status: str = "done") -> int:
    video_id = add_video(
        config,
        path=f"/tmp/videos/m14-{uuid.uuid4().hex}.mp4",
        duration_ms=count * 30_000,
        status=status,
    )
    for index in range(count):
        add_segment(
            config,
            video_id,
            index * 30_000,
            (index + 1) * 30_000,
            TEXTS[index % len(TEXTS)],
        )
    return video_id


def _wait(predicate, timeout: float = 10.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.02)
    return False


def _get(client, video_id: int) -> dict:
    response = client.get(f"/api/videos/{video_id}/summary")
    assert response.status_code == 200, response.text
    return response.json()


def _wait_ready(client, video_id: int) -> dict:
    assert _wait(
        lambda: _get(client, video_id)["state"] in ("ready", "error"),
        10.0,
    ), _get(client, video_id)
    return _get(client, video_id)


# ---------- ошибки ----------


def test_get_unknown_video(api_env):
    _config, _app, client, _manager = api_env
    response = client.get("/api/videos/424242/summary")
    assert response.status_code == 404
    assert response.json()["code"] == "video_not_found"
    assert response.json()["detail"] == "Видео не найдено"


def test_post_invalid_level(api_env):
    config, _app, client, _manager = api_env
    video_id = _video(config)
    response = client.post(f"/api/videos/{video_id}/summary", json={"level": 0})
    assert response.status_code == 400
    assert response.json()["code"] == "invalid_level"
    # дерева ещё нет: уровень > 1 недопустим
    response = client.post(f"/api/videos/{video_id}/summary", json={"level": 2})
    assert response.status_code == 400
    assert response.json()["code"] == "invalid_level"
    response = client.post(f"/api/videos/{video_id}/summary", json={"level": "abc"})
    assert response.status_code == 422


def test_post_transcription_not_ready(api_env):
    config, _app, client, _manager = api_env
    processing = _video(config, status="processing")
    response = client.post(f"/api/videos/{processing}/summary", json={"level": 1})
    assert response.status_code == 409
    assert response.json()["code"] == "transcription_not_ready"
    empty = add_video(
        config, path=f"/tmp/videos/m14-{uuid.uuid4().hex}.mp4", status="done"
    )
    response = client.post(f"/api/videos/{empty}/summary", json={"level": 1})
    assert response.status_code == 409
    assert response.json()["code"] == "transcription_not_ready"


def test_post_summary_disabled(api_env):
    config, _app, client, _manager = api_env
    video_id = _video(config)
    assert client.patch("/api/settings", json={"summary.enabled": False}).status_code == 200
    response = client.post(f"/api/videos/{video_id}/summary", json={"level": 1})
    assert response.status_code == 409
    assert response.json()["code"] == "summary_disabled"
    client.patch("/api/settings", json={"summary.enabled": True})


def test_post_model_missing(api_env):
    config, _app, client, _manager = api_env
    video_id = _video(config)
    entry = get_model(MODEL_LFM)
    file_info = entry["source"]["files"][0]
    target = config.models_dir / entry["local_dir"] / "model.gguf"
    target.unlink()
    try:
        response = client.post(f"/api/videos/{video_id}/summary", json={"level": 1})
        assert response.status_code == 409
        assert response.json()["code"] == "model_missing"
    finally:
        with target.open("wb") as stream:
            stream.truncate(int(file_info["size"]))


# ---------- генерация и форма ответа ----------


def test_generate_and_get_tree(api_env):
    config, _app, client, _manager = api_env
    video_id = _video(config)
    response = client.post(f"/api/videos/{video_id}/summary", json={"level": 1})
    assert response.status_code == 202
    body = response.json()
    assert set(body) == {"video_id", "state", "level"}
    assert body["video_id"] == video_id
    assert body["state"] == "outlining"
    assert body["level"] == 1
    payload = _wait_ready(client, video_id)
    assert payload["state"] == "ready"
    assert set(payload) == {
        "video_id",
        "state",
        "max_level",
        "levels",
        "root_summary",
        "model",
        "progress",
        "detail",
        "error_code",
    }
    assert payload["video_id"] == video_id
    assert payload["max_level"] >= 3
    assert payload["root_summary"]
    assert payload["progress"] is None
    assert payload["detail"] is None
    assert payload["error_code"] is None
    assert payload["model"] == {
        "id": MODEL_LFM,
        "label": (get_model(MODEL_LFM) or {}).get("label"),
        "installed": True,
    }
    max_level = payload["max_level"]
    assert sorted(int(key) for key in payload["levels"]) == list(range(1, max_level + 1))
    for key, entry in payload["levels"].items():
        assert set(entry) == {"level", "label", "blocks"}
        assert entry["level"] == int(key)
        assert entry["label"]
        assert entry["blocks"]
        for block in entry["blocks"]:
            assert {"node_id", "start_ms", "end_ms", "title", "text"} <= set(block)
            assert block["start_ms"] < block["end_ms"]
    root_block = payload["levels"][str(max_level)]["blocks"][0]
    assert root_block["node_id"] == "0"
    assert root_block["text"] == payload["root_summary"]
    assert payload["levels"]["1"]["label"] == "Подробно"
    assert payload["levels"][str(max_level)]["label"] == "Обзор"
    # cached request with a valid level returns ready
    response = client.post(
        f"/api/videos/{video_id}/summary", json={"level": max_level}
    )
    assert response.status_code == 202
    assert response.json() == {
        "video_id": video_id,
        "state": "ready",
        "level": max_level,
    }
    response = client.post(
        f"/api/videos/{video_id}/summary", json={"level": max_level + 1}
    )
    assert response.status_code == 400
    assert response.json()["code"] == "invalid_level"


def test_delete_summary(api_env):
    config, _app, client, _manager = api_env
    video_id = _video(config)
    client.post(f"/api/videos/{video_id}/summary", json={"level": 1})
    _wait_ready(client, video_id)
    response = client.delete(f"/api/videos/{video_id}/summary")
    assert response.status_code == 204
    payload = _get(client, video_id)
    assert payload["state"] == "absent"
    assert payload["max_level"] == 0
    assert payload["levels"] == {}
    assert payload["root_summary"] is None


def test_delete_active_conflict(api_env):
    config, _app, client, manager = api_env
    video_id = _video(config)
    slow = SlowClient()
    manager.pipeline._client_factory = lambda model_id, gguf: slow
    try:
        client.post(f"/api/videos/{video_id}/summary", json={"level": 1})
        assert _wait(lambda: manager._active == video_id)
        response = client.delete(f"/api/videos/{video_id}/summary")
        assert response.status_code == 409
        assert response.json()["code"] == "generation_in_progress"
        manager.cancel(video_id)
        assert _wait(lambda: _get(client, video_id)["state"] != "outlining")
    finally:
        manager.pipeline._client_factory = None


def test_model_switch(api_env):
    config, _app, client, _manager = api_env
    video_id = _video(config)
    client.post(f"/api/videos/{video_id}/summary", json={"level": 1})
    assert _wait_ready(client, video_id)["state"] == "ready"
    assert client.patch(
        "/api/settings", json={"summary.model": MODEL_QWEN}
    ).status_code == 200
    payload = _get(client, video_id)
    assert payload["model"]["id"] == MODEL_QWEN
    assert payload["state"] == "absent"
    assert payload["max_level"] == 0
    client.post(f"/api/videos/{video_id}/summary", json={"level": 1})
    assert _wait_ready(client, video_id)["state"] == "ready"
    client.patch("/api/settings", json={"summary.model": MODEL_LFM})
    payload = _get(client, video_id)
    assert payload["model"]["id"] == MODEL_LFM
    assert payload["state"] == "ready"
    assert payload["max_level"] >= 3


def test_sse_events(api_env):
    config, app, client, _manager = api_env
    events: list[tuple[str, dict]] = []
    bus = app.state.bus
    original = bus.publish

    def recorder(event_type: str, payload: dict) -> None:
        events.append((event_type, payload))
        original(event_type, payload)

    bus.publish = recorder  # type: ignore[method-assign]
    try:
        video_id = _video(config)
        client.post(f"/api/videos/{video_id}/summary", json={"level": 1})
        assert _wait_ready(client, video_id)["state"] == "ready"
    finally:
        bus.publish = original  # type: ignore[method-assign]
    states = [payload["state"] for kind, payload in events if kind == "summary.state"]
    assert states[0] == "outlining"
    assert "splitting" in states
    assert "summarizing" in states
    assert states[-1] == "ready"
    progress = [payload for kind, payload in events if kind == "summary.progress"]
    assert progress
    assert all(
        {"video_id", "stage", "done", "total", "percent"} <= set(item)
        for item in progress
    )
    assert {item["stage"] for item in progress} == {"outline", "splitting", "summarizing"}
    assert progress[-1]["percent"] == 100.0
