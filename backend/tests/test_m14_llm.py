"""M14 rev2: llama-cli (subprocess) и детерминированный fake-LLM дерева."""
from __future__ import annotations

import json
import threading
import time

import pytest

from app.services.llm import (
    FakeLLMClient,
    LlamaCliClient,
    LLMCancelled,
    LLMError,
    LLMTimeout,
    is_repetitive,
    repetition_ratio,
    strip_thinking,
)
from app.services.summary import parser, prompts

MODEL_LFM = "summary-lfm2.5-350m"


def _segments(count: int = 3) -> list[dict]:
    texts = [
        "Сегодня мы разберём устройство нейронных сетей и функцию потерь.",
        "Градиентный спуск обновляет веса в направлении антиградиента.",
        "Скорость обучения влияет на сходимость модели.",
        "Регуляризация помогает бороться с переобучением сети.",
        "Батч-нормализация стабилизирует обучение модели.",
        "Функции активации добавляют нелинейность в сеть.",
    ]
    return [
        {
            "id": index + 1,
            "start_ms": index * 30_000,
            "end_ms": (index + 1) * 30_000,
            "text": texts[index % len(texts)],
        }
        for index in range(count)
    ]


# ---------- thinking / повтор ----------


def test_strip_thinking_variants():
    assert strip_thinking("<think>x</think>ответ") == "ответ"
    assert strip_thinking("<THINK>a\nb</THINK>  ответ ") == "ответ"
    assert strip_thinking("</think>ответ") == "ответ"
    assert strip_thinking("до<think>незакрытый") == "до"
    assert strip_thinking("") == ""


def test_repetition_heuristic():
    normal = " ".join(f"слово{index}" for index in range(30))
    repeated = " ".join(["слово1 слово2 слово3 слово4 слово5"] * 10)
    assert not is_repetitive(normal)
    assert is_repetitive(repeated)
    assert repetition_ratio(repeated) > 0.3


# ---------- fake: OUTLINE/SPLIT/MERGE ----------


def test_fake_outline_deterministic_and_covers_all():
    segments = _segments(6)
    system, user = prompts.outline_messages(segments)
    first = FakeLLMClient().generate(
        user, system=system, grammar=prompts.outline_grammar()
    )
    second = FakeLLMClient().generate(user, system=system)
    assert first == second
    payload = json.loads(first)
    assert payload["summary"]
    assert len(payload["blocks"]) >= 2
    parsed = parser.parse_outline(first, segments)
    assert parsed is not None
    covered = [ref for block in parsed["blocks"] for ref in block["segment_ids"]]
    assert covered == [1, 2, 3, 4, 5, 6]
    assert len(covered) == len(set(covered))
    for block in parsed["blocks"]:
        assert 0 < len(block["title"]) <= 120
        assert block["summary"]


def test_fake_outline_chunked_marks_fragment():
    segments = _segments(2)
    system, user = prompts.outline_messages(segments, chunked=True)
    assert "### OUTLINE_CHUNK" in system
    payload = json.loads(FakeLLMClient().generate(user, system=system))
    assert payload["blocks"]
    assert payload["blocks"][0]["segment_ids"] == [1, 2]


def test_fake_split_false_for_small_block():
    segments = _segments(2)
    system, user = prompts.split_messages(segments, title="Тема", summary="Саммари")
    payload = json.loads(FakeLLMClient().generate(user, system=system))
    assert payload == {"split": False}
    assert parser.parse_split(json.dumps(payload), segments) == {"split": False}


def test_fake_split_recurses_for_larger_block():
    segments = _segments(3)
    system, user = prompts.split_messages(segments, title="Тема", summary="Саммари")
    raw = FakeLLMClient().generate(
        user, system=system, grammar=prompts.split_grammar()
    )
    payload = json.loads(raw)
    assert payload["split"] is True
    assert len(payload["blocks"]) == 2
    parsed = parser.parse_split(raw, segments)
    assert parsed is not None and parsed["split"] is True
    covered = [ref for block in parsed["blocks"] for ref in block["segment_ids"]]
    assert covered == [1, 2, 3]


def test_fake_merge_uses_fragment_summaries():
    summaries = ["Первая часть про нейросети.", "Вторая часть про обучение."]
    system, user = prompts.merge_messages(summaries)
    raw = FakeLLMClient().generate(user, system=system, grammar=prompts.merge_grammar())
    parsed = parser.parse_merge(raw)
    assert parsed is not None
    assert "Первая часть" in parsed["summary"]
    assert "Вторая часть" in parsed["summary"]


def test_fake_thinking_stripped_by_parser():
    segments = _segments(2)
    system, user = prompts.outline_messages(segments)
    raw = FakeLLMClient().generate(user, system=system, thinking=True)
    assert raw.startswith("<think>")
    parsed = parser.parse_outline(raw, segments)
    assert parsed is not None
    assert "рассужд" not in json.dumps(parsed, ensure_ascii=False)


# ---------- llama-cli subprocess ----------


def _make_script(tmp_path, body: str):
    script = tmp_path / "fake-llama-cli"
    script.write_text("#!/usr/bin/env python3\n" + body, encoding="utf-8")
    script.chmod(0o755)
    return script


def _script_body(args_file, output: str, *, grammar_copy=None, fail_on_grammar=False) -> str:
    lines = [
        "import json, sys, time",
        "args = sys.argv[1:]",
        f"open({str(args_file)!r}, 'a', encoding='utf-8').write("
        "json.dumps(args, ensure_ascii=False) + '\\n')",
    ]
    if fail_on_grammar:
        lines.extend(
            [
                "if '--grammar-file' in args:",
                "    sys.stderr.write('Error: Failed to initialize samplers\\n')",
                "    sys.exit(1)",
            ]
        )
    if grammar_copy is not None:
        lines.extend(
            [
                "if '--grammar-file' in args:",
                "    path = args[args.index('--grammar-file') + 1]",
                f"    open({str(grammar_copy)!r}, 'w', encoding='utf-8').write("
                "open(path, encoding='utf-8').read())",
            ]
        )
    lines.append(f"print({output!r})")
    return "\n".join(lines) + "\n"


def test_llama_cli_builds_expected_command(config, tmp_path):
    args_file = tmp_path / "args.jsonl"
    grammar_copy = tmp_path / "grammar.gbnf"
    script = _make_script(
        tmp_path,
        _script_body(
            args_file,
            '{"summary": "Обзор.", "blocks": []}',
            grammar_copy=grammar_copy,
        ),
    )
    config.llama_cli = script
    client = LlamaCliClient(config, tmp_path / "model.gguf", threads=2)
    (tmp_path / "model.gguf").write_bytes(b"fake")
    content = client.generate(
        "данные сегментов",
        system="системная инструкция",
        grammar=prompts.outline_grammar(),
        max_tokens=128,
    )
    assert json.loads(content) == {"summary": "Обзор.", "blocks": []}
    recorded = [json.loads(line) for line in args_file.read_text().splitlines()]
    assert len(recorded) == 1
    args = recorded[0]
    assert "--jinja" in args
    assert args[args.index("-c") + 1] == "4096"
    assert args[args.index("-t") + 1] == "2"
    assert args[args.index("-n") + 1] == "128"
    assert args[args.index("--temp") + 1] == "0.20"
    assert args[args.index("-rea") + 1] == "off"
    assert "-st" in args
    assert args[args.index("-sys") + 1] == "системная инструкция"
    assert args[args.index("-p") + 1] == "данные сегментов"
    assert "--json-schema" not in args
    assert "--grammar-file" in args
    assert "root ::=" in grammar_copy.read_text(encoding="utf-8")


def test_llama_cli_strips_thinking(config, tmp_path):
    args_file = tmp_path / "args.jsonl"
    script = _make_script(
        tmp_path,
        _script_body(
            args_file, '<think>секрет</think>{"summary": "Обзор.", "blocks": []}'
        ),
    )
    config.llama_cli = script
    client = LlamaCliClient(config, tmp_path / "model.gguf")
    (tmp_path / "model.gguf").write_bytes(b"fake")
    content = client.generate("prompt")
    assert content == '{"summary": "Обзор.", "blocks": []}'
    assert "секрет" not in content


def test_llama_cli_timeout_and_kill(config, tmp_path):
    script = _make_script(
        tmp_path,
        "import time\ntime.sleep(5)\nprint('late')\n",
    )
    config.llama_cli = script
    client = LlamaCliClient(config, tmp_path / "model.gguf", timeout=0.3)
    (tmp_path / "model.gguf").write_bytes(b"fake")
    started = time.monotonic()
    with pytest.raises(LLMTimeout):
        client.generate("prompt")
    assert time.monotonic() - started < 4


def test_llama_cli_cancel_kills_process(config, tmp_path):
    script = _make_script(
        tmp_path,
        "import time\ntime.sleep(10)\nprint('late')\n",
    )
    config.llama_cli = script
    client = LlamaCliClient(config, tmp_path / "model.gguf", timeout=30)
    (tmp_path / "model.gguf").write_bytes(b"fake")
    errors: list[BaseException] = []

    def run() -> None:
        try:
            client.generate("prompt")
        except BaseException as exc:  # noqa: BLE001 - тест фиксирует тип
            errors.append(exc)

    worker = threading.Thread(target=run)
    worker.start()
    time.sleep(0.3)
    client.cancel()
    worker.join(timeout=5)
    assert not worker.is_alive()
    assert errors and isinstance(errors[0], LLMCancelled)


def test_llama_cli_grammar_fallback(config, tmp_path):
    args_file = tmp_path / "args.jsonl"
    script = _make_script(
        tmp_path,
        _script_body(
            args_file,
            '{"summary": "Обзор.", "blocks": []}',
            fail_on_grammar=True,
        ),
    )
    config.llama_cli = script
    client = LlamaCliClient(config, tmp_path / "model.gguf")
    (tmp_path / "model.gguf").write_bytes(b"fake")
    content = client.generate("prompt", grammar=prompts.outline_grammar())
    assert json.loads(content) == {"summary": "Обзор.", "blocks": []}
    recorded = [json.loads(line) for line in args_file.read_text().splitlines()]
    assert len(recorded) == 2
    assert "--grammar-file" in recorded[0]
    assert "--grammar-file" not in recorded[1]


def test_llama_cli_missing_binary(config, tmp_path):
    config.llama_cli = tmp_path / "missing-llama-cli"
    client = LlamaCliClient(config, tmp_path / "model.gguf")
    (tmp_path / "model.gguf").write_bytes(b"fake")
    with pytest.raises(LLMError) as exc_info:
        client.generate("prompt")
    assert exc_info.value.code == "llama_cli_missing"


def test_llama_cli_missing_model_file(config, tmp_path):
    script = _make_script(tmp_path, "print('unused')\n")
    config.llama_cli = script
    client = LlamaCliClient(config, tmp_path / "no-model.gguf")
    with pytest.raises(LLMError) as exc_info:
        client.generate("prompt")
    assert exc_info.value.code == "model_missing"


def test_make_client_uses_fake_env(config, monkeypatch):
    monkeypatch.setenv("VL_SUMMARY_FAKE", "1")
    from app.services.llm import make_client

    client = make_client(config, None, model_id=MODEL_LFM)
    assert isinstance(client, FakeLLMClient)
    assert client.model_id == MODEL_LFM


def test_fake_split_force_always_divides():
    segments = _segments(8)
    system, user = prompts.split_messages(
        segments, title="Большая тема", summary="О чём блок", force=True
    )
    assert "### SPLIT_FORCE" in system
    raw = FakeLLMClient().generate(
        user, system=system, grammar=prompts.split_grammar(force=True)
    )
    payload = json.loads(raw)
    assert payload["split"] is True
    assert len(payload["blocks"]) >= 2
    parsed = parser.parse_split(raw, segments)
    assert parsed is not None and parsed["split"] is True
    covered = [ref for block in parsed["blocks"] for ref in block["segment_ids"]]
    assert covered == [1, 2, 3, 4, 5, 6, 7, 8]


def test_fake_split_force_two_segments():
    segments = _segments(2)
    system, user = prompts.split_messages(segments, force=True)
    payload = json.loads(FakeLLMClient().generate(user, system=system))
    assert payload["split"] is True
    assert len(payload["blocks"]) == 2


def test_fake_describe_deterministic_and_informative():
    segments = _segments(3)
    segments[0]["text"] = "Переходим с вами к самому главному продаже."
    system, user = prompts.describe_messages(
        segments,
        current_title="Переходим к самому главному",
        current_summary="Переходим к самому главному продаже.",
    )
    assert "### DESCRIBE" in system
    first = FakeLLMClient().generate(
        user, system=system, grammar=prompts.describe_grammar()
    )
    second = FakeLLMClient().generate(user, system=system)
    assert first == second
    payload = json.loads(first)
    assert payload["title"] and payload["summary"]
    assert not parser.is_generic_title(payload["title"])
    assert not parser.summary_repeats_title(payload["summary"], payload["title"])
    parsed = parser.parse_describe(first)
    assert parsed is not None
    assert not parser.is_generic_title(parsed["title"])


def test_fake_root_overview_enumerates_topics():
    topics = [
        {"title": "Продажа как деньги в кассе", "summary": "Определение продажи."},
        {"title": "Работа с потребностями", "summary": "Выявление потребностей клиента."},
    ]
    system, user = prompts.root_overview_messages(topics)
    assert "### ROOT_OVERVIEW" in system
    raw = FakeLLMClient().generate(user, system=system, grammar=prompts.merge_grammar())
    payload = json.loads(raw)
    assert "О чём видео" in payload["summary"]
    assert "Продажа как деньги в кассе" in payload["summary"]
    assert "Работа с потребностями" in payload["summary"]
    assert parser.parse_merge(raw) is not None
    assert not parser.is_weak_root_summary(payload["summary"])


def test_fake_describe_uses_template_and_context():
    segments = _segments(3)
    segments[0]["text"] = "Переходим с вами к самому главному продаже."
    system, user = prompts.describe_messages(
        segments,
        current_title="Переходим к главному",
        current_summary="Переходим к главному продаже.",
        context=["родительский блок «Продажи»"],
    )
    raw = FakeLLMClient().generate(user, system=system, grammar=prompts.describe_grammar())
    payload = json.loads(raw)
    assert payload["summary"].startswith("О чём:")
    assert "Разбираются вопросы и примеры:" in payload["summary"]
    parsed = parser.parse_describe(raw)
    assert parsed is not None
    assert not parser.is_generic_title(parsed["title"])
    assert not parser.summary_repeats_title(parsed["summary"], parsed["title"])
