"""Безопасный разбор пользовательского поискового запроса (A8, M4)."""
from __future__ import annotations

import re
from dataclasses import dataclass, field

MAX_QUERY_LENGTH = 256
MAX_TOKENS = 32

_TOKEN_RE = re.compile(
    r'(?P<tag>tag:"[^"]*"|tag:\S+)'
    r'|(?P<file>file:"[^"]*"|file:\S+)'
    r'|(?P<quoted>"[^"]*")'
    r'|(?P<op>\bAND\b|\bOR\b|\bNOT\b)'
    r'|(?P<term>[^\s]+)'
)
_UNSAFE = re.compile(r'["\x00-\x1f]')


class QueryError(ValueError):
    def __init__(self, code: str, detail: str) -> None:
        super().__init__(detail)
        self.code = code
        self.detail = detail


@dataclass
class ParsedQuery:
    raw: str
    fts: str | None
    tags: list[str] = field(default_factory=list)
    file: str | None = None
    terms: list[str] = field(default_factory=list)

    def echo(self) -> dict:
        return {
            "raw": self.raw,
            "fts": self.fts,
            "prefixes": {"tags": list(self.tags), "file": self.file},
        }


def _unquote(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value.startswith('"') and value.endswith('"'):
        return value[1:-1].strip()
    return value


def _escape_term(term: str) -> str:
    cleaned = _UNSAFE.sub(" ", term).strip()
    cleaned = cleaned.replace("*", " ").strip()
    return cleaned


def parse_query(raw: str | None) -> ParsedQuery:
    text = (raw or "").strip()
    if len(text) > MAX_QUERY_LENGTH:
        raise QueryError("query_too_long", f"Запрос длиннее {MAX_QUERY_LENGTH} символов")
    tags: list[str] = []
    file: str | None = None
    terms: list[str] = []
    parts: list[str] = []
    position = 0
    token_count = 0
    while position < len(text):
        while position < len(text) and text[position].isspace():
            position += 1
        if position >= len(text):
            break
        match = _TOKEN_RE.match(text, position)
        if match is None:  # pragma: no cover - регэксп покрывает всё
            position += 1
            continue
        position = match.end()
        token_count += 1
        if token_count > MAX_TOKENS:
            raise QueryError("query_too_long", f"Слишком много слов (>{MAX_TOKENS})")
        if match.group("tag"):
            value = _unquote(match.group("tag")[4:])
            if value:
                tags.append(value)
        elif match.group("file"):
            value = _unquote(match.group("file")[5:])
            if value:
                file = value
        elif match.group("quoted"):
            phrase = _escape_term(_unquote(match.group("quoted")))
            if phrase:
                terms.append(phrase)
                parts.append('"' + phrase.replace('"', " ") + '"')
        elif match.group("op"):
            operator = match.group("op")
            if parts and parts[-1] not in {"AND", "OR", "NOT"}:
                parts.append(operator)
        else:
            term = _escape_term(match.group("term"))
            if term:
                terms.append(term)
                parts.append('"' + term + '"')
    while parts and parts[-1] in {"AND", "OR", "NOT"}:
        parts.pop()
    fts = " ".join(parts) if parts else None
    if fts:
        fts = fts.replace(" NOT NOT ", " NOT ")
    return ParsedQuery(raw=text, fts=fts, tags=tags, file=file, terms=terms)
