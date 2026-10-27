"""M14: локальные LLM-клиенты для саммари (llama.cpp subprocess / fake).

Публичный интерфейс клиента::

    generate(prompt, *, json_schema=None, max_tokens=512, thinking=False) -> str
    cancel() -> None

Реализации: ``llama_cli.LlamaCliClient`` (spawn llama-cli) и
``fake.FakeLLMClient`` (детерминированный, ``VL_SUMMARY_FAKE=1``).
"""
from __future__ import annotations

import os
import re
from typing import Protocol

_THINK_PAIR_RE = re.compile(r"<think\b[^>]*>.*?</think\s*>", re.IGNORECASE | re.DOTALL)
_THINK_OPEN_RE = re.compile(r"<think\b[^>]*>.*$", re.IGNORECASE | re.DOTALL)
_THINK_CLOSE_RE = re.compile(r"</think\s*>", re.IGNORECASE)
_TOKEN_RE = re.compile(r"[\w']+", re.UNICODE)


class LLMError(RuntimeError):
    """Ошибка инференса; ``code`` уходит в ``summary_jobs.error_code``."""

    def __init__(self, code: str, detail: str) -> None:
        super().__init__(detail)
        self.code = code
        self.detail = detail


class LLMTimeout(LLMError):
    def __init__(self, detail: str = "Модель не ответила вовремя") -> None:
        super().__init__("summary_timeout", detail)


class LLMCancelled(LLMError):
    def __init__(self, detail: str = "Генерация отменена") -> None:
        super().__init__("cancelled", detail)


class LLMClient(Protocol):
    name: str

    def generate(
        self,
        prompt: str,
        *,
        json_schema: dict | None = None,
        max_tokens: int = 512,
        thinking: bool = False,
    ) -> str: ...

    def cancel(self) -> None: ...


def strip_thinking(text: str) -> str:
    """Убирает reasoning модели (``<think>...</think>``) из ответа.

    Reasoning не сохраняется и не показывается (D-14.5): если тег не закрыт,
    всё после него считается рассуждением и отбрасывается.
    """
    if not text:
        return ""
    cleaned = _THINK_PAIR_RE.sub("", text)
    closes = list(_THINK_CLOSE_RE.finditer(cleaned))
    if closes:
        cleaned = cleaned[closes[-1].end() :]
    cleaned = _THINK_OPEN_RE.sub("", cleaned)
    return cleaned.strip()


def repetition_ratio(text: str, n: int = 5) -> float:
    """Доля повторяющихся n-грамм (0..1) — эвристика петель генерации."""
    tokens = [token.lower() for token in _TOKEN_RE.findall(text or "")]
    if len(tokens) < n:
        return 0.0
    grams = [tuple(tokens[index : index + n]) for index in range(len(tokens) - n + 1)]
    if not grams:
        return 0.0
    return 1.0 - (len(set(grams)) / len(grams))


def is_repetitive(text: str, *, n: int = 5, threshold: float = 0.30, min_tokens: int = 20) -> bool:
    tokens = _TOKEN_RE.findall(text or "")
    if len(tokens) < max(min_tokens, n):
        return False
    return repetition_ratio(text, n) > threshold


def make_client(config, model_path, *, model_id: str | None = None) -> LLMClient:
    """Клиент по модели; fake включается окружением ``VL_SUMMARY_FAKE=1``."""
    if os.environ.get("VL_SUMMARY_FAKE") == "1":
        from .fake import FakeLLMClient

        return FakeLLMClient(model_id=model_id or "fake")
    from .llama_cli import LlamaCliClient

    return LlamaCliClient(config, model_path)


# реализации экспортируются для удобства тестов/wiring; импорт после определений,
# чтобы избежать циклической инициализации пакета.
from .fake import FakeLLMClient  # noqa: E402
from .llama_cli import LlamaCliClient  # noqa: E402

__all__ = [
    "FakeLLMClient",
    "LLMCancelled",
    "LLMClient",
    "LLMError",
    "LLMTimeout",
    "LlamaCliClient",
    "is_repetitive",
    "make_client",
    "repetition_ratio",
    "strip_thinking",
]
