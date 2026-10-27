"""M14 rev3: промпты смыслового дерева, JSON-схемы и GBNF-грамматики.

Модель никогда не вводит таймкоды: она ссылается только на ``segment_ids``
из входа, а диапазоны ``start_ms/end_ms`` вычисляет ``parser.py``. Версия
промптов входит в ключ кэша — менять при изменении текстов/схем/грамматик.

Инструкция передаётся отдельным system-сообщением (``-sys``), данные — user-
сообщением (``-p``): маленькие модели не копируют примеры/заглушки из
инструкции. Никаких few-shot примеров с вымышленным содержимым: только
описание требуемой структуры.

rev3: усилены требования к границам блоков (подвопросы/подсмыслы), к
информативности title/summary и добавлен DESCRIBE-промпт для переписывания
слабых/общих заголовков и описаний.
"""
from __future__ import annotations

from typing import Any

PROMPT_VERSION = 3
MAX_TITLE_CHARS = 120
MAX_SUMMARY_CHARS = 1200

# ---------- JSON-схемы (fake/валидатор; --json-schema в pinned b11669 падает) ----------

BLOCK_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "segment_ids": {"type": "array", "items": {"type": "integer"}},
        "title": {"type": "string"},
        "summary": {"type": "string"},
    },
    "required": ["segment_ids", "title", "summary"],
    "additionalProperties": False,
}

OUTLINE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "summary": {"type": "string"},
        "blocks": {"type": "array", "items": BLOCK_SCHEMA},
    },
    "required": ["summary", "blocks"],
    "additionalProperties": False,
}

SPLIT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "split": {"type": "boolean"},
        "blocks": {"type": "array", "items": BLOCK_SCHEMA},
    },
    "required": ["split"],
    "additionalProperties": False,
}

MERGE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {"summary": {"type": "string"}},
    "required": ["summary"],
    "additionalProperties": False,
}

DESCRIBE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "title": {"type": "string"},
        "summary": {"type": "string"},
    },
    "required": ["title", "summary"],
    "additionalProperties": False,
}

# GBNF: ограничение вывода на реальных моделях (--grammar-file). Язык GBNF не
# умеет опциональные объекты «blocks только при split=true» иначе как через
# альтернативы — это и описано ниже.
_JSON_STRING = (
    'string ::= "\\"" ([^"\\\\] | "\\\\" ("\\"" | "\\\\" | "/" | "b" | "f" | "n" '
    '| "r" | "t"))* "\\""'
)
_JSON_COMMON = f"""ints ::= "[" ws (int (ws "," ws int)*)? ws "]"
int ::= [0-9]+
{_JSON_STRING}
ws ::= [ \\t\\n\\r]*
"""

_OUTLINE_GRAMMAR = f"""root ::= "{{" ws "\\"summary\\"" ws ":" ws string ws "," ws "\\"blocks\\"" ws ":" ws blocks ws "}}"
blocks ::= "[" ws (block (ws "," ws block)*)? ws "]"
block ::= "{{" ws "\\"segment_ids\\"" ws ":" ws ints ws "," ws "\\"title\\"" ws ":" ws string ws "," ws "\\"summary\\"" ws ":" ws string ws "}}"
{_JSON_COMMON}"""

_SPLIT_GRAMMAR = f"""root ::= "{{" ws "\\"split\\"" ws ":" ws ("false" | "true" ws "," ws "\\"blocks\\"" ws ":" ws blocks) ws "}}"
blocks ::= "[" ws (block (ws "," ws block)*)? ws "]"
block ::= "{{" ws "\\"segment_ids\\"" ws ":" ws ints ws "," ws "\\"title\\"" ws ":" ws string ws "," ws "\\"summary\\"" ws ":" ws string ws "}}"
{_JSON_COMMON}"""

_MERGE_GRAMMAR = f"""root ::= "{{" ws "\\"summary\\"" ws ":" ws string ws "}}"
{_JSON_COMMON}"""

_DESCRIBE_GRAMMAR = f"""root ::= "{{" ws "\\"title\\"" ws ":" ws string ws "," ws "\\"summary\\"" ws ":" ws string ws "}}"
{_JSON_COMMON}"""


def outline_schema() -> dict[str, Any]:
    return OUTLINE_SCHEMA


def split_schema() -> dict[str, Any]:
    return SPLIT_SCHEMA


def merge_schema() -> dict[str, Any]:
    return MERGE_SCHEMA


def describe_schema() -> dict[str, Any]:
    return DESCRIBE_SCHEMA


def outline_grammar(*, chunked: bool = False) -> str:
    """Одна и та же структура для OUTLINE всего текста и OUTLINE_CHUNK."""
    del chunked
    return _OUTLINE_GRAMMAR


def split_grammar(*, force: bool = False) -> str:
    del force
    return _SPLIT_GRAMMAR


def merge_grammar() -> str:
    return _MERGE_GRAMMAR


def describe_grammar() -> str:
    return _DESCRIBE_GRAMMAR


# ---------- форматирование данных ----------


def format_timestamp(ms: int) -> str:
    total_seconds = max(0, int(ms)) // 1000
    minutes, seconds = divmod(total_seconds, 60)
    return f"{minutes:02d}:{seconds:02d}"


def format_range(start_ms: int, end_ms: int) -> str:
    return f"{format_timestamp(start_ms)}–{format_timestamp(end_ms)}"


def format_duration(ms: int) -> str:
    total_seconds = max(0, int(ms)) // 1000
    hours, remainder = divmod(total_seconds, 3600)
    minutes, seconds = divmod(remainder, 60)
    if hours:
        return f"{hours} ч {minutes:02d} мин {seconds:02d} с"
    return f"{minutes} мин {seconds:02d} с"


def _thinking_hint(thinking: bool) -> str:
    if thinking:
        return (
            "Можешь сначала подумать в тегах <think>...</think>, но в ответе должен "
            "остаться только итоговый JSON."
        )
    return "Отвечай сразу, без рассуждений и без тегов <think>."


def format_segments(segments: list[dict[str, Any]]) -> str:
    """Строки транскрибации в формате ``[id] [mm:ss–mm:ss] текст``."""
    lines = []
    for segment in segments:
        lines.append(
            f"[{int(segment['id'])}] "
            f"[{format_range(segment['start_ms'], segment['end_ms'])}] "
            f"{str(segment.get('text') or '').strip()}"
        )
    return "\n".join(lines)


# ---------- общие требования к title/summary (rev3) ----------

_TITLE_RULES = (
    "title — конкретная тема или вопрос блока из 3–8 слов. Заголовок не должен "
    "быть общей фразой-переходом («переходим к», «далее», «следующий слайд», "
    "«на мой личный контакт») и не должен быть просто первой фразой текста.\n"
    "summary — 1–2 предложения: о чём блок и какие вопросы, примеры или шаги в "
    "нём разбираются. Не повторяй title и не копируй первую фразу текста.\n"
)

_BOUNDARY_RULES = (
    "Нельзя объединять разные вопросы, аспекты, примеры или шаги в один блок: "
    "один блок — одна законченная тема/вопрос.\n"
)


# ---------- OUTLINE всего текста ----------


def outline_system(*, chunked: bool = False, thinking: bool = False) -> str:
    if chunked:
        return (
            "### OUTLINE_CHUNK\n"
            "Ты — редактор конспекта русской лекции. На вход дан ФРАГМЕНТ "
            "транскрибации в формате [id] [mm:ss–mm:ss] текст; фрагмент — часть "
            "более длинной лекции, остальные части ты не видишь.\n"
            "Проанализируй фрагмент и раздели его на 1–6 смысловых блоков по "
            "порядку: каждый блок — законченная мысль лектора.\n"
            f"{_BOUNDARY_RULES}{_TITLE_RULES}"
            "Ответ — строго JSON-объект: summary — строка, о чём этот фрагмент "
            "(1–2 предложения, без общих слов); blocks — массив объектов с полями "
            "segment_ids (массив чисел: id строк из входа), title (строка) и "
            "summary (строка).\n"
            "Все segment_ids фрагмента должны войти ровно в один блок, по порядку, "
            "без пропусков и пересечений. Используй только реальные id из "
            "квадратных скобок входа. Не выдумывай id, таймкоды и факты, не "
            "добавляй знания извне. Пиши по-русски, без заглушек.\n"
            f"{_thinking_hint(thinking)}"
        )
    return (
        "### OUTLINE\n"
        "Ты — редактор конспекта русской лекции. На вход дана вся транскрибация "
        "видео в формате [id] [mm:ss–mm:ss] текст и её длительность.\n"
        "Сначала пойми, о чём лекция в целом, какие вопросы она разбирает. Затем "
        "раздели весь текст на логические смысловые блоки по порядку: границы "
        "блоков — там, где лектор переходит к новому вопросу/аспекту/примеру, а "
        "не через равные промежутки. Для лекции длиннее 2 минут выделяй "
        "достаточно блоков (ориентир — 30–120 секунд на блок; если тем несколько, "
        "4–8 и больше блоков).\n"
        f"{_BOUNDARY_RULES}{_TITLE_RULES}"
        "Ответ — строго JSON-объект: summary — строка, верхнеуровневое саммари "
        "всего видео (2–4 предложения: о чём оно и какие главные вопросы/темы); "
        "blocks — массив объектов с полями segment_ids (массив чисел: id строк из "
        "входа), title (строка) и summary (строка).\n"
        "Все segment_ids входа должны войти ровно в один блок, по порядку, без "
        "пропусков и пересечений. Используй только реальные id из квадратных "
        "скобок входа. Не выдумывай id, таймкоды и факты, не добавляй знания "
        "извне. Пиши по-русски, без заглушек.\n"
        f"{_thinking_hint(thinking)}"
    )


def outline_user(
    segments: list[dict[str, Any]],
    *,
    duration_ms: int | None = None,
    blocks_hint: int | None = None,
) -> str:
    header: list[str] = []
    if duration_ms is not None:
        header.append(f"Длительность видео: {format_duration(duration_ms)}")
    if blocks_hint is not None and blocks_hint > 0:
        header.append(
            f"Строк транскрибации: {len(segments)}. Ориентир: {blocks_hint} "
            "смысловых блоков примерно по 30–120 секунд."
        )
    body = format_segments(segments)
    if not header:
        return body
    return f"{chr(10).join(header)}\n\n{body}"


def outline_messages(
    segments: list[dict[str, Any]],
    *,
    chunked: bool = False,
    thinking: bool = False,
    duration_ms: int | None = None,
    blocks_hint: int | None = None,
) -> tuple[str, str]:
    return (
        outline_system(chunked=chunked, thinking=thinking),
        outline_user(segments, duration_ms=duration_ms, blocks_hint=blocks_hint),
    )


# ---------- MERGE саммари чанков ----------


def merge_system(*, thinking: bool = False) -> str:
    return (
        "### MERGE\n"
        "Ты — редактор конспекта русской лекции. На вход даны саммари "
        "последовательных фрагментов одной лекции (Фрагмент N: текст).\n"
        "Составь верхнеуровневое саммари всей лекции: 2–4 предложения о том, "
        "о чём она и какие главные вопросы/темы раскрывает, сохраняя порядок и "
        "логику. Избегай общих фраз вроде «в этом видео» — называй конкретные "
        "темы.\n"
        "Ответ — строго JSON-объект: summary — строка по-русски.\n"
        "Не добавляй факты, которых нет во фрагментах, не выдумывай термины и "
        "не пересказывай каждый фрагмент по отдельности. Пиши по-русски, без "
        "заглушек.\n"
        f"{_thinking_hint(thinking)}"
    )


def merge_user(summaries: list[str]) -> str:
    lines = []
    for index, summary in enumerate(summaries, start=1):
        text = " ".join(str(summary or "").split())
        lines.append(f"Фрагмент {index}: {text}")
    return "\n".join(lines)


def merge_messages(
    summaries: list[str], *, thinking: bool = False
) -> tuple[str, str]:
    return merge_system(thinking=thinking), merge_user(summaries)


# ---------- SPLIT блока ----------


def split_system(*, force: bool = False, thinking: bool = False) -> str:
    header = "### SPLIT_FORCE\n" if force else "### SPLIT\n"
    force_rules = (
        "ЭТОТ БЛОК ГАРАНТИРОВАННО СОДЕРЖИТ НЕСКОЛЬКО ПОДТЕМ: он слишком "
        "большой. Перечисли мысленно самостоятельные подвопросы/примеры/шаги "
        "внутри него и раздели блок на 2–6 подблоков по ним. Ответ split=false "
        "недопустим, если внутри можно выделить хотя бы два разных вопроса или "
        "примера.\n"
        if force
        else ""
    )
    return (
        f"{header}"
        "Ты — редактор конспекта русской лекции. На вход дан один смысловой блок "
        "лекции: его заголовок, саммари и строки транскрибации в формате "
        "[id] [mm:ss–mm:ss] текст (строки могут быть обрывками фраз — собери "
        "смысл по порядку).\n"
        "Найди ВНУТРИ блока подвопросы, подсмыслы, аспекты, отдельные примеры и "
        "шаги. Если внутри больше одного самостоятельного вопроса, примера или "
        "шага — блок нужно делить (split=true). Нельзя возвращать split=false "
        "только потому, что блок посвящён одной большой теме: большая тема почти "
        "всегда распадается на подвопросы.\n"
        f"{force_rules}"
        "Дели ТОЛЬКО по смыслу: граница — смена мысли, вопроса, примера или шага "
        "объяснения. Нельзя делить по времени, по количеству строк или на равные "
        "куски. Если блок действительно атомарен (одна мысль без подвопросов), "
        "верни split=false.\n"
        f"{_TITLE_RULES}"
        "Ответ — строго JSON-объект: если делить не нужно — split со значением "
        "false; если нужно — split со значением true и blocks — массив объектов "
        "с полями segment_ids (массив чисел: id строк из входа), title (строка) и "
        "summary (строка).\n"
        "Все segment_ids блока должны войти ровно в один подблок, по порядку, без "
        "пропусков и пересечений. Используй только реальные id из квадратных "
        "скобок входа. Не выдумывай id, таймкоды и факты. Пиши по-русски, без "
        "заглушек.\n"
        f"{_thinking_hint(thinking)}"
    )


def split_user(
    segments: list[dict[str, Any]],
    *,
    title: str | None = None,
    summary: str | None = None,
) -> str:
    header = []
    if title:
        header.append(f"Блок: {' '.join(str(title).split())}")
    if summary:
        header.append(f"Саммари блока: {' '.join(str(summary).split())}")
    body = format_segments(segments)
    if not header:
        return body
    return f"{chr(10).join(header)}\n\n{body}"


def split_messages(
    segments: list[dict[str, Any]],
    *,
    title: str | None = None,
    summary: str | None = None,
    force: bool = False,
    thinking: bool = False,
) -> tuple[str, str]:
    return split_system(force=force, thinking=thinking), split_user(
        segments, title=title, summary=summary
    )


# ---------- DESCRIBE: информативные title/summary для слабых узлов ----------


def describe_system(*, thinking: bool = False) -> str:
    return (
        "### DESCRIBE\n"
        "Ты — редактор конспекта русской лекции. На вход дан фрагмент "
        "транскрибации (строки в формате [id] [mm:ss–mm:ss] текст; строки могут "
        "быть обрывками фраз — собери смысл по порядку), текущие заголовок и "
        "описание, которые нужно улучшить, и, возможно, контекст: родительский "
        "блок и соседние темы.\n"
        "Придумай СВОИ информативные заголовок и описание именно этого "
        "фрагмента с учётом контекста. Не копируй дословно строки транскрибации, "
        "заголовки соседних тем и формулировки из контекста.\n"
        "title — конкретная тема или вопрос из 3–8 слов, называющий суть блока. "
        "Запрещены: общие фразы-переходы («переходим к», «далее», «следующий», "
        "«в этом видео», «на мой личный контакт»), канцелярит и слова-заглушки "
        "(«фрагмент», «очерк», «слайд», «блок», «тема», «часть»), копирование "
        "первой фразы текста и заголовки из одних вводных слов.\n"
        "summary — строго по шаблону: «О чём: <о чём блок, 1 предложение>; "
        "разбираются вопросы/примеры: <какие именно вопросы, понятия, примеры "
        "или шаги разбираются>». 1–2 предложения, конкретные понятия из текста. "
        "Не повторяй title, не копируй строки транскрибации и не пиши общих "
        "формулировок.\n"
        "Ответ — строго JSON-объект: title (строка) и summary (строка).\n"
        "Не добавляй факты, которых нет во фрагменте, не выдумывай id и таймкоды. "
        "Пиши по-русски, без заглушек.\n"
        f"{_thinking_hint(thinking)}"
    )


def describe_user(
    segments: list[dict[str, Any]],
    *,
    current_title: str | None = None,
    current_summary: str | None = None,
    context: list[str] | None = None,
) -> str:
    del current_title, current_summary  # их модель склонна просто копировать
    header: list[str] = []
    if context:
        header.extend(
            f"Контекст: {' '.join(str(item).split())}" for item in context
        )
    body = format_segments(segments)
    if not header:
        return body
    return f"{chr(10).join(header)}\n\n{body}"


def describe_messages(
    segments: list[dict[str, Any]],
    *,
    current_title: str | None = None,
    current_summary: str | None = None,
    context: list[str] | None = None,
    thinking: bool = False,
) -> tuple[str, str]:
    return describe_system(thinking=thinking), describe_user(
        segments,
        current_title=current_title,
        current_summary=current_summary,
        context=context,
    )


# ---------- ROOT_OVERVIEW: саммари всего видео по темам верхних уровней ----------


def root_overview_system(*, thinking: bool = False) -> str:
    return (
        "### ROOT_OVERVIEW\n"
        "Ты — редактор конспекта русской лекции. На вход даны темы видео по "
        "порядку (Тема N: заголовок — описание), а не сырая транскрибация.\n"
        "Составь верхнеуровневое саммари всего видео: 2–4 предложения о том, "
        "о чём видео и какие вопросы/темы в нём раскрыты. Перечисли все темы по "
        "порядку (можно кратко), не пропускай темы и не добавляй новых фактов.\n"
        "Запрещены общие переходы и заглушки: «переходим», «в этом видео», "
        "«далее», «слайд», «фрагмент», «очерк». Не начинай саммари с общих слов "
        "и не копируй заголовок первой темы.\n"
        "Ответ — строго JSON-объект: summary — строка по-русски.\n"
        "Пиши по-русски, без заглушек, не выдумывай факты.\n"
        f"{_thinking_hint(thinking)}"
    )


def root_overview_user(topics: list[dict[str, Any]]) -> str:
    lines = []
    for index, topic in enumerate(topics, start=1):
        title = " ".join(str(topic.get("title") or "").split())
        summary = " ".join(str(topic.get("summary") or "").split())
        if title and summary:
            lines.append(f"Тема {index}: {title} — {summary}")
        elif title:
            lines.append(f"Тема {index}: {title}")
        elif summary:
            lines.append(f"Тема {index}: {summary}")
    return "\n".join(lines)


def root_overview_messages(
    topics: list[dict[str, Any]], *, thinking: bool = False
) -> tuple[str, str]:
    return root_overview_system(thinking=thinking), root_overview_user(topics)


# ---------- REPAIR ----------


def repair_user(original_user: str) -> str:
    return (
        "Предыдущий ответ не был валидным JSON нужной структуры. Верни только "
        "корректный JSON-объект для тех же данных, без markdown и пояснений.\n\n"
        f"{original_user}"
    )


__all__ = [
    "BLOCK_SCHEMA",
    "DESCRIBE_SCHEMA",
    "MAX_SUMMARY_CHARS",
    "MAX_TITLE_CHARS",
    "MERGE_SCHEMA",
    "OUTLINE_SCHEMA",
    "PROMPT_VERSION",
    "SPLIT_SCHEMA",
    "describe_grammar",
    "describe_messages",
    "describe_schema",
    "describe_system",
    "describe_user",
    "format_duration",
    "format_range",
    "format_segments",
    "format_timestamp",
    "merge_grammar",
    "merge_messages",
    "merge_schema",
    "merge_system",
    "merge_user",
    "outline_grammar",
    "outline_messages",
    "outline_schema",
    "outline_system",
    "outline_user",
    "repair_user",
    "root_overview_messages",
    "root_overview_system",
    "root_overview_user",
    "split_grammar",
    "split_messages",
    "split_schema",
    "split_system",
    "split_user",
]
