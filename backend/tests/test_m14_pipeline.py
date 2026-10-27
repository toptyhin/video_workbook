"""M14 rev2: дерево (tree), промпты v2, парсер и пайплайн OUTLINE→SPLIT→уровни."""
from __future__ import annotations

import json
import logging
import re

import pytest

from app.db import connect, migrate
from app.services.llm import FakeLLMClient, LLMError, LLMTimeout
from app.services.model_resolver import get_model
from app.services.summary import parser, prompts, tree
from app.services.summary.pipeline import SummaryError, SummaryPipeline
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


# ---------- окружение ----------


def _migrate(config) -> None:
    conn = connect(config.db_path)
    try:
        migrate(conn, config.migrations_dir)
    finally:
        conn.close()


def _install_models(config) -> None:
    for model_id in (MODEL_LFM, MODEL_QWEN):
        entry = get_model(model_id)
        assert entry is not None
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


def _video(config, texts: list[str] | None = None, *, duration_each: int = 30_000) -> int:
    texts = texts or TEXTS
    video_id = add_video(config, duration_ms=len(texts) * duration_each)
    for index, text in enumerate(texts):
        add_segment(
            config,
            video_id,
            index * duration_each,
            (index + 1) * duration_each,
            text,
        )
    return video_id


class CountingFactory:
    def __init__(self) -> None:
        self.models: list[str] = []
        self.clients: list[FakeLLMClient] = []

    def __call__(self, model_id, gguf):
        self.models.append(model_id)
        client = FakeLLMClient(model_id=model_id)
        self.clients.append(client)
        return client

    def calls(self) -> list[str]:
        return [call for client in self.clients for call in client.calls]


class StubbornLLM:
    """Всегда возвращает невалидный ответ: проверяем repair+fallback."""

    name = "stubborn"

    def __init__(self, answer: str = "это не json") -> None:
        self.answer = answer
        self.calls: list[str] = []

    def generate(self, prompt, *, json_schema=None, grammar=None, system=None,
                 max_tokens=512, thinking=False):
        self.calls.append(prompt)
        return self.answer

    def cancel(self) -> None:
        pass


class RaisingLLM:
    def __init__(self, error_factory) -> None:
        self.error_factory = error_factory
        self.calls: list[str] = []

    def generate(self, prompt, **kwargs):
        self.calls.append(prompt)
        raise self.error_factory()

    def cancel(self) -> None:
        pass


def _nodes(config, video_id: int, model_id: str = MODEL_LFM) -> list[dict]:
    conn = connect(config.db_path)
    try:
        rows = conn.execute(
            "SELECT node_id, parent_id, depth, order_idx, start_ms, end_ms, "
            "segment_ids, title, summary, children_count FROM summary_nodes "
            "WHERE video_id = ? AND model = ? ORDER BY depth, node_id",
            (video_id, model_id),
        ).fetchall()
    finally:
        conn.close()
    return [
        {
            "node_id": str(row["node_id"]),
            "parent_id": row["parent_id"],
            "depth": int(row["depth"]),
            "order_idx": int(row["order_idx"]),
            "start_ms": int(row["start_ms"]),
            "end_ms": int(row["end_ms"]),
            "segment_ids": json.loads(row["segment_ids"]),
            "title": row["title"],
            "summary": row["summary"],
            "children_count": int(row["children_count"]),
        }
        for row in rows
    ]


def _level_ids(nodes: list[dict], level_entry: dict) -> list[int]:
    by_id = {node["node_id"]: node for node in nodes}
    result: list[int] = []
    for block in level_entry["blocks"]:
        result.extend(by_id[block["node_id"]]["segment_ids"])
    return result



def _node_text(config, video_id: int, node: dict) -> str:
    conn = connect(config.db_path)
    try:
        rows = conn.execute(
            "SELECT text FROM segments WHERE video_id = ? ORDER BY start_ms, end_ms, id",
            (video_id,),
        ).fetchall()
    finally:
        conn.close()
    texts = {index + 1: row["text"] for index, row in enumerate(rows)}
    return " ".join(texts.get(ref, "") for ref in node["segment_ids"])


def _assert_tree_consistent(config, video_id: int, info: dict) -> None:
    """Полное покрытие каждого уровня, корректные id/родители/листья."""
    nodes = _nodes(config, video_id)
    assert nodes, "дерево не записано"
    by_id = {node["node_id"]: node for node in nodes}
    all_ids = sorted(segment["id"] for segment in info["segments"])
    assert sorted(node["segment_ids"] for node in nodes if node["depth"] == 0) == [all_ids]
    # parent/children согласованы, id иерархичны
    for node in nodes:
        if node["depth"] == 0:
            assert node["node_id"] == "0"
            assert node["parent_id"] is None
            continue
        parent = by_id[node["parent_id"]]
        assert parent["depth"] == node["depth"] - 1
        assert node["node_id"].rsplit(".", 1)[0] == parent["node_id"]
        assert node["children_count"] == sum(
            1 for child in nodes if child["parent_id"] == node["node_id"]
        )
        assert node["start_ms"] < node["end_ms"]
    # листья покрывают всё без пересечений
    leaves = [node for node in nodes if node["children_count"] == 0]
    leaf_ids = [ref for leaf in leaves for ref in leaf["segment_ids"]]
    assert sorted(leaf_ids) == all_ids
    assert len(leaf_ids) == len(set(leaf_ids))
    # каждый уровень — полное покрытие без повторов
    assert info["max_level"] == max(info["levels"])
    # дети — непрерывное разбиение родителя по порядку
    for node in nodes:
        if node["depth"] == 0 or node["children_count"] == 0:
            continue
        parent = by_id[node["parent_id"]]
        flat = [
            ref
            for child in sorted(
                (item for item in nodes if item["parent_id"] == node["node_id"]),
                key=lambda item: parent["segment_ids"].index(item["segment_ids"][0]),
            )
            for ref in child["segment_ids"]
        ]
        assert flat == node["segment_ids"], (
            f"дети узла {node['node_id']} не образуют непрерывное разбиение"
        )
    for level, entry in info["levels"].items():
        ids = _level_ids(nodes, entry)
        assert sorted(ids) == all_ids, f"уровень {level} не покрывает весь текст"
        assert len(ids) == len(set(ids)), f"уровень {level} содержит пересечения"
        assert entry["label"]
        # уровни отсортированы по времени и не пересекаются
        sorted_blocks = sorted(
            entry["blocks"], key=lambda block: (block["start_ms"], block["end_ms"])
        )
        assert entry["blocks"] == sorted_blocks, f"уровень {level} не отсортирован"
        for previous, current in zip(entry["blocks"], entry["blocks"][1:], strict=False):
            assert previous["end_ms"] <= current["start_ms"], (
                f"уровень {level}: блоки {previous['node_id']} и {current['node_id']} пересекаются"
            )
        # summary_levels материализуются ПОСЛЕ DESCRIBE-пасса
        for block in entry["blocks"]:
            node = by_id[block["node_id"]]
            assert block["text"] == node["summary"]
            assert block.get("title") == node["title"]
    # уровень max — ровно корневое саммари
    root_blocks = info["levels"][info["max_level"]]["blocks"]
    assert len(root_blocks) == 1
    assert root_blocks[0]["node_id"] == "0"
    assert root_blocks[0]["text"] == info["root_summary"]
    assert root_blocks[0]["start_ms"] == 0
    assert root_blocks[0]["end_ms"] == max(leaf["end_ms"] for leaf in leaves)


# ---------- tree: чанки и уровни ----------


def _segments(count: int, *, text: str = "короткий текст лекции", duration: int = 30_000):
    return [
        {
            "id": index + 1,
            "start_ms": index * duration,
            "end_ms": (index + 1) * duration,
            "text": text,
        }
        for index in range(count)
    ]


def test_estimate_tokens():
    assert tree.estimate_tokens("") == 0
    assert tree.estimate_tokens("a" * 35) == 10
    assert tree.estimate_tokens("a" * 36) == 11


def test_chunk_segments_full_coverage_without_overlap():
    segments = _segments(9, text="длинный текст " * 20)
    chunks = tree.chunk_segments(segments, max_tokens=80)
    assert len(chunks) > 1
    covered = [segment["id"] for chunk in chunks for segment in chunk]
    assert covered == [segment["id"] for segment in segments]
    assert len(covered) == len(set(covered)), "чанки не должны пересекаться"
    for chunk in chunks:
        assert tree.segments_tokens(chunk) <= 80 or len(chunk) == 1


def test_chunk_single_oversized_segment_stays_whole():
    segments = [{"id": 1, "start_ms": 0, "end_ms": 400_000, "text": "очень длинный " * 500}]
    chunks = tree.chunk_segments(segments, max_tokens=100)
    assert len(chunks) == 1
    assert chunks[0][0]["id"] == 1


def test_tree_node_ids_and_levels_dynamic():
    # Дерево: root → (0.0 → (0.0.0, 0.0.1)), (0.1 → (0.1.0 → (0.1.0.0, 0.1.0.1)))
    root = tree.make_root([1, 2, 3, 4, 5, 6], "Корневое саммари")
    first = root.add_child(segment_ids=[1, 2, 3], title="Первая тема", summary="A")
    first.add_child(segment_ids=[1, 2], title="A1", summary="a1")
    first.add_child(segment_ids=[3], title="A2", summary="a2")
    second = root.add_child(segment_ids=[4, 5, 6], title="Вторая тема", summary="B")
    deep = second.add_child(segment_ids=[4, 5, 6], title="B1", summary="b1")
    deep.add_child(segment_ids=[4, 5], title="B1a", summary="b1a")
    deep.add_child(segment_ids=[6], title="B1b", summary="b1b")
    assert [node.node_id for node in root.walk()] == [
        "0",
        "0.0",
        "0.0.0",
        "0.0.1",
        "0.1",
        "0.1.0",
        "0.1.0.0",
        "0.1.0.1",
    ]
    assert first.node_id == "0.0" and first.parent_id == "0"
    assert tree.max_depth(root) == 3
    assert tree.node_count(root) == 8
    levels = tree.block_levels(root)
    assert sorted(levels) == [1, 2, 3, 4]
    expected_levels = {
        4: ["0"],
        3: ["0.0", "0.1"],
        2: ["0.0.0", "0.0.1", "0.1.0"],
        1: ["0.0.0", "0.0.1", "0.1.0.0", "0.1.0.1"],
    }
    for level, node_ids in expected_levels.items():
        assert [node.node_id for node in levels[level]] == node_ids
        covered = [ref for node in levels[level] for ref in node.segment_ids]
        assert sorted(covered) == [1, 2, 3, 4, 5, 6]
    assert {
        level: tree.level_label(level, 4) for level in range(1, 5)
    } == {1: "Подробно", 2: "Кратко", 3: "Темы", 4: "Обзор"}
    assert tree.level_label(1, 3) == "Подробно"
    assert tree.level_label(2, 3) == "Темы"
    assert tree.level_label(3, 3) == "Обзор"
    assert tree.level_label(1, 2) == "Подробно"
    assert tree.level_label(2, 2) == "Обзор"


def test_level_labels_for_deep_tree():
    root = tree.make_root([1], "root")
    node = root
    for depth in range(1, 6):
        node = node.add_child(segment_ids=[1], title=f"d{depth}", summary="s")
    levels = tree.block_levels(root)
    assert sorted(levels) == [1, 2, 3, 4, 5, 6]
    labels = {level: tree.level_label(level, 6) for level in range(1, 7)}
    assert labels[6] == "Обзор"
    assert labels[5] == "Темы"
    assert labels[1] == "Подробно"
    assert labels[2] == "Средне"
    assert labels[3] in ("Средне", "Кратко")
    assert labels[4] == "Кратко"


# ---------- промпты/схемы/грамматики ----------


def test_prompt_version_and_no_placeholders():
    assert prompts.PROMPT_VERSION == 3
    assert prompts.outline_system().startswith("### OUTLINE\n")
    assert prompts.outline_system(chunked=True).startswith("### OUTLINE_CHUNK\n")
    assert prompts.split_system().startswith("### SPLIT\n")
    assert prompts.split_system(force=True).startswith("### SPLIT_FORCE\n")
    assert prompts.merge_system().startswith("### MERGE\n")
    assert prompts.describe_system().startswith("### DESCRIBE\n")
    for system in (
        prompts.outline_system(),
        prompts.outline_system(chunked=True),
        prompts.split_system(),
        prompts.split_system(force=True),
        prompts.merge_system(),
        prompts.describe_system(),
    ):
        assert "…" not in system, "никаких заглушек, которые копируют маленькие модели"
    for system in (
        prompts.outline_system(),
        prompts.outline_system(chunked=True),
        prompts.split_system(),
        prompts.split_system(force=True),
    ):
        assert "segment_ids" in system
    split_system = prompts.split_system()
    assert "ТОЛЬКО по смыслу" in split_system
    assert "по времени" in split_system
    assert "по количеству строк" in split_system
    assert "подвопросы" in split_system
    # rev3: за требования к информативности заголовков/описаний
    for system in (
        prompts.outline_system(),
        prompts.outline_system(chunked=True),
        prompts.split_system(),
        prompts.split_system(force=True),
        prompts.describe_system(),
    ):
        assert "3–8 слов" in system
        assert "title" in system and "summary" in system
    force_system = prompts.split_system(force=True)
    assert "ГАРАНТИРОВАННО" in force_system
    assert "split=false недопустим" in force_system
    assert "30–120 секунд" in prompts.outline_system()
    assert "4–8" in prompts.outline_system()


def test_outline_user_has_duration_and_blocks_hint():
    segments = _segments(3)
    user = prompts.outline_user(segments, duration_ms=180_000, blocks_hint=5)
    assert "Длительность видео: 3 мин 00 с" in user
    assert "Ориентир: 5 смысловых блоков" in user
    assert "[1] [00:00–00:30]" in user


def test_describe_prompts_and_schemas():
    segments = _segments(2)
    system, user = prompts.describe_messages(
        segments, current_title="Переходим к главному", current_summary="Саммари блока: о продажах"
    )
    assert "### DESCRIBE" in system
    # rev3: текущие title/summary не передаём — модель их копировала
    assert "Текущий заголовок" not in user
    assert "Текущее описание" not in user
    assert "[1] [00:00–00:30]" in user
    schema = prompts.describe_schema()
    assert schema["required"] == ["title", "summary"]
    grammar = prompts.describe_grammar()
    assert "root ::=" in grammar
    assert '\\"title\\"' in grammar
    assert '\\"summary\\"' in grammar


def test_prompt_messages_format_segments():
    segments = _segments(2)
    system, user = prompts.outline_messages(segments)
    assert "### OUTLINE" in system
    assert "[1] [00:00–00:30]" in user
    assert "[2] [00:30–01:00]" in user
    system, user = prompts.outline_messages(segments, chunked=True)
    assert "### OUTLINE_CHUNK" in system
    system, user = prompts.split_messages(
        segments, title="Тема", summary="О чём блок"
    )
    assert "Блок: Тема" in user
    assert "Саммари блока: О чём блок" in user
    system, user = prompts.merge_messages(["Первое саммари.", "Второе саммари."])
    assert "### MERGE" in system
    assert "Фрагмент 1: Первое саммари." in user
    assert "Фрагмент 2: Второе саммари." in user


def test_schemas_and_grammars():
    outline = prompts.outline_schema()
    assert outline["required"] == ["summary", "blocks"]
    assert outline["properties"]["blocks"]["items"] is prompts.BLOCK_SCHEMA
    assert prompts.split_schema()["properties"]["split"]["type"] == "boolean"
    assert prompts.merge_schema()["required"] == ["summary"]
    outline_grammar = prompts.outline_grammar()
    assert "root ::=" in outline_grammar
    assert '\\"summary\\"' in outline_grammar
    assert '\\"blocks\\"' in outline_grammar
    split_grammar = prompts.split_grammar()
    assert '\\"split\\"' in split_grammar
    assert '"false"' in split_grammar
    assert '\\"blocks\\"' in split_grammar
    merge_grammar = prompts.merge_grammar()
    assert "root ::=" in merge_grammar
    assert '\\"summary\\"' in merge_grammar


# ---------- парсер ----------


def test_extract_json_after_thinking_and_markdown():
    raw = '<think>рассуждаю...</think>Ответ:\n```json\n{"summary": "ok", "blocks": []}\n```'
    assert parser.extract_json(raw) == {"summary": "ok", "blocks": []}
    assert parser.extract_json("без json") is None


def test_parse_outline_normalizes_coverage():
    segments = _segments(5)
    raw = json.dumps(
        {
            "summary": "О чём лекция.",
            "blocks": [
                {"segment_ids": [1, 2, 99], "title": "Раз", "summary": "Первое."},
                {"segment_ids": [2, 3], "title": "Два", "summary": "Второе."},
                {"segment_ids": [0], "title": "Мусор", "summary": "Нет."},
            ],
        },
        ensure_ascii=False,
    )
    parsed = parser.parse_outline(raw, segments)
    assert parsed is not None
    assert parsed["summary"] == "О чём лекция."
    covered = [ref for block in parsed["blocks"] for ref in block["segment_ids"]]
    assert covered == [1, 2, 3, 4, 5]
    assert len(covered) == len(set(covered))
    assert parsed["blocks"][0]["start_ms"] == 0
    assert parsed["blocks"][-1]["end_ms"] == 150_000
    for block in parsed["blocks"]:
        assert 0 < len(block["title"]) <= 120
        assert block["summary"]


def test_parse_outline_single_block_requires_single_for_big_input():
    segments = _segments(5)
    raw = json.dumps(
        {
            "summary": "Саммари.",
            "blocks": [{"segment_ids": [1, 2, 3, 4, 5], "title": "Всё", "summary": "Всё"}],
        },
        ensure_ascii=False,
    )
    assert parser.parse_outline(raw, segments) is None
    parsed = parser.parse_outline(raw, segments, allow_single=True)
    assert parsed is not None and len(parsed["blocks"]) == 1


def test_parse_split_variants():
    segments = _segments(4)
    assert parser.parse_split('{"split": false}', segments) == {"split": False}
    assert parser.parse_split("{}", segments) is None
    assert parser.parse_split("не json", segments) is None
    one_block = json.dumps(
        {
            "split": True,
            "blocks": [{"segment_ids": [1, 2, 3, 4], "title": "Все", "summary": "Все"}],
        },
        ensure_ascii=False,
    )
    assert parser.parse_split(one_block, segments) == {"split": False}
    two_blocks = json.dumps(
        {
            "split": True,
            "blocks": [
                {"segment_ids": [1, 2], "title": "А", "summary": "а"},
                {"segment_ids": [3, 4], "title": "Б", "summary": "б"},
            ],
        },
        ensure_ascii=False,
    )
    parsed = parser.parse_split(two_blocks, segments)
    assert parsed is not None and parsed["split"] is True
    assert [block["segment_ids"] for block in parsed["blocks"]] == [[1, 2], [3, 4]]


def test_parse_merge_and_fallbacks():
    assert parser.parse_merge('{"summary": "Итог."}') == {"summary": "Итог."}
    assert parser.parse_merge('{"summary": ""}') is None
    assert parser.parse_merge("не json") is None
    segments = _segments(6, text="Первое предложение. Второе предложение.")
    fallback = parser.fallback_outline(segments)
    assert fallback["summary"]
    assert len(fallback["blocks"]) >= 2
    covered = [ref for block in fallback["blocks"] for ref in block["segment_ids"]]
    assert covered == [1, 2, 3, 4, 5, 6]
    split = parser.fallback_split(segments)
    assert split["split"] is True
    assert len(split["blocks"]) == 2
    assert parser.fallback_split(_segments(2))["split"] is False
    merged = parser.fallback_merge(["Первое.", "Второе."])
    assert "Первое." in merged["summary"]
    assert parser.leaf_summary(segments).startswith("Первое предложение.")


def test_first_sentences_and_keywords():
    text = "Первое предложение. Второе предложение. Третье предложение. Четвёртое."
    assert parser.first_sentences(text, max_sentences=2) == (
        "Первое предложение. Второе предложение."
    )
    assert len(parser.first_sentences(text, max_chars=20)) <= 21
    keywords = parser.extract_keywords("Нейронные сети и градиентный спуск обучают модель.")
    assert "Нейронные" in keywords


# ---------- пайплайн: OUTLINE всего текста ----------


def test_pipeline_outline_fits_whole_text(env):
    factory = CountingFactory()
    pipeline = SummaryPipeline(env, client_factory=factory)
    video_id = _video(env)
    progress: list[tuple[str, int, int]] = []
    result = pipeline.generate(
        video_id,
        MODEL_LFM,
        progress=lambda stage, done, total: progress.append((stage, done, total)),
    )
    assert result["state"] == "ready"
    assert result["fallback"] is False
    assert factory.models == [MODEL_LFM]
    assert result["max_level"] >= 3, "fake должен дать дерево глубины ≥ 2"
    assert result["root_summary"]
    assert {stage for stage, _, _ in progress} == {"outline", "splitting", "summarizing"}
    assert all(done <= total for _, done, total in progress)
    stages = [stage for stage, _, _ in progress]
    assert stages.index("outline") < stages.index("splitting") < stages.index("summarizing")
    info = pipeline.inspect(video_id, MODEL_LFM)
    assert info["ready"] is True
    assert info["stale"] is False
    _assert_tree_consistent(env, video_id, info)
    # весь текст анализируется одним OUTLINE-вызовом, без чанков и merge
    calls = factory.calls()
    assert sum(1 for call in calls if call.startswith("### OUTLINE\n")) == 1
    assert not any("### OUTLINE_CHUNK" in call for call in calls)
    assert not any("### MERGE" in call for call in calls)


def test_pipeline_outline_chunked_with_merge(env, monkeypatch):
    monkeypatch.setattr(tree, "OUTLINE_BUDGET_TOKENS", 25)
    monkeypatch.setattr(tree, "SPLIT_BUDGET_TOKENS", 25)
    factory = CountingFactory()
    pipeline = SummaryPipeline(env, client_factory=factory)
    video_id = _video(env)
    result = pipeline.generate(video_id, MODEL_LFM)
    assert result["state"] == "ready"
    assert result["root_summary"], "нужно верхнеуровневое саммари всего видео"
    calls = factory.calls()
    chunk_calls = sum(1 for call in calls if call.startswith("### OUTLINE_CHUNK"))
    assert chunk_calls >= 2, "текст должен резаться на чанки по бюджету токенов"
    assert sum(1 for call in calls if call.startswith("### MERGE")) >= 1
    assert not any(call.startswith("### OUTLINE\n") for call in calls)
    info = pipeline.inspect(video_id, MODEL_LFM)
    assert info["ready"] is True
    _assert_tree_consistent(env, video_id, info)
    # top-level блоки — объединение блоков чанков, по порядку и без пересечений
    nodes = _nodes(env, video_id)
    top = sorted(
        (node for node in nodes if node["depth"] == 1), key=lambda node: node["start_ms"]
    )
    covered = [ref for node in top for ref in node["segment_ids"]]
    assert covered == [1, 2, 3, 4, 5, 6, 7, 8]


def test_pipeline_block_larger_than_context_is_chunked(env, monkeypatch):
    # OUTLINE всего текста влезает, но SPLIT-бюджет блока меньше: блок режется
    # на чанки внутри блока, а не по времени.
    monkeypatch.setattr(tree, "OUTLINE_BUDGET_TOKENS", 400)
    monkeypatch.setattr(tree, "SPLIT_BUDGET_TOKENS", 40)
    factory = CountingFactory()
    pipeline = SummaryPipeline(env, client_factory=factory)
    video_id = _video(env, TEXTS[:6])
    result = pipeline.generate(video_id, MODEL_LFM)
    assert result["state"] == "ready"
    calls = factory.calls()
    chunk_calls = sum(1 for call in calls if call.startswith("### OUTLINE_CHUNK"))
    assert chunk_calls >= 2, "блок больше контекста должен размечаться по чанкам"
    info = pipeline.inspect(video_id, MODEL_LFM)
    _assert_tree_consistent(env, video_id, info)
    nodes = _nodes(env, video_id)
    # у хотя бы одного top-блока есть дети, полученные chunked-outline внутри блока
    assert any(
        node["depth"] == 1 and node["children_count"] >= 2 for node in nodes
    )


def test_pipeline_split_recursion_leaves_and_depth(env):
    pipeline = SummaryPipeline(env, client_factory=CountingFactory())
    video_id = _video(env)
    result = pipeline.generate(video_id, MODEL_LFM)
    nodes = _nodes(env, video_id)
    assert max(node["depth"] for node in nodes) == 2
    leaves = [node for node in nodes if node["children_count"] == 0]
    assert leaves
    for leaf in leaves:
        assert len(leaf["segment_ids"]) <= tree.MIN_LEAF_SEGMENTS
        assert leaf["summary"]
    assert result["max_level"] == 3
    info = pipeline.inspect(video_id, MODEL_LFM)
    assert info["levels"][1]["label"] == "Подробно"
    assert info["levels"][2]["label"] == "Темы"
    assert info["levels"][3]["label"] == "Обзор"


def test_pipeline_max_depth_limit(env, monkeypatch):
    monkeypatch.setattr(tree, "MAX_DEPTH", 1)
    pipeline = SummaryPipeline(env, client_factory=CountingFactory())
    video_id = _video(env)
    result = pipeline.generate(video_id, MODEL_LFM)
    assert result["max_level"] == 2
    nodes = _nodes(env, video_id)
    assert max(node["depth"] for node in nodes) == 1
    info = pipeline.inspect(video_id, MODEL_LFM)
    _assert_tree_consistent(env, video_id, info)


def test_pipeline_max_nodes_limit(env, monkeypatch):
    monkeypatch.setattr(tree, "MAX_NODES", 6)
    pipeline = SummaryPipeline(env, client_factory=CountingFactory())
    video_id = _video(env)
    pipeline.generate(video_id, MODEL_LFM)
    nodes = _nodes(env, video_id)
    assert len(nodes) <= 6
    info = pipeline.inspect(video_id, MODEL_LFM)
    assert info["ready"] is True
    _assert_tree_consistent(env, video_id, info)


def test_pipeline_call_limit_uses_fallback(env, monkeypatch):
    monkeypatch.setattr(tree, "MAX_CALLS", 1)
    pipeline = SummaryPipeline(env, client_factory=CountingFactory())
    video_id = _video(env)
    result = pipeline.generate(video_id, MODEL_LFM)
    assert result["state"] == "ready"
    assert result["fallback"] is True
    info = pipeline.inspect(video_id, MODEL_LFM)
    _assert_tree_consistent(env, video_id, info)


# ---------- пайплайн: repair/fallback/ошибки ----------


class InvalidOnceThenFake:
    name = "invalid-once"

    def __init__(self) -> None:
        self.fake = FakeLLMClient()
        self.first = True
        self.calls: list[str] = []

    def generate(self, prompt, *, json_schema=None, grammar=None, system=None,
                 max_tokens=512, thinking=False):
        self.calls.append(prompt)
        if self.first:
            self.first = False
            return "это не json"
        return self.fake.generate(
            prompt,
            json_schema=json_schema,
            grammar=grammar,
            system=system,
            max_tokens=max_tokens,
            thinking=thinking,
        )

    def cancel(self) -> None:
        pass


def test_pipeline_repair_call_then_success(env):
    client = InvalidOnceThenFake()
    pipeline = SummaryPipeline(env, client_factory=lambda model_id, gguf: client)
    video_id = _video(env)
    result = pipeline.generate(video_id, MODEL_LFM)
    assert result["state"] == "ready"
    assert result["fallback"] is False
    assert len(client.calls) >= 2
    assert "Предыдущий ответ" in client.calls[1]
    info = pipeline.inspect(video_id, MODEL_LFM)
    assert info["ready"] is True
    _assert_tree_consistent(env, video_id, info)


def test_pipeline_extractive_fallback_after_invalid_output(env):
    client = StubbornLLM()
    pipeline = SummaryPipeline(env, client_factory=lambda model_id, gguf: client)
    video_id = _video(env)
    result = pipeline.generate(video_id, MODEL_LFM)
    assert result["state"] == "ready"
    assert result["fallback"] is True
    assert result["root_summary"]
    info = pipeline.inspect(video_id, MODEL_LFM)
    assert info["ready"] is True
    _assert_tree_consistent(env, video_id, info)
    # первый OUTLINE + repair
    assert len(client.calls) >= 2


def test_pipeline_llm_error_uses_fallback(env):
    client = RaisingLLM(lambda: LLMError("summary_repetition", "boom"))
    pipeline = SummaryPipeline(env, client_factory=lambda model_id, gguf: client)
    video_id = _video(env)
    result = pipeline.generate(video_id, MODEL_LFM)
    assert result["state"] == "ready"
    assert result["fallback"] is True
    info = pipeline.inspect(video_id, MODEL_LFM)
    _assert_tree_consistent(env, video_id, info)


def test_pipeline_timeout_maps_to_summary_timeout(env):
    client = RaisingLLM(lambda: LLMTimeout("Модель не ответила"))
    pipeline = SummaryPipeline(env, client_factory=lambda model_id, gguf: client)
    video_id = _video(env)
    with pytest.raises(SummaryError) as exc_info:
        pipeline.generate(video_id, MODEL_LFM)
    assert exc_info.value.code == "summary_timeout"


def test_pipeline_cancel_raises_cancelled(env):
    import threading

    cancel = threading.Event()
    cancel.set()
    pipeline = SummaryPipeline(env, client_factory=CountingFactory())
    video_id = _video(env)
    with pytest.raises(SummaryError) as exc_info:
        pipeline.generate(video_id, MODEL_LFM, cancel=cancel)
    assert exc_info.value.code == "cancelled"
    assert _nodes(env, video_id) == []


def test_pipeline_missing_model(env):
    video_id = _video(env)
    entry = get_model(MODEL_LFM)
    target = env.models_dir / entry["local_dir"] / "model.gguf"
    target.unlink()
    pipeline = SummaryPipeline(env, client_factory=CountingFactory())
    with pytest.raises(SummaryError) as exc_info:
        pipeline.generate(video_id, MODEL_LFM)
    assert exc_info.value.code == "model_missing"


def test_pipeline_requires_segments(env):
    video_id = add_video(env)
    pipeline = SummaryPipeline(env, client_factory=CountingFactory())
    with pytest.raises(SummaryError) as exc_info:
        pipeline.generate(video_id, MODEL_LFM)
    assert exc_info.value.code == "transcription_not_ready"


def test_pipeline_unknown_video_raises_not_found(env):
    pipeline = SummaryPipeline(env, client_factory=CountingFactory())
    with pytest.raises(SummaryError) as exc_info:
        pipeline.generate(999_999, MODEL_LFM)
    assert exc_info.value.code == "video_not_found"
    assert exc_info.value.status_code == 404


# ---------- пайплайн: кэш/инвалидация/уровни ----------


def test_pipeline_reuses_tree_cache(env):
    factory = CountingFactory()
    pipeline = SummaryPipeline(env, client_factory=factory)
    video_id = _video(env)
    first = pipeline.generate(video_id, MODEL_LFM)
    calls_before = len(factory.calls())
    second = pipeline.generate(video_id, MODEL_LFM)
    assert len(factory.calls()) == calls_before
    assert second["source_hash"] == first["source_hash"]
    assert second["levels"] == first["levels"]
    assert second["root_summary"] == first["root_summary"]
    assert second["max_level"] == first["max_level"]


def test_pipeline_force_regenerates(env):
    factory = CountingFactory()
    pipeline = SummaryPipeline(env, client_factory=factory)
    video_id = _video(env)
    pipeline.generate(video_id, MODEL_LFM)
    calls_before = len(factory.calls())
    pipeline.generate(video_id, MODEL_LFM, force=True)
    assert len(factory.calls()) > calls_before


def test_pipeline_invalidates_on_new_segments(env):
    factory = CountingFactory()
    pipeline = SummaryPipeline(env, client_factory=factory)
    video_id = _video(env, TEXTS[:4])
    first = pipeline.generate(video_id, MODEL_LFM)
    add_segment(env, video_id, 120_000, 150_000, "Новый сегмент про оптимизаторы.")
    second = pipeline.generate(video_id, MODEL_LFM)
    assert first["source_hash"] != second["source_hash"]
    calls_after_new = len(factory.calls())
    info = pipeline.inspect(video_id, MODEL_LFM)
    assert info["ready"] is True
    assert all(
        entry["source_hash"] == second["source_hash"]
        for entry in info["levels"].values()
    )
    # повторный вызов после пересборки — из кэша
    pipeline.generate(video_id, MODEL_LFM)
    assert len(factory.calls()) == calls_after_new


def test_pipeline_per_model_cache(env):
    factory = CountingFactory()
    pipeline = SummaryPipeline(env, client_factory=factory)
    video_id = _video(env)
    pipeline.generate(video_id, MODEL_LFM)
    pipeline.generate(video_id, MODEL_QWEN)
    assert factory.models == [MODEL_LFM, MODEL_QWEN]
    pipeline.generate(video_id, MODEL_LFM)
    assert factory.models == [MODEL_LFM, MODEL_QWEN]
    assert pipeline.inspect(video_id, MODEL_LFM)["ready"] is True
    assert pipeline.inspect(video_id, MODEL_QWEN)["ready"] is True


def test_source_hash_depends_on_prompt_version_tree_params_and_model(env, monkeypatch):
    pipeline = SummaryPipeline(env, client_factory=CountingFactory())
    video_id = _video(env, TEXTS[:2])
    info = pipeline.inspect(video_id, MODEL_LFM)
    segments = info["segments"]
    base = pipeline.source_hash(segments, MODEL_LFM)
    assert pipeline.source_hash(segments, MODEL_QWEN) != base
    monkeypatch.setattr(tree, "MAX_DEPTH", 7)
    assert pipeline.source_hash(segments, MODEL_LFM) != base
    monkeypatch.undo()
    assert pipeline.source_hash(segments, MODEL_LFM) == base


def test_pipeline_level_request_validation(env):
    pipeline = SummaryPipeline(env, client_factory=CountingFactory())
    video_id = _video(env)
    result = pipeline.generate(video_id, MODEL_LFM)
    assert pipeline.generate(video_id, MODEL_LFM, level=result["max_level"])["state"] == "ready"
    with pytest.raises(SummaryError) as exc_info:
        pipeline.generate(video_id, MODEL_LFM, level=result["max_level"] + 1)
    assert exc_info.value.code == "invalid_level"


# ---------- rev3: принудительное деление крупных блоков ----------

_ITEM_RE = re.compile(
    r"^\[(\d+)\] \[(\d{2}):(\d{2})[–-](\d{2}):(\d{2})\] (.+)$",
    re.MULTILINE,
)


def _prompt_ids(prompt: str) -> list[int]:
    return [int(match.group(1)) for match in _ITEM_RE.finditer(prompt)]


def _weak_block(ids: list[int], *, title: str, summary: str) -> dict:
    return {"segment_ids": ids, "title": title, "summary": summary}


def _split_halves(ids: list[int]) -> dict:
    mid = max(1, len(ids) // 2)
    return {
        "split": True,
        "blocks": [
            _weak_block(ids[:mid], title="Первая половина блока", summary="Разбирается первая часть вопросов клиента и возражения."),
            _weak_block(ids[mid:], title="Вторая половина блока", summary="Разбирается вторая часть вопросов клиента и примеры."),
        ],
    }


def _split_thirds(ids: list[int]) -> dict:
    size = max(1, len(ids) // 3)
    parts = [ids[:size], ids[size : 2 * size], ids[2 * size :]]
    parts = [part for part in parts if part]
    return {
        "split": True,
        "blocks": [
            _weak_block(part, title=f"Подтема номер {index + 1}", summary=f"Разбираются вопросы и примеры подтемы {index + 1}.")
            for index, part in enumerate(parts)
        ],
    }


class GiantOutlineLLM(FakeLLMClient):
    """OUTLINE отдаёт гигантский блок (как в реальном баге), SPLIT отказывается."""

    def __init__(
        self,
        *,
        giant_ratio: float = 0.88,
        force_blocks=None,
        chunk_blocks=None,
        describe_invalid: bool = False,
        good_outline: bool = False,
    ) -> None:
        super().__init__()
        self.giant_ratio = giant_ratio
        self.force_blocks = force_blocks
        self.chunk_blocks = chunk_blocks
        self.describe_invalid = describe_invalid
        self.good_outline = good_outline

    def _answer(self, prompt: str) -> str:
        if "### DESCRIBE" in prompt:
            if self.describe_invalid:
                return "это не json"
            return super()._answer(prompt)
        if "### SPLIT_FORCE" in prompt:
            ids = _prompt_ids(prompt)
            if self.force_blocks is not None:
                payload = self.force_blocks(ids)
                if payload is not None:
                    return json.dumps(payload, ensure_ascii=False)
            return '{"split": false}'
        if "### SPLIT" in prompt:
            return '{"split": false}'
        if "### OUTLINE_CHUNK" in prompt:
            ids = _prompt_ids(prompt)
            if self.chunk_blocks is not None:
                payload = self.chunk_blocks(ids)
                if payload is not None:
                    return json.dumps(payload, ensure_ascii=False)
            return json.dumps(
                {
                    "summary": "Один смысловой блок.",
                    "blocks": [
                        _weak_block(
                            ids,
                            title="Переходим к самому главному",
                            summary="Переходим к самому главному продаже.",
                        )
                    ],
                },
                ensure_ascii=False,
            )
        if "### OUTLINE" in prompt:
            ids = _prompt_ids(prompt)
            if self.good_outline:
                size = max(1, len(ids) // 4)
                parts = [ids[index : index + size] for index in range(0, len(ids), size)]
                blocks = [
                    _weak_block(
                        part,
                        title=f"Работа с возражениями клиента {index + 1}",
                        summary=f"В блоке разбираются вопросы темы {index + 1} и примеры из практики продаж.",
                    )
                    for index, part in enumerate(parts)
                    if part
                ]
                return json.dumps(
                    {
                        "summary": "Определение продажи, работа с потребностями клиента и примеры командной работы в отделе продаж.",
                        "blocks": blocks,
                    },
                    ensure_ascii=False,
                )
            cut = max(1, int(len(ids) * self.giant_ratio))
            giant, tail = ids[:cut], ids[cut:]
            blocks = [
                _weak_block(
                    giant,
                    title="Переходим к самому главному продаже",
                    summary="Переходим к самому главному продаже.",
                )
            ]
            if tail:
                blocks.append(
                    _weak_block(
                        tail,
                        title="На мой личный контакт с телеграмом вы можете",
                        summary="На мой личный контакт с телеграмом вы можете написать.",
                    )
                )
            return json.dumps(
                {"summary": "Видео о продажах.", "blocks": blocks},
                ensure_ascii=False,
            )
        return super()._answer(prompt)


_VARIED_WORDS = [
    "продажи",
    "клиенты",
    "возражения",
    "ценность",
    "цена",
    "команда",
    "переговоры",
    "потребности",
    "презентация",
    "конверсия",
    "выручка",
    "вопросы",
]


def _varied_texts(count: int = 66) -> list[str]:
    texts = []
    for index in range(count):
        first = _VARIED_WORDS[index % len(_VARIED_WORDS)]
        second = _VARIED_WORDS[(index * 3 + 1) % len(_VARIED_WORDS)]
        third = _VARIED_WORDS[(index * 5 + 2) % len(_VARIED_WORDS)]
        texts.append(
            f"Разбираем {first} и {second}: обсуждаем {third} на конкретном примере."
        )
    texts[0] = "Переходим с вами к самому главному продаже."
    return texts


def _long_texts(count: int) -> list[str]:
    texts = [f"Смысловой фрагмент {index} про продажи, переговоры с клиентом и работу с возражениями." for index in range(1, count + 1)]
    texts[0] = "Переходим с вами к самому главному продаже."
    return texts


def _giant_env(env, texts=None):
    texts = texts or _long_texts(66)
    video_id = _video(env, texts, duration_each=5_000)
    return video_id


def _assert_no_giant_leaves(config, video_id: int, info: dict) -> None:
    nodes = _nodes(config, video_id)
    spans = [
        (int(segment["start_ms"]), int(segment["end_ms"])) for segment in info["segments"]
    ]
    video_duration = max(end for _, end in spans) - min(start for start, _ in spans)
    threshold = max(tree.FORCE_SPLIT_MIN_MS, tree.FORCE_SPLIT_RATIO * video_duration)
    worst = 0
    for node in nodes:
        if node["children_count"] != 0:
            continue
        duration = node["end_ms"] - node["start_ms"]
        worst = max(worst, duration)
        if duration <= threshold:
            continue
        assert (
            len(node["segment_ids"]) < tree.FORCE_SPLIT_MIN_SEGMENTS
            or node["depth"] >= tree.MAX_DEPTH
        ), f"лист-гигант {node['node_id']}: {duration / 1000:.0f} с, {len(node['segment_ids'])} сегм."
    assert worst <= 0.35 * video_duration, (
        f"максимальный лист {worst / 1000:.0f} с > 35% видео ({video_duration / 1000:.0f} с)"
    )


def test_force_split_refusing_model_has_no_giant_leaves(env, caplog):
    caplog.set_level(logging.INFO, logger="app.services.summary.pipeline")
    client = GiantOutlineLLM()
    factory = CountingFactory()
    factory = lambda model_id, gguf: client  # noqa: E731 - один клиент на прогон
    pipeline = SummaryPipeline(env, client_factory=factory)
    video_id = _giant_env(env)
    result = pipeline.generate(video_id, MODEL_LFM)
    assert result["state"] == "ready"
    assert result["fallback"] is True
    info = pipeline.inspect(video_id, MODEL_LFM)
    assert info["ready"] is True
    _assert_tree_consistent(env, video_id, info)
    _assert_no_giant_leaves(env, video_id, info)
    calls = client.calls
    assert any("### SPLIT_FORCE" in call for call in calls)
    logged = "\n".join(record.getMessage() for record in caplog.records)
    assert "force-split" in logged
    assert "path=fallback_halves" in logged


def test_force_split_prefers_forced_split(env, caplog):
    caplog.set_level(logging.INFO, logger="app.services.summary.pipeline")
    client = GiantOutlineLLM(force_blocks=_split_halves)
    pipeline = SummaryPipeline(env, client_factory=lambda model_id, gguf: client)
    video_id = _giant_env(env)
    result = pipeline.generate(video_id, MODEL_LFM)
    assert result["state"] == "ready"
    info = pipeline.inspect(video_id, MODEL_LFM)
    _assert_tree_consistent(env, video_id, info)
    _assert_no_giant_leaves(env, video_id, info)
    logged = "\n".join(record.getMessage() for record in caplog.records)
    assert "path=forced_split" in logged


def test_force_split_falls_back_to_outline_chunk(env, caplog):
    caplog.set_level(logging.INFO, logger="app.services.summary.pipeline")
    client = GiantOutlineLLM(chunk_blocks=_split_thirds)
    pipeline = SummaryPipeline(env, client_factory=lambda model_id, gguf: client)
    video_id = _giant_env(env)
    result = pipeline.generate(video_id, MODEL_LFM)
    assert result["state"] == "ready"
    info = pipeline.inspect(video_id, MODEL_LFM)
    _assert_tree_consistent(env, video_id, info)
    _assert_no_giant_leaves(env, video_id, info)
    logged = "\n".join(record.getMessage() for record in caplog.records)
    assert "path=outline_chunk" in logged


def test_force_split_works_when_calls_exhausted(env, monkeypatch):
    monkeypatch.setattr(tree, "MAX_CALLS", 2)
    client = GiantOutlineLLM()
    pipeline = SummaryPipeline(env, client_factory=lambda model_id, gguf: client)
    video_id = _giant_env(env)
    result = pipeline.generate(video_id, MODEL_LFM)
    assert result["state"] == "ready"
    assert result["fallback"] is True
    info = pipeline.inspect(video_id, MODEL_LFM)
    _assert_tree_consistent(env, video_id, info)
    _assert_no_giant_leaves(env, video_id, info)


def test_force_split_works_when_max_nodes_reached(env, monkeypatch):
    monkeypatch.setattr(tree, "MAX_NODES", 5)
    client = GiantOutlineLLM()
    pipeline = SummaryPipeline(env, client_factory=lambda model_id, gguf: client)
    video_id = _giant_env(env)
    result = pipeline.generate(video_id, MODEL_LFM)
    assert result["state"] == "ready"
    nodes = _nodes(env, video_id)
    info = pipeline.inspect(video_id, MODEL_LFM)
    _assert_tree_consistent(env, video_id, info)
    _assert_no_giant_leaves(env, video_id, info)
    assert len(nodes) > 5, "force-split обязан продолжиться даже при MAX_NODES"


def test_no_force_split_for_small_blocks(env):
    client = GiantOutlineLLM(good_outline=True, force_blocks=_split_halves)
    pipeline = SummaryPipeline(env, client_factory=lambda model_id, gguf: client)
    video_id = _video(env, TEXTS[:8], duration_each=30_000)  # 8 сегм. по 30 с
    pipeline.generate(video_id, MODEL_LFM)
    assert not any("### SPLIT_FORCE" in call for call in client.calls)


# ---------- rev3: DESCRIBE-пасс ----------


def test_describe_pass_improves_weak_titles_and_summaries(env):
    client = GiantOutlineLLM(force_blocks=_split_halves)
    pipeline = SummaryPipeline(env, client_factory=lambda model_id, gguf: client)
    video_id = _giant_env(env)
    result = pipeline.generate(video_id, MODEL_LFM)
    info = pipeline.inspect(video_id, MODEL_LFM)
    _assert_tree_consistent(env, video_id, info)
    describe_calls = [call for call in client.calls if "### DESCRIBE" in call]
    assert describe_calls, "слабые заголовки должны уходить в DESCRIBE-пасс"
    nodes = _nodes(env, video_id)
    top_titles = [
        node["title"] for node in nodes if node["depth"] == 1 and node["title"]
    ]
    root_node = next(node for node in nodes if node["depth"] == 0)
    assert parser.is_weak_root_summary(root_node["summary"]) is False
    assert "О чём видео" in root_node["summary"]
    assert any(title in root_node["summary"] for title in top_titles)
    for node in nodes:
        if node["depth"] == 0:
            continue
        assert node["title"], node
        assert not parser.is_generic_title(node["title"]), node
        assert node["summary"] and len(node["summary"]) >= 20, node
        assert not parser.summary_repeats_title(node["summary"], node["title"]), node
    assert result["fallback"] is False  # force-SPLIT и DESCRIBE справились


def test_describe_fallback_when_llm_returns_garbage(env):
    client = GiantOutlineLLM(force_blocks=_split_halves, describe_invalid=True)
    pipeline = SummaryPipeline(env, client_factory=lambda model_id, gguf: client)
    video_id = _giant_env(env)
    result = pipeline.generate(video_id, MODEL_LFM)
    assert result["state"] == "ready"
    assert result["fallback"] is True
    info = pipeline.inspect(video_id, MODEL_LFM)
    _assert_tree_consistent(env, video_id, info)
    nodes = _nodes(env, video_id)
    for node in nodes:
        if node["depth"] == 0:
            assert node["summary"]
            continue
        assert node["title"] and not parser.is_generic_title(node["title"]), node
        assert node["summary"] and len(node["summary"]) >= 20, node
        assert not parser.summary_repeats_title(node["summary"], node["title"]), node


def test_describe_skips_good_descriptions(env):
    client = GiantOutlineLLM(good_outline=True)
    pipeline = SummaryPipeline(env, client_factory=lambda model_id, gguf: client)
    video_id = _video(env, TEXTS[:8], duration_each=30_000)
    pipeline.generate(video_id, MODEL_LFM)
    assert not any("### DESCRIBE" in call for call in client.calls)


# ---------- rev3: парсер качества описаний ----------




def _prompt_item_tokens(prompt: str) -> int:
    items = [
        {"id": int(m.group(1)), "text": m.group(6)}
        for m in _ITEM_RE.finditer(prompt)
    ]
    return tree.segments_tokens(items)




def test_force_split_promotes_giant_top_level_topic(env):
    """Гигантский top-level блок заменяется подтемами, чтобы «Темы» были осмысленны."""
    client = GiantOutlineLLM(chunk_blocks=_split_thirds)
    pipeline = SummaryPipeline(env, client_factory=lambda model_id, gguf: client)
    video_id = _giant_env(env)
    result = pipeline.generate(video_id, MODEL_LFM)
    info = pipeline.inspect(video_id, MODEL_LFM)
    _assert_tree_consistent(env, video_id, info)
    _assert_no_giant_leaves(env, video_id, info)
    nodes = _nodes(env, video_id)
    root_children = [node for node in nodes if node["depth"] == 1]
    assert len(root_children) > 2, "гигант должен быть разложен на подтемы"
    spans = [(int(segment["start_ms"]), int(segment["end_ms"])) for segment in info["segments"]]
    video_duration = max(end for _, end in spans) - min(start for start, _ in spans)
    topics_level = info["max_level"] - 1
    worst = max(
        block["end_ms"] - block["start_ms"]
        for block in result["levels"][topics_level]
    )
    assert worst <= 0.35 * video_duration, (
        f"уровень «Темы» содержит блок {(worst / video_duration) * 100:.1f}% видео"
    )


def test_force_split_uses_small_chunks_for_giant(env, caplog):
    caplog.set_level(logging.INFO, logger="app.services.summary.pipeline")
    client = GiantOutlineLLM()
    pipeline = SummaryPipeline(env, client_factory=lambda model_id, gguf: client)
    video_id = _giant_env(env)
    pipeline.generate(video_id, MODEL_LFM)
    chunk_calls = [call for call in client.calls if "### OUTLINE_CHUNK" in call]
    small_calls = [
        call
        for call in chunk_calls
        if _prompt_item_tokens(call) <= tree.FORCE_CHUNK_TOKENS + 40
    ]
    assert len(small_calls) >= 2, "гигант должен резаться на мелкие чанки (~800 токенов)"
    for call in chunk_calls:
        assert _prompt_item_tokens(call) <= tree.OUTLINE_BUDGET_TOKENS + 40
    logged = "\n".join(record.getMessage() for record in caplog.records)
    assert "path=outline_chunks" in logged
    info = pipeline.inspect(video_id, MODEL_LFM)
    _assert_no_giant_leaves(env, video_id, info)


def test_describe_prompt_has_parent_and_sibling_context(env):
    client = GiantOutlineLLM(force_blocks=_split_halves)
    pipeline = SummaryPipeline(env, client_factory=lambda model_id, gguf: client)
    video_id = _giant_env(env)
    pipeline.generate(video_id, MODEL_LFM)
    describe_calls = [call for call in client.calls if "### DESCRIBE" in call]
    assert describe_calls
    assert any("Контекст:" in call for call in describe_calls)
    assert any(
        "родительский блок" in call or "соседние темы" in call
        for call in describe_calls
    )


def test_root_overview_built_from_top_level_topics(env):
    client = GiantOutlineLLM(good_outline=True)
    pipeline = SummaryPipeline(env, client_factory=lambda model_id, gguf: client)
    video_id = _video(env, TEXTS[:8], duration_each=30_000)
    result = pipeline.generate(video_id, MODEL_LFM)
    nodes = _nodes(env, video_id)
    root = next(node for node in nodes if node["depth"] == 0)
    top_titles = [node["title"] for node in nodes if node["depth"] == 1 and node["title"]]
    assert not parser.is_weak_root_summary(root["summary"])
    assert root["summary"].startswith("О чём видео:")
    assert "Темы:" in root["summary"]
    assert "Разбираются" not in root["summary"]
    for title in top_titles[:10]:
        assert title in root["summary"], f"root overview не упоминает тему {title!r}"
    assert result["root_summary"] == root["summary"]


def test_root_overview_fallback_when_llm_fails(env):
    client = GiantOutlineLLM(good_outline=True)

    def broken_answer(prompt: str) -> str:
        if "### ROOT_OVERVIEW" in prompt:
            return "не json"
        return FakeLLMClient._answer(client, prompt)

    client._answer = broken_answer  # type: ignore[method-assign]
    pipeline = SummaryPipeline(env, client_factory=lambda model_id, gguf: client)
    video_id = _video(env, TEXTS[:8], duration_each=30_000)
    result = pipeline.generate(video_id, MODEL_LFM)
    nodes = _nodes(env, video_id)
    root = next(node for node in nodes if node["depth"] == 0)
    top_titles = [node["title"] for node in nodes if node["depth"] == 1 and node["title"]]
    assert not parser.is_weak_root_summary(root["summary"])
    assert "О чём видео" in root["summary"]
    for title in top_titles:
        assert title in root["summary"], f"root overview не упоминает тему {title!r}"
    assert result["root_summary"] == root["summary"]


def test_describe_fallback_never_leaves_placeholders(env):
    client = GiantOutlineLLM(force_blocks=_split_halves, describe_invalid=True)
    pipeline = SummaryPipeline(env, client_factory=lambda model_id, gguf: client)
    video_id = _giant_env(env)
    result = pipeline.generate(video_id, MODEL_LFM)
    assert result["fallback"] is True
    nodes = _nodes(env, video_id)
    placeholders = {"фрагмент лекции", "очерк из входа", "слайд про продажи", "смысловой блок"}
    for node in nodes:
        if node["depth"] == 0:
            continue
        assert node["title"].casefold().strip() not in placeholders, node
        assert not parser.is_generic_title(node["title"]), node
        assert node["summary"], node
        assert not node["summary"].startswith("Разбираются:"), node
        assert not node["summary"].startswith("О чём:"), node
        assert not parser.summary_repeats_title(node["summary"], node["title"]), node
        assert not parser.title_is_text_prefix(node["title"], _node_text(env, video_id, node)), node




def test_normalize_blocks_gives_contiguous_partition():
    segments = [
        {"id": index, "start_ms": (index - 1) * 1000, "end_ms": index * 1000, "text": f"fragment {index}"}
        for index in range(1, 11)
    ]
    raw = [
        {"segment_ids": [1, 2, 3, 10], "title": "A", "summary": "a"},
        {"segment_ids": [4, 5], "title": "B", "summary": "b"},
        {"segment_ids": [6, 7, 8, 9], "title": "C", "summary": "c"},
    ]
    blocks = parser.normalize_blocks(raw, segments)
    flat = [ref for block in blocks for ref in block["segment_ids"]]
    assert flat == list(range(1, 11))
    assert [block["segment_ids"] for block in blocks] == [
        block["segment_ids"] for block in blocks
    ]
    for block in blocks:
        assert block["segment_ids"] == list(
            range(block["segment_ids"][0], block["segment_ids"][-1] + 1)
        )
    assert [block["title"] for block in blocks] == ["A", "B", "C"]


def test_malicious_llm_blocks_are_normalized_to_parent(env):
    """LLM возвращает блоки вне родителя/с пересечениями — дерево обязано быть валидным."""

    class MaliciousLLM(FakeLLMClient):
        def _answer(self, prompt: str) -> str:
            ids = _prompt_ids(prompt)
            if "### SPLIT_FORCE" in prompt:
                return '{"split": false}'
            if "### SPLIT" in prompt:
                half = max(1, len(ids) // 2)
                return json.dumps(
                    {
                        "split": True,
                        "blocks": [
                            {"segment_ids": [*ids[:half], 99999], "title": "Вне родителя", "summary": "x"},
                            {"segment_ids": ids[:half], "title": "Пересечение", "summary": "y"},
                            {"segment_ids": ids[half:], "title": "Вторая часть", "summary": "Разбираются вопросы и примеры второй части."},
                        ],
                    },
                    ensure_ascii=False,
                )
            if "### OUTLINE" in prompt:
                if len(ids) <= 4:
                    return super()._answer(prompt)
                third = max(1, len(ids) // 3)
                return json.dumps(
                    {
                        "summary": "Видео о продажах и переговорах с клиентами.",
                        "blocks": [
                            {"segment_ids": ids[2 * third :] + ids[:1], "title": "Последняя тема", "summary": "Разбираются вопросы последней темы."},
                            {"segment_ids": ids[:third], "title": "Первая тема", "summary": "Разбираются вопросы первой темы."},
                            {"segment_ids": ids[third : 2 * third], "title": "Средняя тема", "summary": "Разбираются вопросы средней темы."},
                        ],
                    },
                    ensure_ascii=False,
                )
            return super()._answer(prompt)

    client = MaliciousLLM()
    pipeline = SummaryPipeline(env, client_factory=lambda model_id, gguf: client)
    video_id = _video(env, TEXTS[:16], duration_each=15_000)
    result = pipeline.generate(video_id, MODEL_LFM)
    assert result["state"] == "ready"
    info = pipeline.inspect(video_id, MODEL_LFM)
    assert info["ready"] is True
    _assert_tree_consistent(env, video_id, info)


def test_validate_tree_rejects_broken_partition():
    root = tree.make_root([1, 2, 3, 4, 5, 6], "корень")
    root.add_child(segment_ids=[1, 2, 5], title="A", summary="a")
    root.add_child(segment_ids=[3, 4, 6], title="B", summary="b")
    with pytest.raises(SummaryError) as exc_info:
        SummaryPipeline._validate_tree(root)
    assert exc_info.value.code == "summary_failed"

    good = tree.make_root([1, 2, 3, 4, 5, 6], "корень")
    first = good.add_child(segment_ids=[1, 2, 3], title="A", summary="a")
    second = good.add_child(segment_ids=[4, 5, 6], title="B", summary="b")
    first.add_child(segment_ids=[1], title="A1", summary="a1")
    first.add_child(segment_ids=[2, 3], title="A2", summary="a2")
    second.add_child(segment_ids=[4, 5], title="B1", summary="b1")
    second.add_child(segment_ids=[6], title="B2", summary="b2")
    SummaryPipeline._validate_tree(good)  # не должно бросить




class CopyingDescribeLLM(GiantOutlineLLM):
    """DESCRIBE копирует один и тот же title/description у всех сиблингов."""

    def __init__(self) -> None:
        super().__init__(force_blocks=_split_halves)
        self.describe_calls = 0

    def _answer(self, prompt: str) -> str:
        if "### DESCRIBE" in prompt:
            self.describe_calls += 1
            return json.dumps(
                {
                    "title": "Олимпийская команда",
                    "summary": "Волки волчары, передвижение впереди старых или больных, поддержание и ухаживание за ними.",
                },
                ensure_ascii=False,
            )
        return super()._answer(prompt)


def test_dedupe_sibling_descriptions_and_titles(env):
    client = CopyingDescribeLLM()
    pipeline = SummaryPipeline(env, client_factory=lambda model_id, gguf: client)
    video_id = _video(env, _varied_texts(66), duration_each=5_000)
    result = pipeline.generate(video_id, MODEL_LFM)
    assert result["state"] == "ready"
    assert client.describe_calls > 0
    nodes = _nodes(env, video_id)
    by_parent: dict[str, list[dict]] = {}
    for node in nodes:
        if node["parent_id"]:
            by_parent.setdefault(node["parent_id"], []).append(node)
    checked = 0
    for parent_id, children in by_parent.items():
        if len(children) < 2:
            continue
        titles = [child["title"] for child in children]
        assert len({title.casefold().strip() for title in titles}) == len(titles), (
            f"дубли title у детей {parent_id}: {titles}"
        )
        for index, child in enumerate(children):
            assert not parser.is_generic_title(child["title"]), child
            assert child["summary"]
            assert not child["summary"].startswith(("Разбираются:", "О чём:")), child
            for other in children[index + 1 :]:
                assert not parser.is_near_duplicate(
                    child["summary"], other["summary"]
                ), f"дубли описаний у {child['node_id']} и {other['node_id']}"
                checked += 1
    assert checked > 0, "нужны сиблинги для проверки"
    _assert_tree_consistent(env, video_id, pipeline.inspect(video_id, MODEL_LFM))


def test_root_summary_unique_clean_themes(env):
    client = CopyingDescribeLLM()
    pipeline = SummaryPipeline(env, client_factory=lambda model_id, gguf: client)
    video_id = _video(env, _varied_texts(66), duration_each=5_000)
    result = pipeline.generate(video_id, MODEL_LFM)
    root = result["root_summary"]
    assert root.startswith("О чём видео:")
    assert "Темы:" in root
    assert "Разбираются" not in root
    themes = [item.strip() for item in root.split("Темы:", 1)[1].rstrip(".").split(";")]
    assert 2 <= len(themes) <= 8, themes
    assert len({theme.casefold() for theme in themes}) == len(themes), themes
    for theme in themes:
        assert theme and not parser.is_generic_title(theme), theme


def test_parser_quality_helpers():
    assert parser.is_generic_title("Переходим к самому главному продаже")
    assert parser.is_generic_title("На мой личный контакт с телеграмом вы можете")
    assert parser.is_generic_title("Слайд про продажи")
    assert parser.is_generic_title("")
    assert not parser.is_generic_title("Продажа как деньги в кассе")
    assert parser.summary_repeats_title("Продажа как деньги в кассе", "Продажа как деньги в кассе")
    assert parser.summary_repeats_title(
        "Продажа как деньги в кассе — это когда деньги получены.",
        "Продажа как деньги в кассе",
    )
    assert not parser.summary_repeats_title(
        "Разбирается разница между продажей и наработкой.", "Продажа как деньги в кассе"
    )
    text = "Переходим с вами к самому главному продаже. Продажа — это когда деньги в кассе. Наработка может не оплатить."
    assert parser.is_first_phrase_copy("Переходим с вами к самому главному продаже.", text)
    assert not parser.is_first_phrase_copy(
        "Продажа — это когда деньги в кассе. Наработка может не оплатить.", text
    )
    assert parser.needs_description("Переходим к главному", "Переходим к главному", text)
    assert parser.needs_description("", "Саммари блока: о продажах и деньгах", text)
    assert not parser.needs_description(
        "Продажа как деньги в кассе",
        "В блоке разбираются определение продажи и разница между продажей и наработкой клиента.",
        text,
    )




def test_prompt_root_overview_and_describe_context():
    topics = [
        {"title": "Продажа как деньги в кассе", "summary": "Определение продажи и наработки."},
        {"title": "Работа с потребностями клиента", "summary": "Выявление потребностей и ценность."},
    ]
    system, user = prompts.root_overview_messages(topics)
    assert system.startswith("### ROOT_OVERVIEW")
    assert "Тема 1: Продажа как деньги в кассе — Определение продажи и наработки." in user
    assert "Тема 2: Работа с потребностями клиента" in user
    assert "Перечисли все темы" in system
    assert "не начинай" in system.casefold() or "не начинай" in system
    assert prompts.describe_system().startswith("### DESCRIBE")
    assert "О чём:" in prompts.describe_system()
    for forbidden in ("фрагмент", "очерк", "слайд", "в этом видео"):
        assert forbidden in prompts.describe_system()
    segments = _segments(2)
    _system, user = prompts.describe_messages(
        segments,
        current_title="Переходим к главному",
        current_summary="Переходим к главному продаже.",
        context=["родительский блок", "соседние темы"],
    )
    assert "Контекст: родительский блок" in user
    assert "Контекст: соседние темы" in user


def test_parser_new_quality_helpers():
    text = (
        "Переходим с вами к самому главному продаже. "
        "Продажа — это когда деньги в кассе. Наработка может не оплатить."
    )
    assert parser.is_raw_text_copy(
        "Переходим с вами к самому главному продаже. Продажа — это когда деньги в кассе. Наработка может не оплатить.",
        text,
    )
    assert not parser.is_raw_text_copy("О чём: продажа. Разбираются вопросы и примеры.", text)
    assert parser.title_is_text_prefix("Переходим с вами к самому главному", text)
    assert not parser.title_is_text_prefix("Продажа как деньги в кассе", text)
    assert parser.derive_title(text) and not parser.is_generic_title(parser.derive_title(text))
    fallback = parser.fallback_describe(text)
    assert fallback["title"] not in {"Фрагмент лекции", "Смысловой блок"}
    assert not parser.summary_repeats_title(fallback["summary"], fallback["title"])
    overview = parser.fallback_root_overview(
        [
            {"title": "Продажа как деньги в кассе", "summary": "Определение продажи."},
            {"title": "Работа с потребностями", "summary": "Выявление потребностей."},
        ]
    )
    assert "О чём видео" in overview
    assert "Продажа как деньги в кассе" in overview
    assert "Работа с потребностями" in overview
    assert not parser.is_weak_root_summary(overview)


def test_parser_description_fallback_normalized():
    text = (
        "Переходим с вами к самому главному продаже. "
        "Продажа — это на самом деле, когда деньги в кассе. "
        "Наработка может не оплатить, поэтому важно говорить о цене и ценности."
    )
    described = parser.fallback_describe(text)
    assert not parser.is_generic_title(described["title"])
    assert described["summary"]
    assert not parser.is_first_phrase_copy(described["summary"], text)
    assert not parser.summary_repeats_title(described["summary"], described["title"])
    parsed = parser.parse_describe(
        json.dumps(
            {
                "title": "Продажа как деньги в кассе",
                "summary": "Разбирается определение продажи и отличие продажи от наработки клиентов.",
            },
            ensure_ascii=False,
        )
    )
    assert parsed is not None
    assert parser.parse_describe('{"title": "Переходим к главному", "summary": "Переходим к главному продаже."}') is None
    assert parser.parse_describe("не json") is None


def test_outline_user_duration_guidance_reaches_prompt(env):
    client = GiantOutlineLLM(good_outline=True)
    pipeline = SummaryPipeline(env, client_factory=lambda model_id, gguf: client)
    video_id = _video(env, TEXTS[:8], duration_each=30_000)
    pipeline.generate(video_id, MODEL_LFM)
    outline_call = next(call for call in client.calls if "### OUTLINE\n" in call)
    assert "Длительность видео: 4 мин 00 с" in outline_call
    assert "Ориентир: 5 смысловых блоков" in outline_call
    assert "30–120 секунд" in outline_call
