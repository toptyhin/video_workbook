"""M12: семантический (векторный) поиск по сегментам транскрибации.

Детерминированные тесты используют fake-энкодер (dim 8/16); реальная модель
`multilingual-e5-small` проверяется отдельно и скипается, если её нет.
"""
from __future__ import annotations

import time
from pathlib import Path

import numpy as np
import pytest

from app.db import connect, get_user_version, migrate
from app.services import search_service
from app.services.embeddings import (
    EMBEDDING_DIM,
    EMBEDDING_MODEL,
    EmbeddingEncoder,
    EmbeddingError,
    SemanticIndexManager,
)
from app.services.events import EventBus
from app.services.queue import TranscriptionQueue
from tests.helpers import add_segment, add_tag, add_video

KEYWORDS = (
    "альфа",
    "бета",
    "гамма",
    "дельта",
    "производн",
    "квадрат",
    "рим",
    "python",
)
MODEL_DIR = Path(__file__).resolve().parents[2] / "resources" / "models" / "multilingual-e5-small-onnx"
REAL_MODEL = MODEL_DIR / "onnx" / "model_quantized.onnx"


@pytest.fixture(autouse=True)
def _migrated(config):
    """Тесты без client не запускают lifespan — применяем миграции явно."""
    conn = connect(config.db_path)
    try:
        migrate(conn, config.migrations_dir)
    finally:
        conn.close()


class FakeBus:
    def __init__(self) -> None:
        self.events: list[tuple[str, dict]] = []

    def publish_threadsafe(self, event_type: str, payload: dict) -> None:
        self.events.append((event_type, payload))

    def publish(self, event_type: str, payload: dict) -> None:
        self.events.append((event_type, payload))


class FakeEncoder:
    """Детерминированные эмбеддинги по вхождению ключевых слов."""

    def __init__(self, dim: int = 8, available: bool = True) -> None:
        self.dim = dim
        self.available = available
        self.detail = None if available else "Модель эмбеддингов недоступна (fake)"
        self.kinds: list[str] = []

    def encode(self, texts: list[str], *, kind: str) -> np.ndarray:
        assert kind in ("query", "passage")
        if not self.available:
            raise EmbeddingError(self.detail or "Модель недоступна")
        self.kinds.append(kind)
        vectors = np.zeros((len(texts), self.dim), dtype=np.float32)
        for index, text in enumerate(texts):
            lowered = (text or "").lower()
            for position, keyword in enumerate(KEYWORDS[: self.dim]):
                if keyword in lowered:
                    vectors[index, position] += 1.0
        norms = np.linalg.norm(vectors, axis=1, keepdims=True)
        return vectors / np.clip(norms, 1e-12, None)


class BrokenEncoder(FakeEncoder):
    def encode(self, texts: list[str], *, kind: str) -> np.ndarray:
        raise RuntimeError("boom")


def make_manager(
    config, encoder: FakeEncoder | EmbeddingEncoder | None = None, bus: FakeBus | None = None
) -> SemanticIndexManager:
    return SemanticIndexManager(config, bus or FakeBus(), encoder or FakeEncoder())


def open_conn(config):
    return connect(config.db_path)


def vector_from_db(conn, segment_id: int) -> np.ndarray:
    row = conn.execute(
        "SELECT dim, vector FROM segment_embeddings WHERE segment_id = ?", (segment_id,)
    ).fetchone()
    assert row is not None
    vector = np.frombuffer(row["vector"], dtype=np.float32)
    assert row["dim"] == vector.size
    return vector


def seed_three(config) -> dict[str, int]:
    video_id = add_video(config, path="/tmp/m12/lesson-01.mp4", title="lesson-01.mp4")
    return {
        "video_id": video_id,
        "derivative": add_segment(
            config, video_id, 0, 5000, "Производная сложной функции вычисляется по правилу"
        ),
        "quadratic": add_segment(
            config, video_id, 5000, 10000, "Квадратное уравнение решается через дискриминант"
        ),
        "rome": add_segment(config, video_id, 10000, 15000, "Римская республика и её история"),
    }


# ---------- миграция и схема ----------


def test_migration_creates_segment_embeddings(config):
    conn = open_conn(config)
    try:
        assert migrate(conn, config.migrations_dir) == 12
        assert get_user_version(conn) == 12
        columns = {
            row["name"] for row in conn.execute("PRAGMA table_info(segment_embeddings)")
        }
        assert {"segment_id", "model", "dim", "vector", "updated_at"} <= columns
        indexes = {
            row["name"] for row in conn.execute("PRAGMA index_list(segment_embeddings)")
        }
        assert "idx_segment_embeddings_model" in indexes

        cursor = conn.execute(
            "INSERT INTO videos(path, title, status) VALUES ('/tmp/m12/cascade.mp4', 'cascade.mp4', 'done')"
        )
        video_id = int(cursor.lastrowid)
        segment_id = int(
            conn.execute(
                "INSERT INTO segments(video_id, start_ms, end_ms, text) "
                "VALUES (?, 0, 1000, 'альфа')",
                (video_id,),
            ).lastrowid
        )
        conn.execute(
            "INSERT INTO segment_embeddings(segment_id, model, dim, vector) VALUES (?, ?, ?, ?)",
            (segment_id, EMBEDDING_MODEL, 8, np.ones(8, dtype=np.float32).tobytes()),
        )
        conn.commit()
        conn.execute("DELETE FROM segments WHERE id = ?", (segment_id,))
        conn.commit()
        assert (
            conn.execute(
                "SELECT COUNT(*) FROM segment_embeddings WHERE segment_id = ?", (segment_id,)
            ).fetchone()[0]
            == 0
        )

        segment_id = int(
            conn.execute(
                "INSERT INTO segments(video_id, start_ms, end_ms, text) "
                "VALUES (?, 1000, 2000, 'бета')",
                (video_id,),
            ).lastrowid
        )
        conn.execute(
            "INSERT INTO segment_embeddings(segment_id, model, dim, vector) VALUES (?, ?, ?, ?)",
            (segment_id, EMBEDDING_MODEL, 8, np.ones(8, dtype=np.float32).tobytes()),
        )
        conn.commit()
        conn.execute("DELETE FROM videos WHERE id = ?", (video_id,))
        conn.commit()
        assert conn.execute("SELECT COUNT(*) FROM segment_embeddings").fetchone()[0] == 0
    finally:
        conn.close()


# ---------- энкодер и статус ----------


def test_encoder_unavailable_without_model_files(tmp_path):
    encoder = EmbeddingEncoder(tmp_path / "missing-e5", threads=1)
    assert encoder.available is False
    assert encoder.detail and "не найдены" in encoder.detail
    with pytest.raises(EmbeddingError):
        encoder.encode(["текст"], kind="passage")


def test_status_counts_and_index_video(config):
    seed = seed_three(config)
    manager = make_manager(config)
    conn = open_conn(config)
    try:
        status = manager.status(conn)
        assert status["available"] is True
        assert status["model"] == EMBEDDING_MODEL
        assert status["dim"] == 8
        assert status["autoindex"] is False
        assert status["indexed_segments"] == 0
        assert status["total_segments"] == 3
        assert status["indexing"] is False
        assert status["detail"] is None

        assert manager.index_video(seed["video_id"]) == 3
        status = manager.status(conn)
        assert status["indexed_segments"] == 3
        vector = vector_from_db(conn, seed["derivative"])
        assert vector.size == 8
        assert abs(float(np.linalg.norm(vector)) - 1.0) < 1e-5
        # повторный вызов ничего не дублирует
        assert manager.index_video(seed["video_id"]) == 0
        assert conn.execute("SELECT COUNT(*) FROM segment_embeddings").fetchone()[0] == 3
        # эмбеддинг другой модели не входит в indexed_segments текущей
        conn.execute(
            "UPDATE segment_embeddings SET model = 'old-model' WHERE segment_id = ?",
            (seed["quadratic"],),
        )
        conn.commit()
        status = manager.status(conn)
        assert status["indexed_segments"] == 2
        assert status["total_segments"] == 3
    finally:
        conn.close()


def test_index_missing_force_and_sse_events(config):
    seed_three(config)
    bus = FakeBus()
    manager = make_manager(config, bus=bus)
    result = manager.index_missing()
    assert result == {"indexed": 3, "total": 3}
    event_types = [event for event, _ in bus.events]
    assert "embedding.state" in event_types
    assert "embedding.progress" in event_types
    states = [payload["state"] for event, payload in bus.events if event == "embedding.state"]
    assert states[0] == "indexing"
    assert states[-1] == "idle"
    progress = [payload for event, payload in bus.events if event == "embedding.progress"]
    assert progress[0]["indexed"] == 0
    assert progress[-1] == {"indexed": 3, "total": 3, "percent": 100}

    assert manager.index_missing() == {"indexed": 0, "total": 0}
    assert manager.index_missing(force=True) == {"indexed": 3, "total": 3}
    conn = open_conn(config)
    try:
        assert conn.execute("SELECT COUNT(*) FROM segment_embeddings").fetchone()[0] == 3
    finally:
        conn.close()


def test_unavailable_encoder_degrades(config):
    seed = seed_three(config)
    bus = FakeBus()
    manager = make_manager(config, encoder=FakeEncoder(available=False), bus=bus)
    conn = open_conn(config)
    try:
        status = manager.status(conn)
        assert status["available"] is False
        assert status["detail"]
        result = manager.index_missing()
        assert result["indexed"] == 0
        assert result["detail"]
        assert manager.index_video(seed["video_id"]) == 0
        assert manager.search(conn, "производная") == []
        assert conn.execute("SELECT COUNT(*) FROM segment_embeddings").fetchone()[0] == 0
        assert bus.events and bus.events[-1][0] == "embedding.state"
        assert bus.events[-1][1]["state"] == "idle"
    finally:
        conn.close()


def test_broken_encoder_never_raises_into_search(config):
    seed_three(config)
    manager = make_manager(config, encoder=BrokenEncoder())
    conn = open_conn(config)
    try:
        assert manager.search(conn, "производная") == []
    finally:
        conn.close()


# ---------- векторы и поиск ----------


def test_semantic_search_ranking_and_snippet(config):
    seed = seed_three(config)
    manager = make_manager(config)
    manager.index_missing()
    conn = open_conn(config)
    try:
        items = manager.search(
            conn,
            "производная функция",
            video_id=None,
            tag_ids=[],
            tag_mode="any",
            include_children=True,
            file_prefix=None,
            limit=10,
        )
        assert len(items) == 3
        assert items[0]["segment_id"] == seed["derivative"]
        assert items[0]["semantic"] is True
        assert items[0]["kind"] == "segment"
        assert items[0]["score"] == pytest.approx(1.0)
        assert "<mark>" not in items[0]["snippet_html"]
        assert items[0]["snippet_html"].startswith("Производная")
        assert items[0]["video_title"] == "lesson-01.mp4"
        assert [item["score"] for item in items] == sorted(
            [item["score"] for item in items], reverse=True
        )
        # фильтр по имени файла и видео
        assert manager.search(conn, "производная", file_prefix="lesson")
        assert manager.search(conn, "производная", file_prefix="other") == []
        assert manager.search(conn, "производная", video_id=seed["video_id"])
        assert manager.search(conn, "производная", video_id=seed["video_id"] + 100) == []
        # пустой запрос — пустой ответ
        assert manager.search(conn, "   ") == []
    finally:
        conn.close()


def test_semantic_search_tag_filters_and_children(config):
    seed = seed_three(config)
    parent = add_tag(config, "Математика")
    child = add_tag(config, "Производные", parent_id=parent)
    other = add_tag(config, "Квадратные")
    conn = open_conn(config)
    try:
        conn.execute(
            "INSERT INTO segment_tags(segment_id, tag_id) VALUES (?, ?)",
            (seed["derivative"], child),
        )
        conn.execute(
            "INSERT INTO segment_tags(segment_id, tag_id) VALUES (?, ?)",
            (seed["quadratic"], other),
        )
        conn.commit()
    finally:
        conn.close()
    manager = make_manager(config)
    manager.index_missing()
    conn = open_conn(config)
    try:
        by_parent = manager.search(
            conn, "функция", tag_ids=[parent], include_children=True
        )
        assert [item["segment_id"] for item in by_parent] == [seed["derivative"]]
        assert manager.search(conn, "функция", tag_ids=[parent], include_children=False) == []
        any_mode = manager.search(
            conn, "функция", tag_ids=[parent, other], tag_mode="any"
        )
        assert {item["segment_id"] for item in any_mode} == {seed["derivative"], seed["quadratic"]}
        all_mode = manager.search(
            conn, "функция", tag_ids=[parent, other], tag_mode="all"
        )
        assert all_mode == []
    finally:
        conn.close()


def test_matrix_cache_reflects_writes(config):
    seed = seed_three(config)
    manager = make_manager(config)
    manager.index_missing()
    conn = open_conn(config)
    try:
        first = manager.search(conn, "производная")
        assert [item["segment_id"] for item in first][0] == seed["derivative"]
        # удаление сегмента каскадно убирает эмбеддинг из кандидатов поиска
        conn.execute("DELETE FROM segments WHERE id = ?", (seed["derivative"],))
        conn.commit()
        after_delete = manager.search(conn, "производная")
        assert seed["derivative"] not in [item["segment_id"] for item in after_delete]
        # доиндексация нового видео обновляет кэш матрицы
        video_id = add_video(config, path="/tmp/m12/lesson-02.mp4", title="lesson-02.mp4")
        segment_id = add_segment(config, video_id, 0, 1000, "альфа и бета")
        assert manager.index_video(video_id) == 1
        items = manager.search(conn, "альфа")
        assert items[0]["segment_id"] == segment_id
    finally:
        conn.close()


def test_manager_dim_from_fake_encoder(config):
    seed = seed_three(config)
    manager = make_manager(config, encoder=FakeEncoder(dim=16))
    conn = open_conn(config)
    try:
        assert manager.dim == 16
        manager.index_missing()
        assert manager.status(conn)["dim"] == 16
        assert vector_from_db(conn, seed["derivative"]).size == 16
    finally:
        conn.close()


# ---------- сервис: режимы и RRF ----------


def seed_hybrid(config) -> dict[str, int]:
    video_id = add_video(config, path="/tmp/m12/hybrid.mp4", title="lesson-01.mp4")
    return {
        "video_id": video_id,
        "a": add_segment(config, video_id, 0, 1000, "альфа бета"),
        "b": add_segment(config, video_id, 1000, 2000, "бета гамма"),
        "c": add_segment(config, video_id, 2000, 3000, "гамма дельта"),
    }


def test_modes_and_hybrid_rrf(config):
    seed = seed_hybrid(config)
    manager = make_manager(config)
    manager.index_missing()
    conn = open_conn(config)
    try:
        fts_only = search_service.search(conn, q="альфа", scope="segments")
        assert fts_only["query"]["mode"] == "fts"
        assert fts_only["query"]["mode_used"] == "fts"
        assert fts_only["query"]["semantic"]["available"] is False
        assert [item["segment_id"] for item in fts_only["items"]] == [seed["a"]]
        assert "semantic" not in fts_only["items"][0]

        semantic_only = search_service.search(
            conn, q="альфа", scope="segments", mode="semantic", semantic=manager
        )
        assert semantic_only["query"]["mode"] == "semantic"
        assert semantic_only["query"]["mode_used"] == "semantic"
        assert semantic_only["query"]["semantic"]["available"] is True
        assert [item["segment_id"] for item in semantic_only["items"]] == [
            seed["a"],
            seed["b"],
            seed["c"],
        ]
        assert all(item["semantic"] is True for item in semantic_only["items"])

        hybrid = search_service.search(
            conn, q="альфа", scope="segments", mode="hybrid", semantic=manager
        )
        assert hybrid["query"]["mode_used"] == "hybrid"
        assert hybrid["total"] == 3
        ids = [item["segment_id"] for item in hybrid["items"]]
        assert ids == [seed["a"], seed["b"], seed["c"]]
        assert len(ids) == len(set(ids))
        merged = hybrid["items"][0]
        # при совпадении FTS и семантики берётся FTS-item (с <mark>) + semantic=True
        assert merged["semantic"] is True
        assert "<mark>" in merged["snippet_html"]
        assert merged["score"] == pytest.approx(2 / (search_service.RRF_K + 1), abs=1e-6)
        assert hybrid["items"][1]["score"] == pytest.approx(
            1 / (search_service.RRF_K + 2), abs=1e-6
        )
        assert hybrid["items"][2]["score"] == pytest.approx(
            1 / (search_service.RRF_K + 3), abs=1e-6
        )
        # пагинация после merge
        page = search_service.search(
            conn, q="альфа", scope="segments", mode="hybrid", semantic=manager, limit=1, offset=1
        )
        assert [item["segment_id"] for item in page["items"]] == [seed["b"]]
    finally:
        conn.close()


def test_semantic_mode_scope_fallback_and_invalid_mode(config):
    seed = seed_hybrid(config)
    manager = make_manager(config)
    manager.index_missing()
    conn = open_conn(config)
    try:
        files = search_service.search(
            conn, q="lesson", scope="files", mode="semantic", semantic=manager
        )
        assert files["query"]["mode_used"] == "fts"
        assert files["items"] and files["items"][0]["kind"] == "file"

        unavailable = make_manager(config, encoder=FakeEncoder(available=False))
        fallback = search_service.search(
            conn, q="альфа", scope="segments", mode="semantic", semantic=unavailable
        )
        assert fallback["query"]["mode_used"] == "fts"
        assert fallback["query"]["semantic"]["available"] is False
        assert fallback["query"]["semantic"]["detail"]
        assert [item["segment_id"] for item in fallback["items"]] == [seed["a"]]

        with pytest.raises(search_service.SearchError) as excinfo:
            search_service.search(conn, q="x", mode="bogus")
        assert excinfo.value.code == "invalid_mode"
        assert excinfo.value.status_code == 422
    finally:
        conn.close()


# ---------- API ----------


def test_api_status_and_search_modes(client, app, config):
    seed = seed_three(config)
    manager = make_manager(config)
    app.state.embeddings = manager
    assert manager.index_missing()["indexed"] == 3

    status = client.get("/api/search/semantic/status")
    assert status.status_code == 200
    payload = status.json()
    assert payload["available"] is True
    assert payload["model"] == EMBEDDING_MODEL
    assert payload["indexed_segments"] == 3
    assert payload["total_segments"] == 3
    assert payload["indexing"] is False
    assert payload["autoindex"] is False

    semantic = client.get(
        "/api/search", params={"q": "производная", "scope": "segments", "mode": "semantic"}
    )
    assert semantic.status_code == 200
    body = semantic.json()
    assert body["query"]["mode"] == "semantic"
    assert body["query"]["mode_used"] == "semantic"
    assert body["query"]["semantic"]["available"] is True
    assert body["items"] and body["items"][0]["segment_id"] == seed["derivative"]
    assert body["items"][0]["semantic"] is True
    assert "took_ms" in body["query"]

    hybrid = client.get(
        "/api/search", params={"q": "производная", "scope": "segments", "mode": "hybrid"}
    )
    assert hybrid.status_code == 200
    assert hybrid.json()["query"]["mode_used"] == "hybrid"
    assert hybrid.json()["items"][0]["semantic"] is True

    default = client.get("/api/search", params={"q": "производная"})
    assert default.json()["query"]["mode"] == "fts"
    assert default.json()["query"]["mode_used"] == "fts"


def test_api_invalid_mode(client):
    response = client.get("/api/search", params={"q": "x", "mode": "bogus"})
    assert response.status_code == 422
    assert response.json()["code"] == "invalid_mode"


def test_api_fallback_when_semantics_unavailable(client, app, config):
    seed_three(config)
    app.state.embeddings = make_manager(config, encoder=FakeEncoder(available=False))
    response = client.get(
        "/api/search", params={"q": "производная", "scope": "segments", "mode": "hybrid"}
    )
    assert response.status_code == 200
    body = response.json()
    assert body["query"]["mode"] == "hybrid"
    assert body["query"]["mode_used"] == "fts"
    assert body["query"]["semantic"]["available"] is False
    assert body["query"]["semantic"]["detail"]
    assert body["items"] and body["items"][0]["kind"] == "segment"


def test_api_reindex_endpoint(client, app, config):
    seed_three(config)
    manager = make_manager(config)
    app.state.embeddings = manager

    response = client.post("/api/search/semantic/reindex")
    assert response.status_code == 202
    body = response.json()
    assert body["state"] == "indexing"
    assert body["indexing"] is True
    assert body["available"] is True
    assert _wait_indexing(client)["indexed_segments"] == 3

    forced = client.post("/api/search/semantic/reindex", json={"force": True})
    assert forced.status_code == 202
    assert forced.json()["state"] == "indexing"
    status = _wait_indexing(client)
    assert status["indexed_segments"] == 3
    assert status["indexing"] is False


def test_api_reindex_unavailable(client, app, config):
    seed_three(config)
    app.state.embeddings = make_manager(
        config, bus=FakeBus(), encoder=FakeEncoder(available=False)
    )
    response = client.post("/api/search/semantic/reindex", json={})
    assert response.status_code == 202
    body = response.json()
    assert body["state"] == "idle"
    assert body["available"] is False
    assert body["detail"]


def test_api_status_without_manager(client, app):
    app.state.embeddings = None
    response = client.get("/api/search/semantic/status")
    assert response.status_code == 200
    body = response.json()
    assert body["available"] is False
    assert body["detail"]


# ---------- очередь ----------


def test_queue_hook_indexes_after_store_result(config):
    seed = seed_hybrid(config)
    manager = make_manager(config)
    queue = TranscriptionQueue(config, EventBus(), manager)
    result = {
        "segments": [
            {"start_ms": 0, "end_ms": 1000, "text": "новая лекция про альфа"},
            {"start_ms": 1000, "end_ms": 2000, "text": "продолжение про бета"},
        ],
        "lang": "ru",
        "headline": "новая лекция",
    }
    queue._store_result(seed["video_id"], result, "small")
    conn = open_conn(config)
    try:
        assert conn.execute("SELECT COUNT(*) FROM segment_embeddings").fetchone()[0] == 2
        assert manager.status(conn)["indexed_segments"] == 2
        status = conn.execute(
            "SELECT status, headline FROM videos WHERE id = ?", (seed["video_id"],)
        ).fetchone()
        assert status["status"] == "done"
        assert status["headline"] == "новая лекция"
    finally:
        conn.close()
    # старый конструктор без менеджера продолжает работать
    legacy = TranscriptionQueue(config, EventBus())
    assert legacy.embeddings is None


def _wait_indexing(client, timeout: float = 10.0) -> dict:
    deadline = time.monotonic() + timeout
    last: dict | None = None
    while time.monotonic() < deadline:
        last = client.get("/api/search/semantic/status").json()
        if not last["indexing"]:
            return last
        time.sleep(0.02)
    raise AssertionError(f"indexing не завершился: {last}")


# ---------- реальная модель ----------


@pytest.mark.skipif(not REAL_MODEL.is_file(), reason="модель multilingual-e5-small-onnx отсутствует")
def test_real_model_russian_semantic_search(client, app, config):
    manager = SemanticIndexManager(config, EventBus())
    conn = open_conn(config)
    try:
        video_id = add_video(config, path="/tmp/m12/lesson-03.webm", title="lesson-03.webm")
        texts = [
            "Производная сложной функции вычисляется по цепному правилу.",
            "Квадратное уравнение решается через дискриминант.",
            "Римская республика существовала несколько столетий.",
            "Python — язык программирования с динамической типизацией.",
        ]
        segment_ids = [
            add_segment(config, video_id, index * 1000, index * 1000 + 1000, text)
            for index, text in enumerate(texts)
        ]
        index_started = time.monotonic()
        result = manager.index_missing()
        index_elapsed = time.monotonic() - index_started
        if result["indexed"] == 0:
            pytest.skip(f"движок эмбеддингов недоступен: {result.get('detail')}")
        assert result == {"indexed": 4, "total": 4}
        status = manager.status(conn)
        assert status["available"] is True
        assert status["model"] == EMBEDDING_MODEL
        assert status["dim"] == EMBEDDING_DIM
        assert status["indexed_segments"] == 4
        assert status["total_segments"] == 4
        assert status["detail"] is None
        vector = vector_from_db(conn, segment_ids[0])
        assert vector.size == EMBEDDING_DIM

        search_started = time.monotonic()
        items = manager.search(conn, "как найти производную сложной функции", limit=4)
        search_elapsed = time.monotonic() - search_started
        assert items[0]["segment_id"] == segment_ids[0]
        assert items[0]["score"] >= 0.8, items[0]
        assert len(items) == 4
        assert index_elapsed < 15.0, index_elapsed
        assert search_elapsed < 5.0, search_elapsed

        mixed = manager.search(conn, "Python API программирование", limit=4)
        assert mixed[0]["segment_id"] == segment_ids[3]

        # реальный API-ответ по гибридному режиму
        app.state.embeddings = manager
        response = client.get(
            "/api/search", params={"q": "производные сложных функций", "mode": "hybrid"}
        )
        assert response.status_code == 200
        body = response.json()
        assert body["query"]["mode_used"] == "hybrid"
        assert body["query"]["semantic"]["available"] is True
        assert body["query"]["semantic"]["indexed_segments"] == 4
        top_segment = next(item for item in body["items"] if item["kind"] == "segment")
        assert top_segment["segment_id"] == segment_ids[0]
        api_status = client.get("/api/search/semantic/status").json()
        assert api_status["available"] is True
        assert api_status["indexed_segments"] == 4
    finally:
        conn.close()
