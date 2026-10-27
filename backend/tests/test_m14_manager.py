"""M14 rev2: SummaryManager — стадии дерева, кэш, отмена, gate, crash-recovery."""
from __future__ import annotations

import threading
import time
import uuid

import pytest

from app.db import connect, migrate
from app.services import settings_service
from app.services.llm import FakeLLMClient, LLMCancelled, LLMTimeout
from app.services.model_resolver import get_model
from app.services.summary import SummaryError, SummaryManager, SummaryPipeline
from tests.helpers import add_segment, add_video

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


class RecordingBus:
    def __init__(self) -> None:
        self.events: list[tuple[str, dict]] = []

    def publish(self, event_type: str, payload: dict) -> None:
        self.events.append((event_type, payload))

    def publish_threadsafe(self, event_type: str, payload: dict) -> None:
        self.events.append((event_type, payload))

    def states(self) -> list[str]:
        return [payload["state"] for kind, payload in self.events if kind == "summary.state"]

    def progress(self) -> list[dict]:
        return [payload for kind, payload in self.events if kind == "summary.progress"]


class Factory:
    def __init__(self, client_factory=None) -> None:
        self.models: list[str] = []
        self._client_factory = client_factory or (
            lambda model_id: FakeLLMClient(model_id=model_id)
        )

    def __call__(self, model_id, gguf):
        self.models.append(model_id)
        return self._client_factory(model_id)


class SlowClient:
    name = "slow"

    def __init__(self) -> None:
        self.event = threading.Event()

    def generate(self, prompt, **kwargs):
        self.event.wait(5)
        raise LLMCancelled

    def cancel(self) -> None:
        self.event.set()


class TimeoutClient:
    name = "timeout"

    def generate(self, prompt, **kwargs):
        raise LLMTimeout("Модель не ответила")

    def cancel(self) -> None:
        pass


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
def env(config):
    _migrate(config)
    _install_models(config)
    return config


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


def _settings(config, **values):
    conn = connect(config.db_path)
    try:
        settings_service.patch(conn, values)
    finally:
        conn.close()


def _wait(predicate, timeout: float = 10.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.02)
    return False


class ManagerFixture:
    def __init__(self, config, factory=None) -> None:
        self.bus = RecordingBus()
        self.factory = factory or Factory()
        self.manager = SummaryManager(
            config,
            self.bus,
            pipeline=SummaryPipeline(config, client_factory=self.factory),
        )
        self.manager.start()

    def close(self) -> None:
        self.manager.shutdown()


@pytest.fixture
def manager_env(env):
    fixtures: list[ManagerFixture] = []

    def build(factory=None) -> ManagerFixture:
        fixture = ManagerFixture(env, factory)
        fixtures.append(fixture)
        return fixture

    yield env, build
    for fixture in fixtures:
        fixture.close()


def _wait_ready(manager: SummaryManager, video_id: int, timeout: float = 10.0) -> dict:
    assert _wait(
        lambda: manager.status(video_id)["state"] in ("ready", "error"), timeout
    ), manager.status(video_id)
    return manager.status(video_id)


# ---------- статус/стадии ----------


def test_request_generates_tree_and_status(manager_env):
    config, build = manager_env
    fixture = build()
    video_id = _video(config)
    response = fixture.manager.request(video_id, level=1)
    assert response == {"video_id": video_id, "state": "outlining", "level": 1}
    status = _wait_ready(fixture.manager, video_id)
    assert status["state"] == "ready"
    assert set(status) == {
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
    assert status["video_id"] == video_id
    assert status["max_level"] >= 3, "fake должен дать дерево глубины ≥ 2"
    assert status["root_summary"]
    assert status["progress"] is None
    assert status["detail"] is None
    assert status["error_code"] is None
    assert status["model"] == {
        "id": MODEL_LFM,
        "label": (get_model(MODEL_LFM) or {}).get("label"),
        "installed": True,
    }
    assert sorted(int(key) for key in status["levels"]) == list(
        range(1, status["max_level"] + 1)
    )
    for key, entry in status["levels"].items():
        assert set(entry) == {"level", "label", "blocks"}
        assert entry["level"] == int(key)
        assert entry["label"]
        assert entry["blocks"]
        for block in entry["blocks"]:
            assert set(block) >= {"node_id", "start_ms", "end_ms", "title", "text"}
            assert block["start_ms"] < block["end_ms"]
    assert status["levels"][str(status["max_level"])]["blocks"][0]["node_id"] == "0"
    assert (
        status["levels"][str(status["max_level"])]["blocks"][0]["text"]
        == status["root_summary"]
    )
    assert status["levels"]["1"]["label"] == "Подробно"
    assert status["levels"][str(status["max_level"])]["label"] == "Обзор"
    states = fixture.bus.states()
    assert states[0] == "outlining"
    assert "splitting" in states
    assert "summarizing" in states
    assert states[-1] == "ready"
    progress = fixture.bus.progress()
    assert progress
    assert all({"video_id", "stage", "done", "total", "percent"} <= set(item) for item in progress)
    assert all(item["done"] <= item["total"] for item in progress)
    assert {item["stage"] for item in progress} == {"outline", "splitting", "summarizing"}
    assert progress[-1]["percent"] == 100.0


def test_job_stores_max_level_and_prompt_version(manager_env):
    config, build = manager_env
    fixture = build()
    video_id = _video(config)
    fixture.manager.request(video_id, level=1)
    status = _wait_ready(fixture.manager, video_id)
    conn = connect(config.db_path)
    try:
        job = conn.execute(
            "SELECT * FROM summary_jobs WHERE video_id = ?", (video_id,)
        ).fetchone()
    finally:
        conn.close()
    assert job is not None
    assert job["state"] == "ready"
    assert job["level"] == 1
    assert int(job["max_level"]) == status["max_level"]
    assert int(job["prompt_version"]) == 3
    assert job["model"] == MODEL_LFM


def test_cached_request_returns_ready_without_llm(manager_env):
    config, build = manager_env
    fixture = build()
    video_id = _video(config)
    fixture.manager.request(video_id, level=1)
    status = _wait_ready(fixture.manager, video_id)
    calls_before = list(fixture.factory.models)
    response = fixture.manager.request(video_id, level=status["max_level"])
    assert response["state"] == "ready"
    assert response["level"] == status["max_level"]
    assert fixture.factory.models == calls_before


def test_request_level_validation(manager_env):
    config, build = manager_env
    fixture = build()
    video_id = _video(config)
    with pytest.raises(SummaryError) as exc_info:
        fixture.manager.request(video_id, level=0)
    assert exc_info.value.code == "invalid_level"
    assert exc_info.value.status_code == 400
    # дерева ещё нет — доступен только уровень 1
    with pytest.raises(SummaryError) as exc_info:
        fixture.manager.request(video_id, level=2)
    assert exc_info.value.code == "invalid_level"
    fixture.manager.request(video_id, level=1)
    status = _wait_ready(fixture.manager, video_id)
    with pytest.raises(SummaryError) as exc_info:
        fixture.manager.request(video_id, level=status["max_level"] + 1)
    assert exc_info.value.code == "invalid_level"
    assert exc_info.value.status_code == 400
    assert fixture.manager.request(video_id, level=status["max_level"])["state"] == "ready"


def test_max_level_dynamic_for_larger_text(manager_env):
    config, build = manager_env
    fixture = build()
    video_id = _video(config, count=16)
    fixture.manager.request(video_id, level=1)
    status = _wait_ready(fixture.manager, video_id)
    assert status["max_level"] >= 3
    conn = connect(config.db_path)
    try:
        levels = [
            int(row[0])
            for row in conn.execute(
                "SELECT level FROM summary_levels WHERE video_id = ? ORDER BY level",
                (video_id,),
            )
        ]
        depths = [
            int(row[0])
            for row in conn.execute(
                "SELECT DISTINCT depth FROM summary_nodes WHERE video_id = ?",
                (video_id,),
            )
        ]
    finally:
        conn.close()
    assert levels == list(range(1, status["max_level"] + 1))
    assert max(depths) + 1 == status["max_level"]


# ---------- авто/гейт/отмена/ошибки ----------


def test_on_transcription_done_auto(manager_env):
    config, build = manager_env
    fixture = build()
    video_id = _video(config)
    fixture.manager.on_transcription_done(video_id)
    status = _wait_ready(fixture.manager, video_id)
    assert status["state"] == "ready"
    assert fixture.factory.models == [MODEL_LFM]


def test_on_transcription_done_respects_auto_off(manager_env):
    config, build = manager_env
    fixture = build()
    _settings(config, **{"summary.auto": False})
    video_id = _video(config)
    fixture.manager.on_transcription_done(video_id)
    time.sleep(0.2)
    assert fixture.manager.status(video_id)["state"] == "absent"
    assert fixture.factory.models == []


def test_compute_gate_waits_for_idle(manager_env):
    config, build = manager_env
    fixture = build()
    gate = threading.Event()
    fixture.manager.set_compute_gate(gate.is_set)
    video_id = _video(config)
    fixture.manager.request(video_id, level=1)
    time.sleep(0.3)
    assert fixture.manager.status(video_id)["state"] == "outlining"
    assert fixture.factory.models == []
    gate.set()
    assert _wait_ready(fixture.manager, video_id)["state"] == "ready"


def test_cancel_active_job(manager_env):
    config, build = manager_env
    slow = SlowClient()
    fixture = build(Factory(lambda model_id: slow))
    video_id = _video(config)
    fixture.manager.request(video_id, level=1)
    assert _wait(lambda: fixture.manager._active == video_id)
    fixture.manager.cancel(video_id)
    assert _wait(lambda: fixture.manager.status(video_id)["state"] == "absent")
    status = fixture.manager.status(video_id)
    assert status["error_code"] is None
    assert status["max_level"] == 0


def test_error_is_recorded(manager_env):
    config, build = manager_env
    fixture = build(Factory(lambda model_id: TimeoutClient()))
    video_id = _video(config)
    fixture.manager.request(video_id, level=1)
    status = _wait_ready(fixture.manager, video_id)
    assert status["state"] == "error"
    assert status["error_code"] == "summary_timeout"
    assert "не ответила" in status["detail"]
    assert "error" in fixture.bus.states()


def test_crash_recovery_marks_interrupted(env):
    video_id = _video(env)
    conn = connect(env.db_path)
    try:
        conn.execute(
            "INSERT INTO summary_jobs(video_id, state, level, source_hash, model, "
            "prompt_version) VALUES (?, 'summarizing', 1, NULL, ?, 2)",
            (video_id, MODEL_LFM),
        )
        conn.commit()
    finally:
        conn.close()
    bus = RecordingBus()
    manager = SummaryManager(env, bus, pipeline=SummaryPipeline(env))
    manager.start()
    try:
        status = manager.status(video_id)
    finally:
        manager.shutdown()
    assert status["state"] == "error"
    assert status["detail"] == "generation interrupted"
    assert status["error_code"] == "summary_interrupted"


def test_crash_recovery_handles_legacy_map_states(env):
    """После миграции 012 старые job'ы mapping/reducing не должны зависать."""
    video_id = _video(env)
    conn = connect(env.db_path)
    try:
        conn.execute(
            "INSERT INTO summary_jobs(video_id, state, level, source_hash, model, "
            "prompt_version) VALUES (?, 'mapping', 1, NULL, ?, 1)",
            (video_id, MODEL_LFM),
        )
        conn.commit()
    finally:
        conn.close()
    bus = RecordingBus()
    manager = SummaryManager(env, bus, pipeline=SummaryPipeline(env))
    manager.start()
    try:
        status = manager.status(video_id)
    finally:
        manager.shutdown()
    assert status["state"] == "error"
    assert status["error_code"] == "summary_interrupted"


# ---------- инвалидация/модели ----------


def _counts(config, video_id: int) -> tuple[int, int, int]:
    conn = connect(config.db_path)
    try:
        nodes = conn.execute(
            "SELECT COUNT(*) FROM summary_nodes WHERE video_id = ?", (video_id,)
        ).fetchone()[0]
        levels = conn.execute(
            "SELECT COUNT(*) FROM summary_levels WHERE video_id = ?", (video_id,)
        ).fetchone()[0]
        jobs = conn.execute(
            "SELECT COUNT(*) FROM summary_jobs WHERE video_id = ?", (video_id,)
        ).fetchone()[0]
    finally:
        conn.close()
    return int(nodes), int(levels), int(jobs)


def test_invalidate_removes_tree(manager_env):
    config, build = manager_env
    fixture = build()
    video_id = _video(config)
    fixture.manager.request(video_id, level=1)
    status = _wait_ready(fixture.manager, video_id)
    assert _counts(config, video_id)[0] > 0
    fixture.manager.invalidate(video_id)
    status = fixture.manager.status(video_id)
    assert status["state"] == "absent"
    assert status["max_level"] == 0
    assert status["levels"] == {}
    assert status["root_summary"] is None
    assert _counts(config, video_id) == (0, 0, 0)


def test_invalidate_active_job_conflicts(manager_env):
    config, build = manager_env
    fixture = build(Factory(lambda model_id: SlowClient()))
    video_id = _video(config)
    fixture.manager.request(video_id, level=1)
    assert _wait(lambda: fixture.manager._active == video_id)
    with pytest.raises(SummaryError) as exc_info:
        fixture.manager.invalidate(video_id)
    assert exc_info.value.code == "generation_in_progress"
    assert exc_info.value.status_code == 409
    fixture.manager.cancel(video_id)


def test_request_validation_errors(manager_env):
    config, build = manager_env
    fixture = build()
    video_id = _video(config)
    with pytest.raises(SummaryError) as exc_info:
        fixture.manager.request(999_999, level=1)
    assert exc_info.value.code == "video_not_found"
    assert exc_info.value.status_code == 404
    processing = _video(config, status="processing")
    with pytest.raises(SummaryError) as exc_info:
        fixture.manager.request(processing, level=1)
    assert exc_info.value.code == "transcription_not_ready"
    empty = add_video(
        config, path=f"/tmp/videos/m14-{uuid.uuid4().hex}.mp4", status="done"
    )
    with pytest.raises(SummaryError) as exc_info:
        fixture.manager.request(empty, level=1)
    assert exc_info.value.code == "transcription_not_ready"
    _settings(config, **{"summary.enabled": False})
    with pytest.raises(SummaryError) as exc_info:
        fixture.manager.request(video_id, level=1)
    assert exc_info.value.code == "summary_disabled"
    _settings(config, **{"summary.enabled": True})


def test_request_model_missing(manager_env):
    config, build = manager_env
    fixture = build()
    video_id = _video(config)
    entry = get_model(MODEL_LFM)
    (config.models_dir / entry["local_dir"] / "model.gguf").unlink()
    with pytest.raises(SummaryError) as exc_info:
        fixture.manager.request(video_id, level=1)
    assert exc_info.value.code == "model_missing"
    assert exc_info.value.status_code == 409


def test_model_switch_keeps_per_model_cache(manager_env):
    config, build = manager_env
    fixture = build()
    video_id = _video(config)
    fixture.manager.request(video_id, level=1)
    assert _wait_ready(fixture.manager, video_id)["state"] == "ready"
    _settings(config, **{"summary.model": MODEL_QWEN})
    status = fixture.manager.status(video_id)
    assert status["model"]["id"] == MODEL_QWEN
    assert status["state"] == "absent"
    assert status["max_level"] == 0
    fixture.manager.request(video_id, level=1)
    assert _wait_ready(fixture.manager, video_id)["state"] == "ready"
    _settings(config, **{"summary.model": MODEL_LFM})
    status = fixture.manager.status(video_id)
    assert status["model"]["id"] == MODEL_LFM
    assert status["state"] == "ready"
    assert fixture.factory.models == [MODEL_LFM, MODEL_QWEN]


def test_duplicate_request_is_idempotent(manager_env):
    config, build = manager_env
    fixture = build(Factory(lambda model_id: SlowClient()))
    video_id = _video(config)
    fixture.manager.request(video_id, level=1)
    assert _wait(lambda: fixture.manager._active == video_id)
    second = fixture.manager.request(video_id, level=1)
    assert second["state"] in ACTIVE_STATES
    assert fixture.manager._queue.empty()
    fixture.manager.cancel(video_id)


def test_cancel_unknown_video_does_not_poison_next_request(manager_env):
    config, build = manager_env
    fixture = build()
    video_id = _video(config)
    fixture.manager.cancel(video_id)
    fixture.manager.request(video_id, level=1)
    assert _wait_ready(fixture.manager, video_id)["state"] == "ready"


def test_transcription_done_invalidates_old_tree(manager_env):
    config, build = manager_env
    fixture = build()
    video_id = _video(config)
    fixture.manager.request(video_id, level=1)
    status = _wait_ready(fixture.manager, video_id)
    old_max = status["max_level"]
    calls_before = len(fixture.factory.models)
    add_segment(
        config, video_id, 8 * 30_000, 9 * 30_000, "Новый сегмент после переобработки."
    )
    fixture.manager.on_transcription_done(video_id)
    assert _wait(
        lambda: len(fixture.factory.models) > calls_before
        and fixture.manager.status(video_id)["state"] == "ready"
    )
    new_status = fixture.manager.status(video_id)
    assert new_status["max_level"] >= 2
    assert new_status["root_summary"]
    assert old_max >= 2
    nodes, levels, _jobs = _counts(config, video_id)
    assert nodes > 0 and levels == new_status["max_level"]


def test_stale_state_when_segments_changed(manager_env):
    config, build = manager_env
    fixture = build()
    video_id = _video(config)
    fixture.manager.request(video_id, level=1)
    assert _wait_ready(fixture.manager, video_id)["state"] == "ready"
    add_segment(config, video_id, 8 * 30_000, 9 * 30_000, "Сегмент после правки.")
    status = fixture.manager.status(video_id)
    assert status["state"] == "stale"
    assert status["max_level"] == 0
    assert status["root_summary"] is None
