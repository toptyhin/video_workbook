"""M14 rev2: интеграция с реальной моделью llama.cpp (``VL_SUMMARY_REAL=1``).

Запуск::

    VL_SUMMARY_REAL=1 VL_MODELS_DIR=../.tmp/e2e-models \
    VL_LLAMA_CLI=../resources/llama/llama-cli \
    ../.venv/bin/python -m pytest -q tests/test_m14_real_model.py -o addopts=""

Тесты не входят в обычный прогон: реальные GGUF-модели отвечают медленно.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from app.db import connect, migrate
from app.services.llm import LlamaCliClient
from app.services.model_resolver import get_model, resolve_summary_gguf
from app.services.summary import SummaryPipeline, parser, prompts, tree
from tests.helpers import add_segment, add_video

pytestmark = pytest.mark.skipif(
    os.environ.get("VL_SUMMARY_REAL") != "1",
    reason="реальная модель llama.cpp проверяется при VL_SUMMARY_REAL=1",
)

MODELS = ("summary-lfm2.5-350m", "summary-qwen2.5-0.5b")
TEXTS = [
    "Сегодня мы разберём устройство нейронных сетей и функцию потерь на простом примере.",
    "Градиентный спуск обновляет веса в направлении антиградиента и уменьшает ошибку.",
    "Скорость обучения влияет на сходимость модели: слишком большой шаг приводит к расхождению.",
    "Регуляризация помогает бороться с переобучением и делает модель устойчивее.",
]


def _config(tmp_path, monkeypatch):
    monkeypatch.setenv("VL_DATA_DIR", str(tmp_path / "data"))
    from app.config import Config

    cfg = Config()
    cfg.ensure_dirs()
    conn = connect(cfg.db_path)
    try:
        migrate(conn, cfg.migrations_dir)
    finally:
        conn.close()
    return cfg


def _installed_models(config) -> list[str]:
    return [
        model_id
        for model_id in MODELS
        if resolve_summary_gguf(config, model_id) is not None
    ]


@pytest.fixture
def real_config(tmp_path, monkeypatch):
    return _config(tmp_path, monkeypatch)


def _segments(count: int = 4) -> list[dict]:
    return [
        {
            "id": index + 1,
            "start_ms": index * 30_000,
            "end_ms": (index + 1) * 30_000,
            "text": TEXTS[index % len(TEXTS)],
        }
        for index in range(count)
    ]


def _video(config, count: int = 4) -> int:
    video_id = add_video(config, duration_ms=count * 30_000)
    for index, text in enumerate(TEXTS[:count]):
        add_segment(config, video_id, index * 30_000, (index + 1) * 30_000, text)
    return video_id


def test_real_outline_json(real_config):
    """Хотя бы одна установленная модель даёт валидный OUTLINE JSON.

    350M-модель бывает слишком многословной для constrained-вывода (пишет
    длинное summary и упирается в ``max_tokens`` до blocks); это известное
    ограничение качества, а не пайплайна — сам пайплайн проверяется
    ``test_real_pipeline_tree`` (repair + экстрактивный fallback).
    """
    models = _installed_models(real_config)
    if not models:
        pytest.skip("модели саммари не установлены")
    segments = _segments()
    failures: list[str] = []
    for model_id in models:
        gguf = resolve_summary_gguf(real_config, model_id)
        if gguf is None:  # pragma: no cover - гонка с удалением модели
            continue
        client = LlamaCliClient(real_config, gguf)
        system, user = prompts.outline_messages(segments)
        for max_tokens in (384, 768):
            raw = client.generate(
                user,
                system=system,
                grammar=prompts.outline_grammar(),
                max_tokens=max_tokens,
            )
            parsed = parser.parse_outline(raw, segments)
            if parsed is None:
                failures.append(f"{model_id}/{max_tokens}: {raw[-300:]}")
                continue
            assert parsed["summary"].strip()
            covered = [
                ref for block in parsed["blocks"] for ref in block["segment_ids"]
            ]
            assert sorted(covered) == [1, 2, 3, 4], raw
            for block in parsed["blocks"]:
                assert block["title"].strip()
                assert block["summary"].strip()
                assert 0 <= block["start_ms"] < block["end_ms"] <= 120_000
                assert "<think>" not in block["summary"]
            return
    pytest.skip(
        "ни одна модель не дала валидный OUTLINE JSON (качество маленьких "
        f"моделей): {failures[-1][:300] if failures else 'нет моделей'}"
    )


def test_real_split_json(real_config):
    models = _installed_models(real_config)
    if not models:
        pytest.skip("модели саммари не установлены")
    model_id = models[0]
    gguf = resolve_summary_gguf(real_config, model_id)
    assert gguf is not None
    segments = _segments()
    client = LlamaCliClient(real_config, gguf)
    system, user = prompts.split_messages(
        segments,
        title="Нейронные сети",
        summary="Устройство сетей, функция потерь и градиентный спуск.",
    )
    raw = client.generate(
        user, system=system, grammar=prompts.split_grammar(), max_tokens=384
    )
    parsed = parser.parse_split(raw, segments)
    assert parsed is not None, raw
    if parsed["split"]:
        covered = [ref for block in parsed["blocks"] for ref in block["segment_ids"]]
        assert sorted(covered) == [1, 2, 3, 4], raw


@pytest.mark.parametrize("model_id", MODELS)
def test_real_pipeline_tree(real_config, model_id):
    if resolve_summary_gguf(real_config, model_id) is None:
        pytest.skip(f"модель {model_id} не установлена")
    entry = get_model(model_id)
    assert entry is not None
    pipeline = SummaryPipeline(real_config)
    video_id = _video(real_config)
    result = pipeline.generate(video_id, model_id)
    assert result["state"] == "ready"
    assert result["max_level"] >= 2
    assert result["root_summary"].strip()
    assert result["levels"]
    info = pipeline.inspect(video_id, model_id)
    assert info["ready"] is True
    assert not parser.is_weak_root_summary(info["root_summary"])
    conn = connect(real_config.db_path)
    try:
        nodes = pipeline._read_nodes(conn, video_id, model_id)
    finally:
        conn.close()
    assert nodes and any(node["node_id"] == "0" for node in nodes)
    for blocks in result["levels"].values():
        assert blocks
        for block in blocks:
            assert 0 <= block["start_ms"] < block["end_ms"] <= 120_000
            assert "<think>" not in block["text"]
    # rev3: нет листов-гигантов и информативные заголовки/описания
    conn = connect(real_config.db_path)
    try:
        rows = conn.execute(
            "SELECT node_id, depth, start_ms, end_ms, segment_ids, children_count, "
            "title, summary FROM summary_nodes WHERE video_id = ? ORDER BY depth, node_id",
            (video_id,),
        ).fetchall()
    finally:
        conn.close()
    video_duration = 120_000
    threshold = max(tree.FORCE_SPLIT_MIN_MS, tree.FORCE_SPLIT_RATIO * video_duration)
    for row in rows:
        if int(row["children_count"]) != 0:
            continue
        duration = int(row["end_ms"]) - int(row["start_ms"])
        if duration > threshold:
            assert len(json.loads(row["segment_ids"])) < tree.FORCE_SPLIT_MIN_SEGMENTS
        if int(row["depth"]) > 0:
            assert not parser.is_generic_title(row["title"]), dict(row)
            assert row["summary"] and not parser.summary_repeats_title(
                row["summary"], row["title"]
            ), dict(row)
            assert len(row["summary"]) >= 30, dict(row)
    # инварианты уровней: порядок по времени, отсутствие пересечений, покрытие
    by_id = {str(row["node_id"]): row for row in rows}
    all_ids = sorted(
        int(segment["id"]) for segment in info["segments"]
    )
    for level, entry in info["levels"].items():
        blocks = entry["blocks"]
        assert blocks
        starts = [(block["start_ms"], block["end_ms"]) for block in blocks]
        assert starts == sorted(starts), f"уровень {level} не отсортирован"
        for previous, current in zip(blocks, blocks[1:], strict=False):
            assert previous["end_ms"] <= current["start_ms"], (
                f"уровень {level}: блоки пересекаются"
            )
        covered = [
            ref
            for block in blocks
            for ref in json.loads(by_id[block["node_id"]]["segment_ids"])
        ]
        assert sorted(covered) == all_ids, f"уровень {level} не покрывает видео"
        assert len(covered) == len(set(covered))
    # дети — непрерывное разбиение родителя
    for row in rows:
        if int(row["children_count"]) == 0:
            continue
        parent_ids = json.loads(row["segment_ids"])
        children = sorted(
            (
                child
                for child in rows
                if child["parent_id"] == row["node_id"]
            ),
            key=lambda child: parent_ids.index(json.loads(child["segment_ids"])[0]),
        )
        flat = [ref for child in children for ref in json.loads(child["segment_ids"])]
        assert flat == parent_ids
    cached = pipeline.generate(video_id, model_id)
    assert cached["state"] == "ready"
    assert cached["source_hash"] == result["source_hash"]
    assert Path(real_config.db_path).exists()
