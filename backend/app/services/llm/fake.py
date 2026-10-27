"""M14 rev3: детерминированный fake-LLM для тестов и ``VL_SUMMARY_FAKE=1``.

Поддерживает стадии смыслового дерева:
- ``OUTLINE``/``OUTLINE_CHUNK`` — ``{summary, blocks}``, блоки по 2–3 сегмента
  (не более 8 блоков), полное покрытие по порядку;
- ``SPLIT``/``SPLIT_FORCE`` — ``{split:false}`` для блока из ≤2 сегментов,
  иначе ``{split:true, blocks}``; force-вариант всегда делит блок на ≥2 части;
- ``MERGE`` — ``{summary}`` из саммари фрагментов;
- ``DESCRIBE`` — ``{title, summary}``: нормализованные заголовок/описание без
  общих фраз-переходов (детерминированно).

Делит по тексту (экстрактивно), без модели/сети. Благодаря этому e2e получает
дерево фактической глубины ≥ 2 (корень → темы → подтемы → листья).
"""
from __future__ import annotations

import json
import math
import re
import threading
import time

from . import LLMCancelled

# Дублируем константы дерева, чтобы fake не зависел от summary-пакета
# (иначе получается циклический импорт llm ↔ summary).
MIN_LEAF_SEGMENTS = 2
OUTLINE_MAX_BLOCKS = 8
SPLIT_MAX_BLOCKS = 6

_LINE_RE = re.compile(
    r"^\[(\d+)\]\s+\[(\d{2}):(\d{2})[–-](\d{2}):(\d{2})\]\s*(.+)$",
    re.MULTILINE,
)
_MERGE_LINE_RE = re.compile(r"^Фрагмент\s+(\d+):\s*(.*)$", re.MULTILINE)
_TOPIC_LINE_RE = re.compile(r"^Тема\s+(\d+):\s*(.*)$", re.MULTILINE)
_WORD_RE = re.compile(r"[A-Za-zА-Яа-яЁё0-9]{5,}")
_TITLE_WORD_RE = re.compile(r"[A-Za-zА-Яа-яЁё0-9-]{3,}")
_SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?…])\s+")
_STOPWORDS = {
    "который",
    "которая",
    "которые",
    "которого",
    "почему",
    "поэтому",
    "сегодня",
    "можно",
    "нужно",
    "будет",
    "чтобы",
    "также",
    "более",
    "менее",
    "этого",
    "этому",
    "такой",
    "такие",
    "надо",
    "если",
    "когда",
    "здесь",
    "просто",
    "именно",
    "всегда",
    "вообще",
    "теперь",
    "далее",
    "потом",
}
_TITLE_STOPWORDS = _STOPWORDS | {
    "этот",
    "эта",
    "эти",
    "того",
    "тоже",
    "очень",
    "самый",
    "самом",
    "деле",
    "вот",
    "как",
    "что",
    "для",
    "нас",
    "вас",
    "мне",
    "нам",
    "они",
    "она",
    "оно",
    "так",
    "уже",
    "еще",
    "ещё",
    "или",
    "при",
}
_GENERIC_MARKERS = (
    "переходим",
    "перейдем",
    "перейдём",
    "переходя",
    "перейдя",
    "на мой личный контакт",
    "мой личный контакт",
    "личный контакт",
    "слайд",
    "в этом видео",
    "в видео",
    "далее",
    "следующий",
    "следующая",
    "итак",
    "теперь",
    "продолжаем",
    "начнем",
    "начнём",
    "приступим",
)
_OUTLINE_TEXT_LIMIT = 300
_SPLIT_TEXT_LIMIT = 240
_MERGE_TEXT_LIMIT = 700


def _normalize(text: str) -> str:
    return " ".join(str(text or "").split())


def _cmp(text: str) -> str:
    return _normalize(text).casefold().strip(" .!?…:;,—-«»\"'")


def _starts_generic(text: str) -> bool:
    low = _normalize(text).casefold().lstrip("«\"'( ")
    return any(low.startswith(marker) for marker in _GENERIC_MARKERS)


def _keywords(text: str, limit: int = 5) -> list[str]:
    seen: dict[str, str] = {}
    for word in _WORD_RE.findall(text):
        lowered = word.lower()
        if lowered in _STOPWORDS:
            continue
        seen.setdefault(lowered, word)
    return list(seen.values())[:limit]


def _groups(items: list[dict], size: int) -> list[list[dict]]:
    size = max(1, int(size))
    return [items[index : index + size] for index in range(0, len(items), size)]


def _first_sentences(
    text: str, *, max_chars: int = 600, max_sentences: int = 3
) -> str:
    cleaned = _normalize(text)
    if not cleaned:
        return ""
    result: list[str] = []
    length = 0
    for sentence in _SENTENCE_SPLIT_RE.split(cleaned):
        if len(result) >= max_sentences:
            break
        if result and length + len(sentence) + 1 > max_chars:
            break
        result.append(sentence)
        length += len(sentence) + 1
    text_out = " ".join(result) if result else cleaned
    return text_out[:max_chars].rstrip()


def _title(items: list[dict]) -> str:
    text = " ".join(item["text"] for item in items)
    return _first_sentences(text, max_chars=60, max_sentences=1) or "Блок"


def _derive_title(text: str) -> str:
    cleaned = _normalize(text)
    if not cleaned:
        return "Фрагмент лекции"
    sentences = [item.strip() for item in _SENTENCE_SPLIT_RE.split(cleaned) if item.strip()]
    sentence = ""
    for candidate in sentences:
        if not _starts_generic(candidate) and len(_TITLE_WORD_RE.findall(candidate)) >= 2:
            sentence = candidate
            break
    if not sentence and sentences:
        sentence = sentences[0]
    words = _TITLE_WORD_RE.findall(sentence)
    significant = [word for word in words if word.casefold() not in _TITLE_STOPWORDS]
    if len(significant) < 2:
        significant = words
    title = " ".join(significant[:7]).strip(" ,.;:—-")
    if len(title) > 80:
        title = title[:80].rsplit(" ", 1)[0].strip()
    if not title:
        title = "Фрагмент лекции"
    return (title[:1].upper() + title[1:])[:80]


def _derive_summary(text: str, title: str) -> str:
    cleaned = _normalize(text)
    sentences = [
        item.strip() for item in _SENTENCE_SPLIT_RE.split(cleaned) if item.strip()
    ]
    usable = [item for item in sentences if not _starts_generic(item)]
    if not usable:
        usable = sentences
    title_cmp = _cmp(title)
    filtered = [
        item
        for item in usable
        if not _cmp(item).startswith(title_cmp) and _cmp(item) != title_cmp
    ]
    if filtered:
        usable = filtered
    parts: list[str] = []
    for sentence in usable:
        if _cmp(sentence) == _cmp(title):
            continue
        parts.append(sentence)
        if len(parts) >= 2 and len(" ".join(parts)) >= 80:
            break
    summary = " ".join(parts).strip()
    if not summary:
        return f"В блоке разбирается тема «{title}» и связанные с ней примеры."
    if _cmp(summary) == _cmp(title):
        summary = f"В блоке разбирается тема «{title}» и связанные с ней примеры."
    if len(summary) < 20:
        summary = f"{summary} Разбираются примеры и детали темы."
    return summary[:600]


class FakeLLMClient:
    """Детерминированная заглушка; ``delay`` — для тестов отмены."""

    name = "fake"

    def __init__(self, *, model_id: str = "fake", delay: float = 0.0) -> None:
        self.model_id = model_id
        self.delay = float(delay)
        self.calls: list[str] = []
        self._cancelled = threading.Event()

    def cancel(self) -> None:
        self._cancelled.set()

    def generate(
        self,
        prompt: str,
        *,
        json_schema: dict | None = None,
        grammar: str | None = None,
        system: str | None = None,
        max_tokens: int = 512,
        thinking: bool = False,
    ) -> str:
        del json_schema, grammar, max_tokens
        full_prompt = f"{system}\n\n{prompt}" if system else prompt
        self.calls.append(full_prompt)
        if self.delay > 0:
            deadline = time.monotonic() + self.delay
            while time.monotonic() < deadline:
                if self._cancelled.is_set():
                    raise LLMCancelled
                time.sleep(0.02)
        if self._cancelled.is_set():
            raise LLMCancelled
        body = self._answer(full_prompt)
        if thinking:
            body = f"<think>черновик рассуждения модели</think>{body}"
        return body

    # ---------- ответы ----------

    def _answer(self, prompt: str) -> str:
        if "### DESCRIBE" in prompt:
            return self._describe(self._parse_items(prompt))
        if "### ROOT_OVERVIEW" in prompt:
            return self._root_overview(prompt)
        if "### MERGE" in prompt:
            return self._merge(prompt)
        if "### SPLIT_FORCE" in prompt:
            return self._split(self._parse_items(prompt), force=True)
        if "### SPLIT" in prompt:
            return self._split(self._parse_items(prompt))
        if "### OUTLINE_CHUNK" in prompt or "### OUTLINE" in prompt:
            return self._outline(self._parse_items(prompt))
        return "{}"

    @staticmethod
    def _parse_items(prompt: str) -> list[dict]:
        items = []
        for match in _LINE_RE.finditer(prompt):
            items.append(
                {
                    "id": int(match.group(1)),
                    "start_ms": (int(match.group(2)) * 60 + int(match.group(3))) * 1000,
                    "end_ms": (int(match.group(4)) * 60 + int(match.group(5))) * 1000,
                    "text": match.group(6).strip(),
                }
            )
        return items

    @staticmethod
    def _outline_size(count: int) -> int:
        if count <= OUTLINE_MAX_BLOCKS * 2:
            return 3
        return max(3, math.ceil(count / OUTLINE_MAX_BLOCKS))

    @staticmethod
    def _split_size(count: int) -> int:
        return max(2, math.ceil(count / SPLIT_MAX_BLOCKS))

    @staticmethod
    def _blocks(items: list[list[dict]], limit: int) -> list[dict]:
        blocks = []
        for group in items:
            text = " ".join(item["text"] for item in group)
            blocks.append(
                {
                    "segment_ids": [item["id"] for item in group],
                    "title": _title(group),
                    "summary": text[:limit].strip(),
                }
            )
        return blocks

    def _outline(self, items: list[dict]) -> str:
        if not items:
            return json.dumps({"summary": "", "blocks": []}, ensure_ascii=False)
        groups = _groups(items, self._outline_size(len(items)))
        text = " ".join(item["text"] for item in items)
        payload = {
            "summary": _first_sentences(text, max_chars=600, max_sentences=3),
            "blocks": self._blocks(groups, _OUTLINE_TEXT_LIMIT),
        }
        return json.dumps(payload, ensure_ascii=False)

    def _split(self, items: list[dict], *, force: bool = False) -> str:
        if not force and len(items) <= MIN_LEAF_SEGMENTS:
            return json.dumps({"split": False}, ensure_ascii=False)
        if len(items) < 2:
            return json.dumps({"split": False}, ensure_ascii=False)
        groups = _groups(items, self._split_size(len(items)))
        if force and len(groups) < 2:
            groups = [[item] for item in items[:2]]
            remaining = items[2:]
            if remaining:
                groups[-1].extend(remaining)
        if len(groups) < 2:
            return json.dumps({"split": False}, ensure_ascii=False)
        payload = {"split": True, "blocks": self._blocks(groups, _SPLIT_TEXT_LIMIT)}
        return json.dumps(payload, ensure_ascii=False)

    def _describe(self, items: list[dict]) -> str:
        text = " ".join(item["text"] for item in items)
        title = _derive_title(text)
        detail = _derive_summary(text, title)
        summary = f"О чём: {title[:80]}. Разбираются вопросы и примеры: {detail[:240]}"
        return json.dumps({"title": title, "summary": summary}, ensure_ascii=False)

    @staticmethod
    def _root_overview(prompt: str) -> str:
        titles: list[str] = []
        details: list[str] = []
        for match in _TOPIC_LINE_RE.finditer(prompt):
            body = match.group(2).strip()
            if " — " in body:
                title, summary = body.split(" — ", 1)
            else:
                title, summary = body, ""
            title = title.strip().rstrip(".")
            if title:
                titles.append(title)
            if summary.strip():
                details.append(summary.strip())
        if not titles:
            return json.dumps({"summary": ""}, ensure_ascii=False)
        text = "О чём видео: " + "; ".join(titles[:16]) + ". "
        if details:
            text += (
                "Разбираются вопросы и примеры: "
                + details[0][:240].rstrip(" .")
                + "."
            )
        else:
            text += "Каждая тема раскрывает отдельный вопрос лекции."
        return json.dumps({"summary": text}, ensure_ascii=False)

    @staticmethod
    def _merge(prompt: str) -> str:
        fragments = [
            match.group(2).strip() for match in _MERGE_LINE_RE.finditer(prompt)
        ]
        if not fragments:
            return json.dumps({"summary": ""}, ensure_ascii=False)
        summary = _first_sentences(
            " ".join(fragments), max_chars=_MERGE_TEXT_LIMIT, max_sentences=4
        )
        return json.dumps({"summary": summary}, ensure_ascii=False)


__all__ = ["FakeLLMClient"]
