"""M14 rev2: дерево смысловых блоков — чанки по бюджету и узлы.

Ключевое отличие от прежнего MAP по окнам 90–150 с: транскрибация НЕ режется
произвольно по времени. Единственная причина деления — бюджет контекста
модели: сначала анализируется весь текст (OUTLINE всего видео), и только если
он не влезает в контекст, он режется на непрерывные чанки по порядку сегментов
(без перекрытий), чтобы всё равно получить верхнеуровневое саммари (MERGE).

Узлы дерева:
- корень ``0`` (depth 0) — верхнеуровневое саммари всего видео (root_summary);
- top-level блоки ``0.0``, ``0.1``, … (depth 1) — логические блоки OUTLINE;
- дальше дети ``0.1.0``, … (depth 2, 3, …) — подблоки, полученные SPLIT.

Уровни детализации материализуются по фактической глубине дерева:
``max_level = max_depth + 1``; уровень 1 — листья (самый подробный),
уровень ``max_level`` — корневое саммари. Ветки, остановившиеся раньше
(блок атомарен), повторяются как листья на более подробных уровнях, поэтому
каждый уровень покрывает все сегменты видео без пропусков.
"""
from __future__ import annotations

import math
from collections.abc import Iterator
from dataclasses import dataclass, field
from typing import Any

CHARS_PER_TOKEN = 3.5
# Вход одного OUTLINE/SPLIT-вызова должен укладываться в контекст маленькой
# модели (pinned llama.cpp: -c 4096); ~1800–2200 токенов с учётом system.
OUTLINE_BUDGET_TOKENS = 2000
# SPLIT-промпт содержит заголовок и саммари блока, поэтому его входной бюджет
# чуть меньше: если блок не влезает — он режется на чанки и размечается OUTLINE.
SPLIT_BUDGET_TOKENS = 1600
LINE_OVERHEAD_TOKENS = 8
MIN_LEAF_SEGMENTS = 2
MAX_DEPTH = 8
# rev3: крупный блок нельзя оставлять листом — его дробим принудительно.
FORCE_SPLIT_MIN_SEGMENTS = 8
FORCE_SPLIT_MIN_MS = 45_000
FORCE_SPLIT_RATIO = 0.18
# rev3: крупные блоки режем мелкими чанками — меньше repetition у маленьких моделей
FORCE_CHUNK_TOKENS = 800
# rev3: бюджет DESCRIBE-пасса (переписывание слабых title/summary).
DESCRIBE_MAX_CALLS = 48
DESCRIBE_MAX_TEXT_CHARS = 2400
WEAK_SUMMARY_MIN_CHARS = 30
MAX_NODES = 250
MAX_CALLS = 400
DEADLINE_SECONDS = 1800.0
OUTLINE_MAX_BLOCKS = 8
SPLIT_MAX_BLOCKS = 6
MERGE_GROUP_SIZE = 8

Segment = dict[str, Any]


def estimate_tokens(text: str | None) -> int:
    """Грубая оценка токенов для русского текста: ``chars / 3.5``."""
    if not text:
        return 0
    return max(1, int(math.ceil(len(text) / CHARS_PER_TOKEN)))


def segment_tokens(segment: Segment) -> int:
    """Токены строки в промпте вместе с префиксом ``[id] [mm:ss–mm:ss]``."""
    return estimate_tokens(str(segment.get("text") or "")) + LINE_OVERHEAD_TOKENS


def segments_tokens(segments: list[Segment]) -> int:
    return sum(segment_tokens(segment) for segment in segments)


def chunk_segments(
    segments: list[Segment], *, max_tokens: int = OUTLINE_BUDGET_TOKENS
) -> list[list[Segment]]:
    """Непрерывные чанки по бюджету контекста; полное покрытие, без перекрытий.

    Чанки строятся только по порядку сегментов (и по их токенам), таймкоды
    роли не играют. Сегмент, который сам больше бюджета, становится отдельным
    чанком — иначе часть текста вообще не была бы проанализирована.
    """
    ordered = ordered_segments(segments)
    if not ordered:
        return []
    budget = max(1, int(max_tokens))
    chunks: list[list[Segment]] = []
    current: list[Segment] = []
    tokens = 0
    for segment in ordered:
        cost = segment_tokens(segment)
        if current and tokens + cost > budget:
            chunks.append(current)
            current = []
            tokens = 0
        current.append(segment)
        tokens += cost
    if current:
        chunks.append(current)
    return chunks


def ordered_segments(segments: list[Segment]) -> list[Segment]:
    return sorted(
        (
            {
                "id": int(segment["id"]),
                "start_ms": int(segment["start_ms"]),
                "end_ms": int(segment["end_ms"]),
                "text": str(segment.get("text") or ""),
            }
            for segment in segments
        ),
        key=lambda item: (item["start_ms"], item["end_ms"], item["id"]),
    )


def params() -> dict[str, int]:
    """Параметры нарезки/дерева входят в ``source_hash`` кэша."""
    return {
        "outline_budget_tokens": OUTLINE_BUDGET_TOKENS,
        "split_budget_tokens": SPLIT_BUDGET_TOKENS,
        "line_overhead_tokens": LINE_OVERHEAD_TOKENS,
        "min_leaf_segments": MIN_LEAF_SEGMENTS,
        "max_depth": MAX_DEPTH,
        "force_split_min_segments": FORCE_SPLIT_MIN_SEGMENTS,
        "force_split_min_ms": FORCE_SPLIT_MIN_MS,
        "force_split_ratio_x100": int(FORCE_SPLIT_RATIO * 100),
        "force_chunk_tokens": FORCE_CHUNK_TOKENS,
        "describe_max_calls": DESCRIBE_MAX_CALLS,
        "max_nodes": MAX_NODES,
        "chars_per_token_x10": int(CHARS_PER_TOKEN * 10),
    }


@dataclass
class TreeNode:
    """Узел смыслового дерева; ``node_id`` иерархический: 0, 0.1, 0.1.2."""

    node_id: str
    depth: int
    segment_ids: list[int]
    title: str | None = None
    summary: str = ""
    order_idx: int = 0
    parent_id: str | None = None
    children: list[TreeNode] = field(default_factory=list)

    @property
    def children_count(self) -> int:
        return len(self.children)

    @property
    def is_leaf(self) -> bool:
        return not self.children

    def add_child(
        self,
        *,
        segment_ids: list[int],
        title: str | None,
        summary: str,
    ) -> TreeNode:
        index = len(self.children)
        child = TreeNode(
            node_id=f"{self.node_id}.{index}",
            depth=self.depth + 1,
            segment_ids=list(segment_ids),
            title=title,
            summary=summary,
            order_idx=index,
            parent_id=self.node_id,
        )
        self.children.append(child)
        return child

    def walk(self) -> Iterator[TreeNode]:
        """Предобход: сначала родитель, затем дети по порядку."""
        yield self
        for child in self.children:
            yield from child.walk()

    def leaves(self) -> Iterator[TreeNode]:
        if not self.children:
            yield self
            return
        for child in self.children:
            yield from child.leaves()


def renumber(root: TreeNode) -> TreeNode:
    """Перенумеровывает узлы после структурной перестройки (node_id/parent/depth)."""
    root.node_id = "0"
    root.parent_id = None
    root.depth = 0
    root.order_idx = 0

    def visit(node: TreeNode) -> None:
        for index, child in enumerate(node.children):
            child.node_id = f"{node.node_id}.{index}"
            child.parent_id = node.node_id
            child.depth = node.depth + 1
            child.order_idx = index
            visit(child)

    visit(root)
    return root


def make_root(segment_ids: list[int], summary: str = "") -> TreeNode:
    return TreeNode(
        node_id="0", depth=0, segment_ids=list(segment_ids), title=None, summary=summary
    )


def max_depth(root: TreeNode) -> int:
    return max((node.depth for node in root.walk()), default=0)


def node_count(root: TreeNode) -> int:
    return sum(1 for _ in root.walk())


def node_span(
    segment_ids: list[int], known: dict[int, Segment]
) -> tuple[int, int]:
    refs = [known[ref] for ref in segment_ids if ref in known]
    if not refs:
        return 0, 0
    return (
        min(int(item["start_ms"]) for item in refs),
        max(int(item["end_ms"]) for item in refs),
    )


def block_levels(root: TreeNode) -> dict[int, list[TreeNode]]:
    """Раскладывает узлы по уровням детализации 1..max_level.

    Уровень 1 — самый подробный (листья), ``max_level`` — корень. Глубина
    уровня: ``target_depth = max_depth + 1 - level``. Если ветка остановилась
    раньше (лист выше ``target_depth``), лист повторяется на всех более
    подробных уровнях — так каждый уровень покрывает все сегменты.
    """
    deepest = max_depth(root)
    size = deepest + 1
    by_level: dict[int, list[TreeNode]] = {level: [] for level in range(1, size + 1)}
    seen: dict[int, set[str]] = {level: set() for level in range(1, size + 1)}

    def visit(node: TreeNode, path: list[TreeNode]) -> None:
        if not node.children:
            leaf_depth = node.depth
            for level in range(1, size + 1):
                target_depth = size - level
                pick = path[min(leaf_depth, target_depth)]
                if pick.node_id in seen[level]:
                    continue
                seen[level].add(pick.node_id)
                by_level[level].append(pick)
            return
        for child in node.children:
            visit(child, [*path, child])

    visit(root, [root])
    for level, nodes in by_level.items():
        by_level[level] = sorted(nodes, key=_document_order)
    return by_level


def _document_order(node: TreeNode) -> tuple[str, ...]:
    """Сортировка узлов в порядке документа по иерархическому id."""
    parts = node.node_id.split(".")
    # "0.10" должен идти после "0.9" — сравниваем числовые компоненты.
    return tuple(f"{int(part):06d}" for part in parts)


def level_label(level: int, max_level: int) -> str:
    """Название уровня по фактической глубине дерева этого видео."""
    if level >= max_level:
        return "Обзор"
    if level == 1:
        return "Подробно"
    if level == max_level - 1:
        return "Темы"
    if level <= (max_level - 1) / 2:
        return "Средне"
    return "Кратко"


def level_depth(level: int, max_level: int) -> int:
    """Глубина узлов уровня (0 — корень, max_depth — листья)."""
    return max_level - level


__all__ = [
    "CHARS_PER_TOKEN",
    "DEADLINE_SECONDS",
    "DESCRIBE_MAX_CALLS",
    "DESCRIBE_MAX_TEXT_CHARS",
    "FORCE_CHUNK_TOKENS",
    "FORCE_SPLIT_MIN_MS",
    "FORCE_SPLIT_MIN_SEGMENTS",
    "FORCE_SPLIT_RATIO",
    "LINE_OVERHEAD_TOKENS",
    "MAX_CALLS",
    "MAX_DEPTH",
    "MAX_NODES",
    "MERGE_GROUP_SIZE",
    "MIN_LEAF_SEGMENTS",
    "OUTLINE_BUDGET_TOKENS",
    "SPLIT_BUDGET_TOKENS",
    "OUTLINE_MAX_BLOCKS",
    "SPLIT_MAX_BLOCKS",
    "TreeNode",
    "WEAK_SUMMARY_MIN_CHARS",
    "block_levels",
    "chunk_segments",
    "estimate_tokens",
    "level_depth",
    "level_label",
    "make_root",
    "max_depth",
    "node_count",
    "node_span",
    "ordered_segments",
    "params",
    "renumber",
    "segment_tokens",
    "segments_tokens",
]
