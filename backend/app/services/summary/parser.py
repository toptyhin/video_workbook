"""M14 rev2: разбор/валидация JSON-ответов модели для смыслового дерева.

Модель возвращает только ссылки на ``segment_ids``; ``start_ms/end_ms``
считаются здесь по реальным сегментам, поэтому «выдуманные» таймкоды
невозможны. Нормализация блоков принудительно обеспечивает порядок, полное
покрытие без пропусков и пересечений. При невалидном ответе pipeline делает
один repair-вызов, затем использует эвристический экстрактивный fallback
(``fallback_outline``/``fallback_split``/``fallback_merge``) — дерево всегда
получается валидным.
"""
from __future__ import annotations

import difflib
import json
import re
from typing import Any

from ..llm import strip_thinking
from . import prompts, tree

MAX_TITLE_CHARS = prompts.MAX_TITLE_CHARS
MAX_SUMMARY_CHARS = prompts.MAX_SUMMARY_CHARS
MAX_KEYWORDS = 8
MIN_SPLIT_BLOCKS = 2

_WORD_RE = re.compile(r"[A-Za-zА-Яа-яЁё0-9]{5,}")
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
_SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?…])\s+")


def _clean(raw: str) -> str:
    text = strip_thinking(raw or "").strip()
    if text.startswith("```"):
        text = re.sub(r"^```[A-Za-z0-9_-]*\s*", "", text)
        text = re.sub(r"\s*```\s*$", "", text)
    return text.strip()


def extract_json(raw: str) -> dict[str, Any] | None:
    """Достаёт первый JSON-объект из ответа (после reasoning/markdown)."""
    text = _clean(raw)
    decoder = json.JSONDecoder()
    for index, char in enumerate(text):
        if char != "{":
            continue
        try:
            value, _ = decoder.raw_decode(text[index:])
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            return value
    return None


def _int_list(value: Any) -> list[int]:
    if not isinstance(value, list):
        return []
    result: list[int] = []
    for item in value:
        if isinstance(item, bool):
            continue
        if isinstance(item, int):
            result.append(item)
        elif isinstance(item, str) and item.strip().lstrip("-").isdigit():
            result.append(int(item.strip()))
    return result


def _clean_text(value: Any) -> str:
    return " ".join(str(value or "").split())


def _keywords(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    result: list[str] = []
    seen: set[str] = set()
    for item in value:
        if not isinstance(item, str):
            continue
        keyword = " ".join(item.split())
        if not keyword:
            continue
        lowered = keyword.lower()
        if lowered in seen:
            continue
        seen.add(lowered)
        result.append(keyword[:80])
        if len(result) >= MAX_KEYWORDS:
            break
    return result


def _known_items(segments: list[dict[str, Any]]) -> dict[int, dict[str, Any]]:
    return {int(item["id"]): item for item in segments}


def _span(
    refs: list[int], known: dict[int, dict[str, Any]]
) -> tuple[int, int]:
    starts = [int(known[ref]["start_ms"]) for ref in refs if ref in known]
    ends = [int(known[ref]["end_ms"]) for ref in refs if ref in known]
    if not starts:
        return 0, 0
    return min(starts), max(ends)


def _segments_text(segments: list[dict[str, Any]]) -> str:
    return " ".join(str(segment.get("text") or "") for segment in segments)


def _title(value: Any, segments: list[dict[str, Any]]) -> str:
    title = _clean_text(value)
    if not title:
        title = first_sentences(_segments_text(segments), max_chars=60, max_sentences=1)
    return title[:MAX_TITLE_CHARS].strip()


def _summary(value: Any, segments: list[dict[str, Any]]) -> str:
    summary = _clean_text(value)
    if not summary:
        summary = first_sentences(_segments_text(segments), max_chars=500, max_sentences=2)
    return summary[:MAX_SUMMARY_CHARS].strip()


def _block(
    refs: list[int],
    title: Any,
    summary: Any,
    known: dict[int, dict[str, Any]],
) -> dict[str, Any]:
    ordered_ids = sorted(refs)
    segment_data = [known[ref] for ref in ordered_ids]
    start_ms, end_ms = _span(ordered_ids, known)
    return {
        "segment_ids": ordered_ids,
        "title": _title(title, segment_data),
        "summary": _summary(summary, segment_data),
        "start_ms": start_ms,
        "end_ms": end_ms,
    }


def normalize_blocks(
    raw_blocks: Any, segments: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """Приводит блоки модели к покрытию всех сегментов без пропусков/пересечений.

    Правила:
    - id, которых нет во входе, отбрасываются;
    - сегмент, уже занятый предыдущим блоком, не попадает в следующий;
    - пустые блоки отбрасываются;
    - «потерянные» сегменты прикрепляются к ближайшему блоку, чтобы покрытие
      было полным; порядок блоков — по порядку сегментов.
    """
    if not isinstance(raw_blocks, list):
        return []
    ordered = tree.ordered_segments(segments)
    known = _known_items(ordered)
    order = [int(segment["id"]) for segment in ordered]
    position = {segment_id: index for index, segment_id in enumerate(order)}
    claimed: set[int] = set()
    blocks: list[dict[str, Any]] = []
    for item in raw_blocks:
        if not isinstance(item, dict):
            continue
        refs = [
            ref
            for ref in _int_list(item.get("segment_ids"))
            if ref in known and ref not in claimed
        ]
        refs = sorted(dict.fromkeys(refs), key=lambda ref: position[ref])
        if not refs:
            continue
        claimed.update(refs)
        blocks.append(_block(refs, item.get("title"), item.get("summary"), known))
    if not blocks:
        if not order:
            return []
        return [_block(order, None, None, known)]
    missing = [segment_id for segment_id in order if segment_id not in claimed]
    for segment_id in missing:
        index = position[segment_id]
        target = blocks[0]
        for block in blocks:
            first = min(position[ref] for ref in block["segment_ids"])
            if first <= index:
                target = block
        if segment_id not in target["segment_ids"]:
            target["segment_ids"].append(segment_id)
    for block in blocks:
        block["segment_ids"] = sorted(
            block["segment_ids"], key=lambda ref: position[ref]
        )
        start_ms, end_ms = _span(block["segment_ids"], known)
        block["start_ms"] = start_ms
        block["end_ms"] = end_ms
    blocks.sort(key=lambda block: position[block["segment_ids"][0]])
    return _repartition_contiguous(blocks, order, known)


def _median(values: list[int]) -> float:
    ordered = sorted(values)
    middle = len(ordered) // 2
    if len(ordered) % 2:
        return float(ordered[middle])
    return (ordered[middle - 1] + ordered[middle]) / 2.0


def _repartition_contiguous(
    blocks: list[dict[str, Any]],
    order: list[int],
    known: dict[int, dict[str, Any]],
) -> list[dict[str, Any]]:
    """Жёсткий инвариант: блоки — непрерывные диапазоны сегментов родителя.

    Модель может вернуть блоки вразнобой/с «дырами» между id. Поэтому границы
    блоков определяем по медианам позиций их id (устойчиво к выбросам), а затем
    заново нарезаем порядок родителя на непрерывные отрезки: полное покрытие,
    без пересечений, в порядке документа. Заголовок/описание модели сохраняются
    за соответствующим диапазоном.
    """
    total = len(order)
    if not blocks or total == 0:
        return []
    position = {segment_id: index for index, segment_id in enumerate(order)}
    prepared = []
    for block in blocks:
        refs = [ref for ref in block.get("segment_ids") or [] if ref in position]
        if not refs:
            continue
        prepared.append(
            {
                "block": block,
                "center": _median([position[ref] for ref in refs]),
            }
        )
    if not prepared:
        return []
    prepared.sort(key=lambda item: item["center"])
    count = len(prepared)
    if count > total:
        prepared = prepared[:total]
        count = len(prepared)
    if count == 1:
        return [_repack(prepared[0]["block"], order, known)]
    ends: list[int] = []
    centers = [item["center"] for item in prepared]
    # центры должны строго возрастать, иначе оставляем один сегмент на блок
    for index in range(1, count):
        if centers[index] <= centers[index - 1]:
            centers[index] = centers[index - 1] + 1
    for index in range(count - 1):
        raw_end = int((centers[index] + centers[index + 1]) / 2)
        min_end = (ends[-1] + 1) if ends else 0
        max_end = total - (count - 1 - index) - 1
        end = max(min_end, min(raw_end, max_end))
        ends.append(end)
    ends.append(total - 1)
    result: list[dict[str, Any]] = []
    start = 0
    for index, end in enumerate(ends):
        segment_ids = order[start : end + 1]
        start = end + 1
        if not segment_ids:
            continue
        result.append(_repack(prepared[index]["block"], segment_ids, known))
    return result


def _repack(
    block: dict[str, Any],
    segment_ids: list[int],
    known: dict[int, dict[str, Any]],
) -> dict[str, Any]:
    return _block(segment_ids, block.get("title"), block.get("summary"), known)


def parse_outline(
    raw: str,
    segments: list[dict[str, Any]],
    *,
    allow_single: bool = False,
) -> dict[str, Any] | None:
    """Валидирует OUTLINE-ответ: ``{summary, blocks}``."""
    payload = extract_json(raw)
    if payload is None:
        return None
    blocks = normalize_blocks(payload.get("blocks"), segments)
    if not blocks:
        return None
    if not allow_single and len(blocks) < 2 and len(segments) > tree.MIN_LEAF_SEGMENTS:
        return None
    summary = _clean_text(payload.get("summary"))[:MAX_SUMMARY_CHARS]
    if not summary:
        summary = first_sentences(
            _segments_text(segments), max_chars=800, max_sentences=3
        )
    return {"summary": summary, "blocks": blocks}


def parse_split(
    raw: str, segments: list[dict[str, Any]]
) -> dict[str, Any] | None:
    """Валидирует SPLIT-ответ: ``{split:false}`` либо ``{split:true, blocks}``."""
    payload = extract_json(raw)
    if payload is None:
        return None
    if "split" not in payload:
        return None
    split = payload.get("split")
    if split is False or split == "false":
        return {"split": False}
    if split is not True and split != "true":
        return None
    blocks = normalize_blocks(payload.get("blocks"), segments)
    if len(blocks) < MIN_SPLIT_BLOCKS:
        # Модель сказала «делить», но подблоков нет — блок атомарен.
        return {"split": False}
    return {"split": True, "blocks": blocks}


def parse_merge(raw: str) -> dict[str, Any] | None:
    payload = extract_json(raw)
    if payload is None:
        return None
    summary = _clean_text(payload.get("summary"))[:MAX_SUMMARY_CHARS]
    if not summary:
        return None
    return {"summary": summary}


# ---------- rev3: качество описаний (title/summary) ----------

GENERIC_TITLE_MARKERS = (
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
    "фрагмент",
    "очерк",
    "блок лекции",
    "какие вопросы и шаги",
    "вопросы и шаги",
    "очерк",
)
_TITLE_WORD_RE = re.compile(r"[A-Za-zА-Яа-яЁё0-9-]{3,}")
_FILLER_WORDS = {
    "это",
    "деле",
    "самом",
    "вот",
    "как",
    "что",
    "очень",
    "просто",
    "когда",
    "бывает",
    "типа",
    "именно",
    "вообще",
    "такой",
    "такие",
    "здесь",
    "далее",
    "теперь",
    "соответственно",
}
_BAD_TITLE_STARTS = ("а ", "и ", "но ", "или ", "то ", "вот ", "ну ", "так ")
_PREPOSITION_STARTS = (
    "в ",
    "во ",
    "на ",
    "по ",
    "для ",
    "из ",
    "от ",
    "до ",
    "у ",
    "о ",
    "об ",
    "при ",
    "за ",
    "под ",
    "над ",
    "без ",
    "к ",
    "ко ",
    "с ",
    "со ",
)
_BAD_TITLE_PREFIXES = (
    "о чём",
    "о чем",
    "о том",
    "фрагмент",
    "очерк",
    "слайд",
    "блок",
    "тема:",
    "часть ",
    "видео",
    "история",
)
_TITLE_STOPWORDS = _STOPWORDS | {
    "этот",
    "эта",
    "эти",
    "того",
    "тоже",
    "очень",
    "самый",
    "самом",
    "просто",
    "типа",
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
    "это",
    "деле",
    "бывает",
    "когда",
}


def _norm_text(value: Any) -> str:
    return " ".join(str(value or "").split())


def _cmp_text(value: Any) -> str:
    return _norm_text(value).casefold().strip(" .!?…:;,—-«»\"'")


_GENERIC_SUMMARY_STARTS = (
    "многие вопросы и примеры",
    "особые вопросы и примеры",
    "вопросы и примеры из лекции",
    "о том, что",
    "данный фрагмент",
    "в этом фрагменте",
    "в данном фрагменте",
    "фрагмент посвящён",
)


def _starts_generic_summary(text: str) -> bool:
    low = _norm_text(text).casefold().lstrip("«\"'( ")
    return any(low.startswith(marker) for marker in _GENERIC_SUMMARY_STARTS)


def _starts_generic(text: str) -> bool:
    low = _norm_text(text).casefold().lstrip("«\"'( ")
    return any(low.startswith(marker) for marker in GENERIC_TITLE_MARKERS)


def first_sentence(text: str) -> str:
    cleaned = _norm_text(text)
    if not cleaned:
        return ""
    sentences = _SENTENCE_SPLIT_RE.split(cleaned)
    return sentences[0].strip() if sentences else ""


def is_generic_title(title: Any) -> bool:
    """Слабый/общий заголовок: фраза-переход, канцелярит, первые слова, одно слово."""
    text = _norm_text(title)
    if not text:
        return True
    if len(text) > 90:
        return True  # длинная фраза вместо конкретной темы
    low = text.casefold().lstrip("«\"'( ")
    if any(low.startswith(marker) for marker in GENERIC_TITLE_MARKERS):
        return True
    if low in {
        "блок",
        "тема",
        "фрагмент",
        "саммари",
        "часть",
        "видео",
        "фрагмент лекции",
        "фрагмент видео",
        "блок лекции",
    }:
        return True
    if low.startswith(_BAD_TITLE_PREFIXES):
        return True
    if re.match(r"^(а|и|но|или|то|вот|ну|так)[,\s]", low):
        return True
    if low.startswith(_PREPOSITION_STARTS):
        return True
    words = _TITLE_WORD_RE.findall(text)
    if len(words) < 2:
        return True
    first_word = words[0].casefold()
    if first_word.endswith(("ться", "тся")) or first_word in _INFINITIVE_VERBS:
        return True  # заголовок начинается с глагола-инфинитива
    significant = [
        word
        for word in words
        if word.casefold() not in _TITLE_STOPWORDS
        and word.casefold() not in _FILLER_WORDS
    ]
    if len(significant) < 2:
        return True
    fillers = sum(1 for word in words if word.casefold() in _FILLER_WORDS)
    if fillers >= 2:
        return True
    generic_nouns = {
        "фрагмент",
        "очерк",
        "слайд",
        "блок",
        "тема",
        "часть",
        "видео",
        "саммари",
        "номер",
    }
    if len(words) <= 6 and any(
        word.casefold() in generic_nouns for word in words
    ):
        return True
    return False


def summary_repeats_title(summary: Any, title: Any) -> bool:
    summary_cmp = _cmp_text(summary)
    title_cmp = _cmp_text(title)
    if not summary_cmp or not title_cmp:
        return False
    return (
        summary_cmp == title_cmp
        or summary_cmp.startswith(title_cmp)
        or title_cmp.startswith(summary_cmp)
    )


def is_raw_text_copy(summary: Any, text: Any) -> bool:
    """Описание — просто склейка строк транскрибации, а не осмысленное саммари."""
    summary_cmp = _cmp_text(summary)
    text_cmp = _cmp_text(text)
    if not summary_cmp or not text_cmp:
        return False
    if summary_cmp == text_cmp:
        return True
    if len(text_cmp) > len(summary_cmp) and len(summary_cmp) >= 0.85 * len(text_cmp):
        return True
    return False


def is_first_phrase_copy(summary: Any, text: Any) -> bool:
    """Описание является просто копией первой фразы текста."""
    summary_cmp = _cmp_text(summary)
    text_cmp = _cmp_text(text)
    if not summary_cmp or not text_cmp:
        return False
    first_cmp = _cmp_text(first_sentence(text_cmp))
    limit = len(first_cmp) + 20
    if summary_cmp == first_cmp:
        return True
    if text_cmp.startswith(summary_cmp) and len(summary_cmp) <= limit:
        return True
    return (
        summary_cmp.startswith(text_cmp[:30])
        and len(text_cmp) > 60
        and len(summary_cmp) <= limit
    )


def title_is_text_prefix(title: Any, text: Any) -> bool:
    """Заголовок — буквальный (в т.ч. обрезанный) кусок первой фразы текста."""
    title_cmp = _cmp_text(title)
    text_cmp = _cmp_text(text)
    if not title_cmp or not text_cmp:
        return False
    sentences = [
        sentence for sentence in _SENTENCE_SPLIT_RE.split(_norm_text(text)) if sentence
    ]
    first_cmp = _cmp_text(sentences[0]) if sentences else ""
    if first_cmp and title_cmp == first_cmp:
        # Заголовок, равный целой первой фразе, называет её тему — допустим.
        return False
    if first_cmp and first_cmp.startswith(title_cmp):
        return len(title_cmp) >= 12
    return text_cmp.startswith(title_cmp)


def needs_description(
    title: Any, summary: Any, text: Any, *, is_root: bool = False
) -> bool:
    """Нужен ли DESCRIBE-пасс для узла (rev3)."""
    summary_text = _norm_text(summary)
    if not summary_text or len(summary_text) < tree.WEAK_SUMMARY_MIN_CHARS:
        return True
    if summary_text.casefold().startswith("саммари блока"):
        return True
    if _starts_generic_summary(summary_text):
        return True
    if is_raw_text_copy(summary_text, text):
        return True
    if is_first_phrase_copy(summary_text, text):
        return True
    if is_root:
        return is_weak_root_summary(summary_text)
    if not title or is_generic_title(title):
        return True
    if title_is_text_prefix(title, text):
        return True
    return summary_repeats_title(summary_text, title)


def is_weak_root_summary(summary: Any) -> bool:
    """Слабое верхнеуровневое саммари: общие переходы/«в видео»/сырой текст."""
    text = _norm_text(summary)
    if not text or len(text) < tree.WEAK_SUMMARY_MIN_CHARS:
        return True
    if _starts_generic(text):
        return True
    return text.casefold().startswith(
        ("в этом видео", "в данном видео", "в видео", "видео о", "это видео")
    )


_TITLE_LEADING_FILLERS = _TITLE_STOPWORDS | _FILLER_WORDS | {
    "соответственно",
    "следовательно",
    "например",
    "значит",
    "поэтому",
    "вот",
    "ну",
    "а",
    "и",
    "но",
    "или",
    "то",
    "так",
    "также",
    "если",
    "номер",
    "фрагмент",
    "блок",
    "тема",
}


def _title_from_sentence(sentence: str) -> str:
    words = _TITLE_WORD_RE.findall(sentence)
    significant = [
        word for word in words if word.casefold() not in _TITLE_STOPWORDS
    ]
    if len(significant) < 2:
        significant = words
    while significant and significant[0].casefold() in _TITLE_LEADING_FILLERS:
        significant = significant[1:]
    if not significant:
        return ""
    title = " ".join(significant[:6]).strip(" ,.;:—-")
    if len(title) > 80:
        title = title[:80].rsplit(" ", 1)[0].strip()
    return title


_DISCOURSE_STARTS = (
    "а ",
    "и ",
    "но ",
    "или ",
    "то ",
    "то есть",
    "вот ",
    "ну ",
    "так ",
    "далее ",
    "теперь ",
    "потом ",
    "кстати ",
    "соответственно ",
    "например ",
    "значит ",
    "поэтому ",
    "следовательно ",
    "просто ",
    "именно ",
    "вообще ",
)
_INFINITIVE_VERBS = {
    "помогать",
    "написать",
    "внедрять",
    "разбирать",
    "разобрать",
    "инвестировать",
    "продавать",
    "строить",
    "давать",
    "понять",
    "понимать",
    "получать",
    "говорить",
    "делать",
    "показывать",
    "приглашать",
    "увеличивать",
    "работать",
    "использовать",
    "усилить",
    "развиваться",
    "иметь",
}
_LINK_VERBS = {
    "быть",
    "был",
    "была",
    "было",
    "были",
    "есть",
    "будет",
    "может",
    "можно",
    "нужно",
    "надо",
    "важно",
    "является",
    "являются",
    "происходит",
    "происходят",
    "разбираются",
    "разбирается",
    "рассматриваются",
    "рассматривается",
    "показано",
    "говорится",
    "рассказывается",
    "понимаем",
    "понимает",
    "делаем",
    "делает",
    "строим",
    "даем",
    "даёт",
    "дать",
    "идет",
    "идёт",
    "идут",
    "берем",
    "берём",
    "хотите",
    "хочу",
    "хотим",
}


def normalize_sentence(sentence: Any) -> str:
    """Нормализует предложение для описания: убирает дискурсивные зачины."""
    text = _norm_text(sentence)
    if not text:
        return ""
    low = text.casefold()
    changed = True
    while changed:
        changed = False
        for marker in _DISCOURSE_STARTS:
            if low.startswith(marker):
                text = text[len(marker) :].lstrip(" ,;:—-")
                low = text.casefold()
                changed = True
                break
    text = text.strip(" ,;:—-")
    if not text:
        return ""
    text = text[:1].upper() + text[1:]
    if text[-1] not in ".!?…":
        text = text.rstrip(" ,;:—-") + "."
    return text


def theme_from_description(summary: Any, *, limit: int = 5) -> str:
    """Короткая тема (3–6 значимых слов) из описания, без глаголов-связок."""
    text = _norm_text(summary)
    if not text:
        return ""
    words = _TITLE_WORD_RE.findall(text)
    significant = [
        word
        for word in words
        if word.casefold() not in _TITLE_STOPWORDS
        and word.casefold() not in _LINK_VERBS
        and word.casefold() not in _FILLER_WORDS
    ]
    if len(significant) < 2:
        return ""
    title = " ".join(significant[:limit]).strip(" ,.;:—-")
    if len(title) > 80:
        title = title[:80].rsplit(" ", 1)[0].strip()
    title = title[:1].upper() + title[1:]
    if is_generic_title(title):
        return ""
    return title


def _clean_sentences(text: str) -> list[str]:
    sentences = [
        sentence.strip() for sentence in _SENTENCE_SPLIT_RE.split(_norm_text(text))
    ]
    return [normalize_sentence(sentence) for sentence in sentences if sentence.strip()]


def derive_title(text: str) -> str:
    """Fallback-заголовок: конкретная тема из самой содержательной фразы.

    Не «первые слова» и не «Фрагмент лекции»: выбираем фразу с максимумом
    значимых слов, затем проверяем на общие формулировки/копию первой фразы.
    """
    cleaned = _norm_text(text)
    if not cleaned:
        return "Смысловой блок"
    sentences = [sentence.strip() for sentence in _SENTENCE_SPLIT_RE.split(cleaned)]
    sentences = [sentence for sentence in sentences if sentence]
    ranked = sorted(
        sentences,
        key=lambda sentence: (
            not _starts_generic(sentence),
            len(
                [
                    word
                    for word in _TITLE_WORD_RE.findall(sentence)
                    if word.casefold() not in _TITLE_STOPWORDS
                ]
            ),
            -sentences.index(sentence),
        ),
        reverse=True,
    )
    for sentence in ranked:
        title = _title_from_sentence(sentence)
        if not title:
            continue
        if is_generic_title(title) or is_first_phrase_copy(title, cleaned):
            continue
        return title[:1].upper() + title[1:]
    keywords = [
        word
        for word in extract_keywords(cleaned, limit=10)
        if word.casefold() not in _TITLE_STOPWORDS
        and word.casefold() not in _TITLE_LEADING_FILLERS
        and not any(
            word.casefold().startswith(marker) for marker in GENERIC_TITLE_MARKERS
        )
    ]
    if keywords:
        title = " ".join(keywords[:5])
        if len(title) > 80:
            title = title[:80].rsplit(" ", 1)[0].strip()
        return title[:1].upper() + title[1:]
    return "Смысловой блок"


def text_similarity(first: Any, second: Any) -> float:
    """Похожесть двух нормализованных строк (0..1)."""
    left = _cmp_text(first)
    right = _cmp_text(second)
    if not left or not right:
        return 0.0
    return difflib.SequenceMatcher(None, left, right).ratio()


def is_near_duplicate(
    first: Any, second: Any, *, threshold: float = 0.85
) -> bool:
    """Почти копия: вложенность или высокая похожесть строк."""
    left = _cmp_text(first)
    right = _cmp_text(second)
    if not left or not right:
        return False
    if left in right or right in left:
        return True
    return text_similarity(left, right) >= threshold


def _significant_words(text: str) -> list[str]:
    words = _TITLE_WORD_RE.findall(_norm_text(text))
    return [
        word
        for word in words
        if word.casefold() not in _TITLE_STOPWORDS
        and word.casefold() not in _FILLER_WORDS
        and word.casefold() not in _LINK_VERBS
        and word.casefold() not in _INFINITIVE_VERBS
    ]


def unique_theme_title(
    summary: Any,
    own_text: str,
    sibling_titles: list[str],
    sibling_texts: list[str] | None = None,
) -> str:
    """Короткая тема из описания, уникальная среди сиблингов."""
    taken = {title.casefold().strip() for title in sibling_titles if title}
    base = theme_from_description(summary)
    if not base or is_generic_title(base):
        base = derive_title(own_text)
    base = _norm_text(base)[: prompts.MAX_TITLE_CHARS].strip(" ,.;:—-")
    if not base:
        base = "Смысловой блок"
    if base.casefold() in taken:
        sibling_words = {
            word.casefold()
            for text in (sibling_texts or [])
            for word in _significant_words(text)
        }
        own_words = [
            word
            for word in _significant_words(own_text)
            if word.casefold() not in sibling_words
            and word.casefold() not in base.casefold()
        ]
        for word in own_words:
            candidate = f"{base} {word}"
            if candidate.casefold() not in taken:
                base = candidate[: prompts.MAX_TITLE_CHARS]
                break
    if base.casefold() in taken:
        index = 0
        while f"{base} {index + 1}".casefold() in taken:
            index += 1
        base = f"{base} {index + 1}"
    return base[: prompts.MAX_TITLE_CHARS]


def description_from_text(text: str, *, title: str | None = None) -> str:
    """Fallback-описание: 1–2 нормализованных предложения из текста блока.

    Без префиксов «О чём:»/«Разбираются:» и без списков ключевых слов: только
    содержательные предложения текста, очищенные от дискурсивных зачинов.
    """
    cleaned = _norm_text(text)
    if not cleaned:
        return ""
    sentences = _clean_sentences(cleaned)
    if not sentences:
        return ""
    title_cmp = _cmp_text(title) if title else ""
    content = [sentence for sentence in sentences if not _starts_generic(sentence)]
    candidates = content or sentences
    chosen: list[str] = []
    for sentence in candidates:
        if title_cmp and _cmp_text(sentence) == title_cmp:
            continue
        if len(sentence) < 12:
            continue
        chosen.append(sentence)
        if len(chosen) >= 2 and len(" ".join(chosen)) >= 100:
            break
    if not chosen:
        chosen = candidates[:1]
    summary = " ".join(chosen)
    if len(summary) > prompts.MAX_SUMMARY_CHARS:
        summary = summary[: prompts.MAX_SUMMARY_CHARS].rstrip()
    return summary


def fallback_describe(text: str, *, current_title: str | None = None) -> dict[str, str]:
    """Детерминированное описание, если DESCRIBE не удался.

    title — короткая тема из описания (не копия первой фразы текста),
    summary — 1–2 нормализованных предложения текста без префиксов.
    """
    cleaned = _norm_text(text)
    summary = description_from_text(cleaned, title=None)
    if not summary:
        summary = cleaned[: prompts.MAX_SUMMARY_CHARS]
    title = ""
    if (
        current_title
        and not is_generic_title(current_title)
        and not title_is_text_prefix(current_title, cleaned)
        and not is_first_phrase_copy(current_title, cleaned)
    ):
        title = _norm_text(current_title)[: prompts.MAX_TITLE_CHARS]
    if not title:
        title = theme_from_description(summary)
    if not title:
        title = derive_title(cleaned)
    if is_generic_title(title):
        title = theme_from_description(summary) or "Смысловой блок"
    return {"title": title, "summary": summary}


# ---------- экстрактивный fallback ----------


def first_sentences(
    text: str, *, max_chars: int = 800, max_sentences: int = 4
) -> str:
    cleaned = " ".join(str(text or "").split())
    if not cleaned:
        return ""
    sentences = _SENTENCE_SPLIT_RE.split(cleaned)
    result: list[str] = []
    length = 0
    for sentence in sentences:
        if len(result) >= max_sentences:
            break
        if result and length + len(sentence) + 1 > max_chars:
            break
        result.append(sentence)
        length += len(sentence) + 1
    text = " ".join(result) if result else cleaned
    if len(text) > max_chars:
        text = text[:max_chars].rstrip()
    return text


def extract_keywords(text: str, limit: int = 5) -> list[str]:
    seen: dict[str, str] = {}
    for word in _WORD_RE.findall(text or ""):
        lowered = word.lower()
        if lowered in _STOPWORDS:
            continue
        seen.setdefault(lowered, word)
    return list(seen.values())[: max(0, limit)]


def _split_groups(
    segments: list[dict[str, Any]], groups: int
) -> list[list[dict[str, Any]]]:
    """Делит сегменты на ``groups`` непрерывных групп максимально ровно."""
    ordered = tree.ordered_segments(segments)
    if not ordered:
        return []
    count = max(1, min(groups, len(ordered)))
    base, extra = divmod(len(ordered), count)
    result: list[list[dict[str, Any]]] = []
    index = 0
    for group_index in range(count):
        size = base + (1 if group_index < extra else 0)
        result.append(ordered[index : index + size])
        index += size
    return result


def fallback_outline(
    segments: list[dict[str, Any]], *, allow_single: bool = False
) -> dict[str, Any]:
    """Эвристика, если модель дважды не дала валидный OUTLINE."""
    ordered = tree.ordered_segments(segments)
    if not ordered:
        return {"summary": "", "blocks": []}
    if allow_single or len(ordered) <= tree.MIN_LEAF_SEGMENTS:
        groups = [ordered]
    else:
        count = min(
            tree.OUTLINE_MAX_BLOCKS,
            max(2, (len(ordered) + 2) // 3),
        )
        groups = _split_groups(ordered, count)
    known = _known_items(ordered)
    blocks = [
        _block([int(segment["id"]) for segment in group], None, None, known)
        for group in groups
    ]
    summary = first_sentences(_segments_text(ordered), max_chars=800, max_sentences=3)
    return {"summary": summary, "blocks": blocks}


def fallback_split(segments: list[dict[str, Any]]) -> dict[str, Any]:
    """Эвристическое деление пополам, если SPLIT дважды невалиден."""
    ordered = tree.ordered_segments(segments)
    if len(ordered) <= tree.MIN_LEAF_SEGMENTS:
        return {"split": False}
    mid = len(ordered) // 2
    known = _known_items(ordered)
    groups = [ordered[:mid], ordered[mid:]]
    blocks = [
        _block([int(segment["id"]) for segment in group], None, None, known)
        for group in groups
    ]
    return {"split": True, "blocks": blocks}


def fallback_merge(summaries: list[str]) -> dict[str, Any]:
    text = " ".join(str(summary or "") for summary in summaries)
    return {
        "summary": first_sentences(text, max_chars=800, max_sentences=3)
        or text[:MAX_SUMMARY_CHARS]
    }


def parse_describe(raw: str) -> dict[str, Any] | None:
    """Валидирует DESCRIBE-ответ: ``{title, summary}`` без общих формулировок."""
    payload = extract_json(raw)
    if payload is None:
        return None
    title = _clean_text(payload.get("title"))[:MAX_TITLE_CHARS]
    summary = _clean_text(payload.get("summary"))[:MAX_SUMMARY_CHARS]
    if not title or not summary:
        return None
    if len(summary) < tree.WEAK_SUMMARY_MIN_CHARS:
        return None
    if is_generic_title(title):
        return None
    if summary_repeats_title(summary, title):
        return None
    if _starts_generic_summary(summary):
        return None
    return {"title": title, "summary": summary}


def _clean_topic_title(title: Any, summary: Any) -> str:
    """Заголовок темы для root: конкретный title или содержательное предложение."""
    candidate = _norm_text(title).strip(" .,:;—-")
    if candidate and not is_generic_title(candidate) and not title_is_text_prefix(
        candidate, _norm_text(summary)
    ):
        return candidate[: prompts.MAX_TITLE_CHARS]
    derived = theme_from_description(summary)
    if derived and not is_generic_title(derived):
        return derived
    for sentence in _clean_sentences(str(summary or "")):
        if _starts_generic(sentence) or len(sentence) < 12:
            continue
        words = sentence.split()
        short = " ".join(words[:8]).strip(" .,:;—-")
        if short and not is_generic_title(short):
            return short[: prompts.MAX_TITLE_CHARS]
    return ""


def compose_root_summary(topics: list[dict[str, Any]]) -> str:
    """Детерминированное чистое саммари видео из тем верхнего уровня.

    «О чём видео: <вступление>. Темы: <t1>; <t2>; …» — максимум 8 тем,
    без дублей и обрывков; плохой title заменяется содержательным предложением.
    """
    titles: list[str] = []
    seen: set[str] = set()
    intro = ""
    for topic in topics:
        summary = str(topic.get("summary") or "")
        title = _clean_topic_title(topic.get("title"), summary)
        if title:
            key = title.casefold()
            if key not in seen:
                seen.add(key)
                titles.append(title)
        if not intro:
            for sentence in _clean_sentences(summary):
                if (
                    len(sentence) >= tree.WEAK_SUMMARY_MIN_CHARS
                    and not _starts_generic(sentence)
                    and not is_weak_root_summary(sentence)
                ):
                    intro = sentence
                    break
    if not intro:
        intro = "видео разбирает несколько логических тем"
    intro = intro.rstrip(" .")
    theme_text = "; ".join(titles[:8])
    if not theme_text:
        return f"О чём видео: {intro}."
    return f"О чём видео: {intro}. Темы: {theme_text}."


def fallback_root_overview(topics: list[dict[str, Any]]) -> str:
    """Совместимость: то же детерминированное саммари из тем."""
    return compose_root_summary(topics)


def leaf_summary(segments: list[dict[str, Any]]) -> str:
    """Summary листа без LLM: первые предложения его сегментов."""
    return first_sentences(
        _segments_text(segments), max_chars=600, max_sentences=3
    )


__all__ = [
    "GENERIC_TITLE_MARKERS",
    "MAX_KEYWORDS",
    "MAX_SUMMARY_CHARS",
    "MAX_TITLE_CHARS",
    "MIN_SPLIT_BLOCKS",
    "compose_root_summary",
    "derive_title",
    "description_from_text",
    "extract_json",
    "extract_keywords",
    "fallback_describe",
    "fallback_root_overview",
    "is_first_phrase_copy",
    "is_near_duplicate",
    "is_generic_title",
    "title_is_text_prefix",
    "is_raw_text_copy",
    "is_weak_root_summary",
    "needs_description",
    "parse_describe",
    "summary_repeats_title",
    "text_similarity",
    "theme_from_description",
    "unique_theme_title",
    "fallback_merge",
    "fallback_outline",
    "fallback_split",
    "first_sentences",
    "leaf_summary",
    "normalize_blocks",
    "normalize_sentence",
    "parse_merge",
    "parse_outline",
    "parse_split",
]
