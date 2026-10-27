"""M14 rev2: саммари транскрибации — иерархическое смысловое дерево.

Публичные точки входа:
- ``SummaryManager`` — фоновый менеджер (``app.state.summary``);
- ``SummaryPipeline`` — OUTLINE/SPLIT/уровни/кэш (менеджер и тесты);
- ``SummaryError`` — доменная ошибка с ``code``/``status_code``.
"""
from __future__ import annotations

from .manager import SummaryManager
from .pipeline import SummaryError, SummaryPipeline

__all__ = ["SummaryError", "SummaryManager", "SummaryPipeline"]
