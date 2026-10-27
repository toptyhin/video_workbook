"""M14 rev2: пайплайн смыслового дерева (OUTLINE → SPLIT* → уровни).

Порядок работы (требование пользователя: «нельзя резать произвольные куски»):
1. Сначала анализируется ВЕСЬ текст: OUTLINE выдаёт верхнеуровневое саммари
   всего видео и логические блоки. Если текст не влезает в контекст модели,
   он режется на непрерывные чанки ПО БЮДЖЕТУ ТОКЕНОВ (не по времени),
   OUTLINE выполняется по каждому чанку, top-level блоки — их объединение,
   а ``root_summary`` собирается MERGE-вызовом по саммари чанков (для >8
   чанков — иерархически).
2. Каждый блок рекурсивно проверяется SPLIT: делится ли он по смыслу на
   подблоки. Если нет (или ≤2 сегментов, или достигнут MAX_DEPTH/лимиты) —
   блок-лист с экстрактивным саммари без LLM-вызова.
3. Уровни детализации = фактические уровни дерева этого видео:
   ``max_level = max_depth + 1``; уровень 1 — листья (подробно), уровень
   ``max_level`` — корневое саммари. Ветки, остановившиеся раньше, повторяются
   как листья на более подробных уровнях — каждый уровень покрывает весь текст.

Кэш: ``summary_nodes``/``summary_levels`` per-model, ключ — ``source_hash``
(сегменты + модель + версия промптов + параметры дерева). Смена модели не
затрагивает кэш другой модели; force/новая транскрибация пересоздают дерево.
"""
from __future__ import annotations

import hashlib
import json
import logging
import re
import sqlite3
import threading
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from ...config import Config
from ...db import connect
from ..llm import LLMCancelled, LLMClient, LLMError, LLMTimeout, make_client
from ..model_resolver import get_model, resolve_summary_gguf
from . import parser, prompts, tree

log = logging.getLogger(__name__)

FALLBACK_DETAIL = "fallback"
MAX_OUTLINE_TOKENS = 768
MAX_SPLIT_TOKENS = 640
MAX_MERGE_TOKENS = 400
MAX_DESCRIBE_TOKENS = 320
MERGE_GROUP_SIZE = tree.MERGE_GROUP_SIZE
# rev3: с какой длительности просить у OUTLINE больше блоков (ориентир)
BLOCKS_HINT_MIN_DURATION_MS = 120_000
BLOCKS_HINT_SECONDS_PER_BLOCK = 45_000

ClientFactory = Callable[[str, Path | None], LLMClient]
ProgressCallback = Callable[[str, int, int], None]


class SummaryError(ValueError):
    """Доменная ошибка саммари; ``code``/``status_code`` уходят в API."""

    def __init__(self, code: str, detail: str, status_code: int = 400) -> None:
        super().__init__(detail)
        self.code = code
        self.detail = detail
        self.status_code = status_code


def _dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False)


def _loads(raw: str | None, default: Any) -> Any:
    if not raw:
        return default
    try:
        return json.loads(raw)
    except json.JSONDecodeError:  # pragma: no cover - защита от порчи БД
        return default


_WORD_TOKEN_RE = re.compile(r"[A-Za-zА-Яа-яЁё0-9-]{3,}")


def _word_tokens(text: str) -> list[str]:
    return _WORD_TOKEN_RE.findall(text)


def _groups(items: list[Any], size: int) -> list[list[Any]]:
    size = max(1, int(size))
    return [items[index : index + size] for index in range(0, len(items), size)]


def merge_call_estimate(count: int) -> int:
    """Сколько MERGE-вызовов нужно, чтобы свернуть ``count`` саммари в одно."""
    calls = 0
    current = max(1, int(count))
    while current > 1:
        current = len(_groups(list(range(current)), MERGE_GROUP_SIZE))
        calls += current
    return calls


class SummaryPipeline:
    """Stateless-по-видео генератор; менеджер вызывает ``generate`` в worker-потоке."""

    def __init__(
        self, config: Config, *, client_factory: ClientFactory | None = None
    ) -> None:
        self.config = config
        self._client_factory = client_factory
        self._client_lock = threading.Lock()
        self._active_client: LLMClient | None = None

    # ---------- БД/сегменты ----------

    @contextmanager
    def _connection(
        self, conn: sqlite3.Connection | None = None
    ) -> Iterator[sqlite3.Connection]:
        if conn is not None:
            yield conn
            return
        connection = connect(self.config.db_path)
        try:
            yield connection
        finally:
            connection.close()

    @staticmethod
    def _load_segments(
        conn: sqlite3.Connection, video_id: int
    ) -> list[dict[str, Any]]:
        rows = conn.execute(
            "SELECT id, start_ms, end_ms, text FROM segments WHERE video_id = ? "
            "ORDER BY start_ms, end_ms, id",
            (video_id,),
        ).fetchall()
        return [
            {
                "id": int(row["id"]),
                "start_ms": int(row["start_ms"]),
                "end_ms": int(row["end_ms"]),
                "text": row["text"] or "",
            }
            for row in rows
        ]

    def source_hash(self, segments: list[dict[str, Any]], model_id: str) -> str:
        payload = {
            "segments": [
                {
                    "id": int(segment["id"]),
                    "start_ms": int(segment["start_ms"]),
                    "end_ms": int(segment["end_ms"]),
                    "text": str(segment.get("text") or ""),
                }
                for segment in segments
            ],
            "model": model_id,
            "prompt_version": prompts.PROMPT_VERSION,
            "tree": tree.params(),
        }
        encoded = json.dumps(
            payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")
        ).encode("utf-8")
        return hashlib.sha256(encoded).hexdigest()

    # ---------- кэш ----------

    @staticmethod
    def _read_nodes(
        conn: sqlite3.Connection, video_id: int, model_id: str
    ) -> list[dict[str, Any]]:
        rows = conn.execute(
            "SELECT node_id, parent_id, depth, children_count FROM summary_nodes "
            "WHERE video_id = ? AND model = ?",
            (video_id, model_id),
        ).fetchall()
        return [
            {
                "node_id": str(row["node_id"]),
                "parent_id": row["parent_id"],
                "depth": int(row["depth"]),
                "children_count": int(row["children_count"]),
            }
            for row in rows
        ]

    @staticmethod
    def _read_levels(
        conn: sqlite3.Connection, video_id: int, model_id: str
    ) -> dict[int, dict[str, Any]]:
        levels: dict[int, dict[str, Any]] = {}
        for row in conn.execute(
            "SELECT level, label, blocks, source_hash, prompt_version, created_at "
            "FROM summary_levels WHERE video_id = ? AND model = ? ORDER BY level",
            (video_id, model_id),
        ):
            blocks = _loads(row["blocks"], [])
            if not isinstance(blocks, list):
                blocks = []
            levels[int(row["level"])] = {
                "level": int(row["level"]),
                "label": row["label"],
                "blocks": blocks,
                "source_hash": str(row["source_hash"]),
                "prompt_version": int(row["prompt_version"]),
                "created_at": row["created_at"],
            }
        return levels

    def inspect(
        self,
        video_id: int,
        model_id: str,
        *,
        conn: sqlite3.Connection | None = None,
    ) -> dict[str, Any]:
        """Состояние дерева без LLM-вызовов (статус/request/менеджер)."""
        with self._connection(conn) as connection:
            video = connection.execute(
                "SELECT id, title, status, duration_ms FROM videos WHERE id = ?",
                (video_id,),
            ).fetchone()
            if video is None:
                raise SummaryError("video_not_found", "Видео не найдено", 404)
            segments = self._load_segments(connection, video_id)
            source_hash = self.source_hash(segments, model_id)
            nodes = self._read_nodes(connection, video_id, model_id)
            levels = self._read_levels(connection, video_id, model_id)
        max_level = max(levels) if levels else 0
        root_nodes = [node for node in nodes if node["node_id"] == "0"]
        ready = bool(
            segments
            and nodes
            and max_level >= 2
            and set(levels) == set(range(1, max_level + 1))
            and root_nodes
            and all(
                level["source_hash"] == source_hash
                and level["prompt_version"] == prompts.PROMPT_VERSION
                for level in levels.values()
            )
            and levels[max_level]["blocks"]
        )
        root_summary: str | None = None
        if ready:
            root_blocks = levels[max_level]["blocks"]
            root_summary = str(root_blocks[0].get("text") or "") or None
            ready = bool(root_summary)
        has_cache = bool(nodes or levels)
        return {
            "video": {
                "id": int(video["id"]),
                "title": video["title"],
                "status": video["status"],
                "duration_ms": video["duration_ms"],
            },
            "segments": segments,
            "source_hash": source_hash,
            "nodes_count": len(nodes),
            "levels": levels,
            "max_level": max_level if ready else 0,
            "root_summary": root_summary if ready else None,
            "ready": ready,
            "has_cache": has_cache,
            "stale": has_cache and not ready,
        }

    @staticmethod
    def _delete_cache(
        conn: sqlite3.Connection, video_id: int, model_id: str
    ) -> None:
        conn.execute(
            "DELETE FROM summary_nodes WHERE video_id = ? AND model = ?",
            (video_id, model_id),
        )
        conn.execute(
            "DELETE FROM summary_levels WHERE video_id = ? AND model = ?",
            (video_id, model_id),
        )
        conn.commit()

    # ---------- LLM ----------

    def cancel_active(self) -> None:
        """Kill текущего llama-cli (вызывается менеджером при отмене)."""
        with self._client_lock:
            client = self._active_client
        if client is not None:
            try:
                client.cancel()
            except Exception:  # pragma: no cover - клиент не должен ронять менеджер
                log.warning("Failed to cancel active LLM client", exc_info=True)

    def _new_client(self, model_id: str, gguf: Path | None) -> LLMClient:
        if self._client_factory is not None:
            client = self._client_factory(model_id, gguf)
        else:
            client = make_client(self.config, gguf, model_id=model_id)
        with self._client_lock:
            self._active_client = client
        return client

    def _release_client(self) -> None:
        with self._client_lock:
            self._active_client = None

    @staticmethod
    def _check_cancel(cancel: threading.Event | None) -> None:
        if cancel is not None and cancel.is_set():
            raise SummaryError("cancelled", "Генерация отменена", 409)

    @staticmethod
    def _call_llm(
        client: LLMClient,
        prompt: str,
        schema: dict[str, Any] | None,
        *,
        system: str | None = None,
        grammar: str | None = None,
        max_tokens: int,
        thinking: bool,
    ) -> str:
        kwargs: dict[str, Any] = {
            "json_schema": schema,
            "max_tokens": max_tokens,
            "thinking": thinking,
        }
        if system is not None:
            kwargs["system"] = system
        if grammar is not None:
            kwargs["grammar"] = grammar
        try:
            return client.generate(prompt, **kwargs)
        except TypeError as exc:
            # совместимость со старыми/сторонними клиентами без system/grammar
            if "unexpected keyword" not in str(exc):
                raise
            combined = f"{system}\n\n{prompt}" if system else prompt
            return client.generate(
                combined,
                json_schema=schema,
                max_tokens=max_tokens,
                thinking=thinking,
            )
        except LLMCancelled as exc:
            raise SummaryError("cancelled", exc.detail, 409) from exc
        except LLMTimeout as exc:
            raise SummaryError("summary_timeout", exc.detail, 409) from exc
        except LLMError as exc:
            raise SummaryError(exc.code or "summary_failed", exc.detail, 409) from exc

    def _llm_structured(
        self,
        client: LLMClient,
        *,
        system: str,
        user: str,
        grammar: str,
        schema: dict[str, Any],
        parse: Callable[[str], Any | None],
        fallback: Callable[[], Any],
        max_tokens: int,
        thinking: bool = False,
    ) -> tuple[Any, bool]:
        """Вызов + валидация + один repair; при неудаче — эвристический fallback."""
        try:
            raw = self._call_llm(
                client,
                user,
                schema,
                system=system,
                grammar=grammar,
                max_tokens=max_tokens,
                thinking=thinking,
            )
        except SummaryError as exc:
            if exc.code in ("cancelled", "summary_timeout"):
                raise
            log.warning("LLM call failed (%s), using extractive fallback", exc.code)
            return fallback(), True
        parsed = parse(raw)
        if parsed is not None:
            return parsed, False
        try:
            repaired = self._call_llm(
                client,
                prompts.repair_user(user),
                schema,
                system=system,
                grammar=grammar,
                max_tokens=max_tokens,
                thinking=thinking,
            )
        except SummaryError as exc:
            if exc.code in ("cancelled", "summary_timeout"):
                raise
            log.warning("LLM repair failed (%s), using extractive fallback", exc.code)
            return fallback(), True
        parsed = parse(repaired)
        if parsed is not None:
            return parsed, False
        log.warning("LLM output invalid after repair, using extractive fallback")
        return fallback(), True

    # ---------- материализация уровней ----------

    @staticmethod
    def _block_entry(
        node: tree.TreeNode, known: dict[int, dict[str, Any]]
    ) -> dict[str, Any]:
        start_ms, end_ms = tree.node_span(node.segment_ids, known)
        return {
            "node_id": node.node_id,
            "start_ms": start_ms,
            "end_ms": end_ms,
            "title": node.title,
            "text": node.summary,
            "keywords": parser.extract_keywords(node.summary, limit=5),
        }

    @staticmethod
    def _validate_tree(root: tree.TreeNode) -> None:
        """Проверяет инварианты дерева до материализации уровней.

        - segment_ids узла — непрерывный диапазон порядка корня;
        - дети (если есть) — полное непрерывное разбиение родителя по порядку.
        """
        order = {int(segment_id): index for index, segment_id in enumerate(root.segment_ids)}
        for node in root.walk():
            positions = [order[ref] for ref in node.segment_ids]
            if not positions:
                continue
            if positions != list(range(positions[0], positions[0] + len(positions))):
                raise SummaryError(
                    "summary_failed",
                    f"Дерево саммари повреждено: узел {node.node_id} не является "
                    "непрерывным диапазоном",
                    409,
                )
            if node.children:
                flat = [
                    int(ref)
                    for child in node.children
                    for ref in child.segment_ids
                ]
                if flat != [int(ref) for ref in node.segment_ids]:
                    raise SummaryError(
                        "summary_failed",
                        f"Дерево саммари повреждено: дети узла {node.node_id} "
                        "не образуют разбиение",
                        409,
                    )

    def _persist(
        self,
        conn: sqlite3.Connection,
        video_id: int,
        model_id: str,
        root: tree.TreeNode,
        segments: list[dict[str, Any]],
        source_hash: str,
        *,
        progress: ProgressCallback | None,
    ) -> dict[int, list[dict[str, Any]]]:
        self._validate_tree(root)
        known = {int(segment["id"]): segment for segment in segments}
        nodes = list(root.walk())
        levels_map = tree.block_levels(root)
        max_level = max(levels_map) if levels_map else 1
        total_steps = max(1, len(nodes) + max_level)
        # Прогресс публикуем только до/после записи: открытая write-транзакция
        # SQLite не должна пересекаться с записью job-состояния из колбэка
        # менеджера (иначе «database is locked»).
        self._notify(progress, "summarizing", 0, total_steps)

        for node in nodes:
            start_ms, end_ms = tree.node_span(node.segment_ids, known)
            conn.execute(
                "INSERT INTO summary_nodes(video_id, model, node_id, parent_id, depth, "
                "order_idx, start_ms, end_ms, segment_ids, title, summary, children_count) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    video_id,
                    model_id,
                    node.node_id,
                    node.parent_id,
                    int(node.depth),
                    int(node.order_idx),
                    int(start_ms),
                    int(end_ms),
                    _dumps([int(ref) for ref in node.segment_ids]),
                    node.title,
                    node.summary,
                    int(node.children_count),
                ),
            )

        result: dict[int, list[dict[str, Any]]] = {}
        for level in range(1, max_level + 1):
            nodes_at_level = levels_map.get(level, [])
            blocks = [self._block_entry(node, known) for node in nodes_at_level]
            # уровни отсортированы по времени и не пересекаются
            blocks.sort(key=lambda block: (block["start_ms"], block["end_ms"]))
            label = tree.level_label(level, max_level)
            conn.execute(
                "INSERT INTO summary_levels(video_id, model, level, label, blocks, "
                "source_hash, prompt_version) VALUES (?, ?, ?, ?, ?, ?, ?) "
                "ON CONFLICT(video_id, model, level) DO UPDATE SET "
                "label = excluded.label, blocks = excluded.blocks, "
                "source_hash = excluded.source_hash, prompt_version = excluded.prompt_version",
                (
                    video_id,
                    model_id,
                    level,
                    label,
                    _dumps(blocks),
                    source_hash,
                    prompts.PROMPT_VERSION,
                ),
            )
            result[level] = blocks
        conn.execute(
            "UPDATE summary_jobs SET max_level = ?, updated_at = datetime('now') "
            "WHERE video_id = ?",
            (max_level, video_id),
        )
        conn.commit()
        self._notify(progress, "summarizing", total_steps, total_steps)
        return result

    # ---------- генерация ----------

    @staticmethod
    def _ready_result(
        video_id: int,
        model_id: str,
        source_hash: str,
        levels: dict[int, list[dict[str, Any]]],
        root_summary: str | None,
        max_level: int,
        *,
        fallback: bool,
    ) -> dict[str, Any]:
        return {
            "video_id": video_id,
            "model": model_id,
            "state": "ready",
            "source_hash": source_hash,
            "max_level": max_level,
            "root_summary": root_summary,
            "levels": levels,
            "fallback": fallback,
        }

    def generate(
        self,
        video_id: int,
        model_id: str,
        *,
        level: int | None = None,
        force: bool = False,
        thinking: str = "auto",
        progress: ProgressCallback | None = None,
        cancel: threading.Event | None = None,
    ) -> dict[str, Any]:
        """Строит/переиспользует дерево и материализует все уровни видео."""
        info = self.inspect(video_id, model_id)
        if not info["segments"]:
            raise SummaryError(
                "transcription_not_ready", "Транскрибация ещё не готова", 409
            )
        if info["ready"] and not force:
            if level is not None and not 1 <= int(level) <= int(info["max_level"]):
                raise SummaryError(
                    "invalid_level",
                    f"Уровень должен быть 1..{info['max_level']}",
                    400,
                )
            return self._ready_result(
                video_id,
                model_id,
                info["source_hash"],
                {
                    int(level_key): entry["blocks"]
                    for level_key, entry in info["levels"].items()
                },
                info["root_summary"],
                int(info["max_level"]),
                fallback=False,
            )
        model_entry = get_model(model_id) or {}
        supports_thinking = bool((model_entry.get("meta") or {}).get("supports_thinking"))
        use_thinking = supports_thinking and str(thinking) != "off"
        gguf = resolve_summary_gguf(self.config, model_id)
        if gguf is None:
            raise SummaryError(
                "model_missing", f"Модель саммари не установлена: {model_id}", 409
            )
        client = self._new_client(model_id, gguf)
        source_hash = info["source_hash"]
        try:
            with self._connection() as conn:
                self._delete_cache(conn, video_id, model_id)
                builder = _TreeBuilder(
                    self,
                    client,
                    info["segments"],
                    progress=progress,
                    cancel=cancel,
                    thinking=use_thinking,
                )
                root = builder.build()
                levels = self._persist(
                    conn,
                    video_id,
                    model_id,
                    root,
                    info["segments"],
                    source_hash,
                    progress=progress,
                )
            return self._ready_result(
                video_id,
                model_id,
                source_hash,
                levels,
                root.summary,
                max(levels) if levels else 1,
                fallback=builder.fallback_used,
            )
        finally:
            self._release_client()

    @staticmethod
    def _notify(
        progress: ProgressCallback | None, stage: str, done: int, total: int
    ) -> None:
        if progress is None:
            return
        try:
            progress(stage, int(done), int(total))
        except Exception:  # pragma: no cover - прогресс не должен ломать генерацию
            log.warning("Summary progress callback failed", exc_info=True)


class _TreeBuilder:
    """Строит дерево в памяти: OUTLINE всего текста (или чанков) → SPLIT-рекурсия."""

    def __init__(
        self,
        pipeline: SummaryPipeline,
        client: LLMClient,
        segments: list[dict[str, Any]],
        *,
        progress: ProgressCallback | None,
        cancel: threading.Event | None,
        thinking: bool,
    ) -> None:
        self.pipeline = pipeline
        self.client = client
        self.ordered = tree.ordered_segments(segments)
        self.known = {int(segment["id"]): segment for segment in self.ordered}
        self.progress = progress
        self.cancel = cancel
        self.thinking = thinking
        self.budget = tree.OUTLINE_BUDGET_TOKENS
        self.split_budget = tree.SPLIT_BUDGET_TOKENS
        self.calls = 0
        self.fallback_used = False
        self.deadline = time.monotonic() + tree.DEADLINE_SECONDS
        self.children_created = 0
        self.outline_done = 0
        self.outline_total = 1
        self.split_done = 0
        self.split_total = 0
        # rev3: длительность видео по сегментам (для force-split) и DESCRIBE-пасс.
        starts = [int(segment["start_ms"]) for segment in self.ordered]
        ends = [int(segment["end_ms"]) for segment in self.ordered]
        self.video_duration = max(1, (max(ends) - min(starts)) if starts else 1)
        self.blocks_hint = None
        if self.video_duration >= BLOCKS_HINT_MIN_DURATION_MS:
            self.blocks_hint = max(
                4,
                min(10, round(self.video_duration / BLOCKS_HINT_SECONDS_PER_BLOCK)),
            )
        self.describe_calls = 0
        self.force_splits = 0
        self.forced_node_ids: set[str] = set()

    # ---------- общие ограничения ----------

    def _can_call(self) -> bool:
        if self.calls >= tree.MAX_CALLS:
            return False
        if time.monotonic() >= self.deadline:
            return False
        return True

    def _call(
        self,
        *,
        system: str,
        user: str,
        grammar: str,
        schema: dict[str, Any],
        parse: Callable[[str], Any | None],
        fallback: Callable[[], Any],
        max_tokens: int,
        thinking: bool = False,
    ) -> dict[str, Any]:
        self.pipeline._check_cancel(self.cancel)
        if not self._can_call():
            self.fallback_used = True
            return fallback()
        self.calls += 1
        parsed, used_fallback = self.pipeline._llm_structured(
            self.client,
            system=system,
            user=user,
            grammar=grammar,
            schema=schema,
            parse=parse,
            fallback=fallback,
            max_tokens=max_tokens,
            thinking=thinking,
        )
        self.fallback_used = self.fallback_used or used_fallback
        return parsed

    def _try_call(
        self,
        *,
        system: str,
        user: str,
        grammar: str,
        schema: dict[str, Any],
        parse: Callable[[str], Any | None],
        max_tokens: int,
    ) -> Any | None:
        """Вызов без экстрактивного fallback: None, если модель не справилась."""
        self.pipeline._check_cancel(self.cancel)
        if not self._can_call():
            return None
        self.calls += 1
        parsed, used_fallback = self.pipeline._llm_structured(
            self.client,
            system=system,
            user=user,
            grammar=grammar,
            schema=schema,
            parse=parse,
            fallback=lambda: None,
            max_tokens=max_tokens,
        )
        if used_fallback:
            return None
        return parsed

    def _notify(self, stage: str, done: int, total: int) -> None:
        self.pipeline._notify(self.progress, stage, done, total)

    # ---------- OUTLINE ----------

    def _outline_chunk(
        self, chunk: list[dict[str, Any]], *, report: bool = True
    ) -> dict[str, Any]:
        system, user = prompts.outline_messages(chunk, chunked=True)
        parsed = self._call(
            system=system,
            user=user,
            grammar=prompts.outline_grammar(chunked=True),
            schema=prompts.outline_schema(),
            parse=lambda raw: parser.parse_outline(raw, chunk, allow_single=True),
            fallback=lambda: parser.fallback_outline(chunk, allow_single=True),
            max_tokens=MAX_OUTLINE_TOKENS,
        )
        if report:
            self.outline_done += 1
            self.outline_total = max(self.outline_total, self.outline_done)
            self._notify("outline", self.outline_done, self.outline_total)
        return parsed

    def _merge_summaries(self, summaries: list[str]) -> str:
        items = [str(item or "") for item in summaries]
        if not items:
            return ""
        if len(items) == 1:
            return items[0]
        while len(items) > 1:
            merged: list[str] = []
            for group in _groups(items, MERGE_GROUP_SIZE):
                system, user = prompts.merge_messages(group, thinking=self.thinking)
                parsed = self._call(
                    system=system,
                    user=user,
                    grammar=prompts.merge_grammar(),
                    schema=prompts.merge_schema(),
                    parse=parser.parse_merge,
                    fallback=lambda group=group: parser.fallback_merge(group),
                    max_tokens=MAX_MERGE_TOKENS,
                    thinking=self.thinking,
                )
                merged.append(str(parsed.get("summary") or ""))
                self.outline_done += 1
                self.outline_total = max(self.outline_total, self.outline_done)
                self._notify("outline", self.outline_done, self.outline_total)
            items = merged
        return items[0]

    def _outline_all(self) -> tuple[str, list[dict[str, Any]]]:
        segments = self.ordered
        chunks = tree.chunk_segments(segments, max_tokens=self.budget)
        if len(chunks) <= 1:
            system, user = prompts.outline_messages(
                segments,
                duration_ms=self.video_duration,
                blocks_hint=self.blocks_hint,
            )
            self.outline_total = 1
            self._notify("outline", 0, self.outline_total)
            parsed = self._call(
                system=system,
                user=user,
                grammar=prompts.outline_grammar(),
                schema=prompts.outline_schema(),
                parse=lambda raw: parser.parse_outline(raw, segments),
                fallback=lambda: parser.fallback_outline(segments),
                max_tokens=MAX_OUTLINE_TOKENS,
            )
            self.outline_done = max(1, self.outline_done)
            self.outline_total = max(self.outline_total, self.outline_done)
            self._notify("outline", self.outline_total, self.outline_total)
            return str(parsed["summary"]), list(parsed["blocks"])
        # Не влезает в контекст: чанки ТОЛЬКО по бюджету токенов, по порядку.
        self.outline_total = len(chunks) + merge_call_estimate(len(chunks))
        self._notify("outline", 0, self.outline_total)
        summaries: list[str] = []
        blocks: list[dict[str, Any]] = []
        for chunk in chunks:
            parsed = self._outline_chunk(chunk)
            summaries.append(str(parsed["summary"]))
            blocks.extend(parsed["blocks"])
        root_summary = self._merge_summaries(summaries)
        self._notify("outline", self.outline_total, self.outline_total)
        return root_summary, blocks

    # ---------- SPLIT-рекурсия ----------

    def _should_leaf(self, node: tree.TreeNode) -> bool:
        if len(node.segment_ids) <= tree.MIN_LEAF_SEGMENTS:
            return True
        if node.depth >= tree.MAX_DEPTH:
            return True
        if 1 + self.children_created >= tree.MAX_NODES:
            return True
        if not self._can_call():
            self.fallback_used = True
            return True
        return False

    def _chunk_outline(self, node: tree.TreeNode) -> list[dict[str, Any]]:
        node_segments = [
            self.known[ref] for ref in node.segment_ids if ref in self.known
        ]
        chunks = tree.chunk_segments(node_segments, max_tokens=self.split_budget)
        if len(chunks) < 2:
            return []
        blocks: list[dict[str, Any]] = []
        for chunk in chunks:
            parsed = self._outline_chunk(chunk, report=False)
            blocks.extend(parsed["blocks"])
        return blocks

    def _split_children(self, node: tree.TreeNode) -> list[dict[str, Any]]:
        node_segments = [
            self.known[ref] for ref in node.segment_ids if ref in self.known
        ]
        if tree.segments_tokens(node_segments) > self.split_budget:
            return self._chunk_outline(node)
        system, user = prompts.split_messages(
            node_segments, title=node.title, summary=node.summary
        )
        parsed = self._call(
            system=system,
            user=user,
            grammar=prompts.split_grammar(),
            schema=prompts.split_schema(),
            parse=lambda raw: parser.parse_split(raw, node_segments),
            fallback=lambda: parser.fallback_split(node_segments),
            max_tokens=MAX_SPLIT_TOKENS,
        )
        if not parsed.get("split"):
            return []
        return list(parsed.get("blocks") or [])

    # ---------- rev3: принудительное деление крупных блоков ----------

    def _node_segments(self, node: tree.TreeNode) -> list[dict[str, Any]]:
        return [self.known[ref] for ref in node.segment_ids if ref in self.known]

    def _node_text(self, node: tree.TreeNode) -> str:
        return " ".join(
            str(segment.get("text") or "") for segment in self._node_segments(node)
        )

    def _node_duration(self, node: tree.TreeNode) -> int:
        start_ms, end_ms = tree.node_span(node.segment_ids, self.known)
        return max(0, end_ms - start_ms)

    def _needs_force_split(self, node: tree.TreeNode) -> bool:
        """Крупный блок: его нельзя оставлять листом (rev3)."""
        if len(node.segment_ids) < tree.FORCE_SPLIT_MIN_SEGMENTS:
            return False
        if node.depth >= tree.MAX_DEPTH:
            return False
        threshold = max(
            tree.FORCE_SPLIT_MIN_MS,
            tree.FORCE_SPLIT_RATIO * self.video_duration,
        )
        return self._node_duration(node) > threshold

    def _log_force_split(self, node: tree.TreeNode, path: str) -> None:
        log.info(
            "force-split node=%s duration=%.1fs segments=%d path=%s",
            node.node_id,
            self._node_duration(node) / 1000.0,
            len(node.segment_ids),
            path,
        )

    def _outline_block_blocks(self, node: tree.TreeNode) -> list[dict[str, Any]]:
        """OUTLINE_CHUNK-разметка внутри большого блока мелкими чанками.

        Маленькие модели (Qwen 0.5B) срываются в repetition на длинных входах,
        поэтому чанк — ~800 токенов (30–50 с), а не весь бюджет сплита.
        """
        node_segments = self._node_segments(node)
        chunks = tree.chunk_segments(node_segments, max_tokens=tree.FORCE_CHUNK_TOKENS)
        blocks: list[dict[str, Any]] = []
        for chunk in chunks:
            parsed = self._outline_chunk(chunk, report=False)
            blocks.extend(parsed.get("blocks") or [])
        return blocks

    def _force_split_children(self, node: tree.TreeNode) -> list[dict[str, Any]]:
        """Дробит крупный узел: мелкие OUTLINE_CHUNK → force-SPLIT → эвристика."""
        node_segments = self._node_segments(node)
        node_tokens = tree.segments_tokens(node_segments)
        if node_tokens > tree.FORCE_CHUNK_TOKENS:
            # Слишком длинный вход: сначала режем на мелкие чанки и размечаем
            # каждый OUTLINE_CHUNK-ом (меньше repetition, лучше описания).
            if self._can_call():
                blocks = self._outline_block_blocks(node)
                if len(blocks) >= 2:
                    self._log_force_split(node, "outline_chunks")
                    return blocks
        else:
            # a) SPLIT с явным требованием деления
            if self._can_call():
                system, user = prompts.split_messages(
                    node_segments,
                    title=node.title,
                    summary=node.summary,
                    force=True,
                )
                parsed = self._try_call(
                    system=system,
                    user=user,
                    grammar=prompts.split_grammar(force=True),
                    schema=prompts.split_schema(),
                    parse=lambda raw: parser.parse_split(raw, node_segments),
                    max_tokens=MAX_SPLIT_TOKENS,
                )
                if parsed and parsed.get("split"):
                    blocks = list(parsed.get("blocks") or [])
                    if len(blocks) >= 2:
                        self._log_force_split(node, "forced_split")
                        return blocks
            # b) OUTLINE_CHUNK по этому же блоку
            if self._can_call():
                blocks = self._outline_block_blocks(node)
                if len(blocks) >= 2:
                    self._log_force_split(node, "outline_chunk")
                    return blocks
        # c) эвристическое деление пополам — лучше, чем лист-гигант
        self.fallback_used = True
        blocks = list(parser.fallback_split(node_segments).get("blocks") or [])
        self._log_force_split(node, "fallback_halves")
        return blocks

    def _add_children(
        self, node: tree.TreeNode, blocks: list[dict[str, Any]], *, force: bool
    ) -> int:
        # Жёсткий инвариант: дети — непрерывное разбиение сегментов родителя,
        # в порядке документа, без пересечений и пропусков. Любой ответ модели
        # нормализуем к диапазону родителя; если не вышло — эвристика.
        node_segments = self._node_segments(node)
        if not blocks:
            # модель/эвристика сказали «блок атомарен» — это нормальный лист
            return 0
        blocks = parser.normalize_blocks(blocks, node_segments)
        if len(blocks) < 2:
            if not force:
                return 0
            blocks = list(parser.fallback_split(node_segments).get("blocks") or [])
            if len(blocks) < 2:
                self._advance_split()
                return 0
            log.info(
                "children of node %s не образовали разбиение — fallback_split",
                node.node_id,
            )
            self.fallback_used = True
        if not force:
            free_slots = tree.MAX_NODES - 1 - self.children_created
            blocks = blocks[: max(0, free_slots)]
            if len(blocks) < 2:
                return 0
            blocks = parser.normalize_blocks(blocks, node_segments)
            if len(blocks) < 2:
                return 0
        elif tree.MAX_NODES - 1 - self.children_created < len(blocks):
            log.warning(
                "force-split node %s превышает MAX_NODES (%d), продолжаем деление",
                node.node_id,
                tree.MAX_NODES,
            )
        for block in blocks:
            node.add_child(
                segment_ids=list(block["segment_ids"]),
                title=block.get("title"),
                summary=str(block.get("summary") or ""),
            )
            self.children_created += 1
        self.split_total += len(node.children)
        return len(blocks)

    def _expand(self, node: tree.TreeNode) -> None:
        if self._needs_force_split(node):
            self.forced_node_ids.add(node.node_id)
            children = self._force_split_children(node)
            added = self._add_children(node, children, force=True)
            self.force_splits += 1
            self._advance_split()
            if added < 2:
                return
            for child in node.children:
                self._expand(child)
            return
        if self._should_leaf(node):
            self._advance_split()
            return
        children = self._split_children(node)
        added = self._add_children(node, children, force=False)
        self._advance_split()
        if added < 2:
            return
        for child in node.children:
            self._expand(child)

    def _advance_split(self) -> None:
        self.split_done += 1
        self.split_total = max(self.split_total, self.split_done)
        self._notify("splitting", self.split_done, self.split_total)

    # ---------- rev3: DESCRIBE-пасс (информативные title/summary) ----------

    def _can_describe(self) -> bool:
        if self.describe_calls >= tree.DESCRIBE_MAX_CALLS:
            return False
        if time.monotonic() >= self.deadline:
            return False
        return self.calls < tree.MAX_CALLS + tree.DESCRIBE_MAX_CALLS

    def _describe_context(
        self, node: tree.TreeNode, by_id: dict[str, tree.TreeNode]
    ) -> list[str]:
        context: list[str] = []
        parent = by_id.get(node.parent_id) if node.parent_id else None
        if parent is not None and parent.summary:
            title = f"{parent.title}: " if parent.title else ""
            context.append(f"родительский блок «{title}{parent.summary[:240]}»")
        if parent is not None:
            siblings = [
                sibling.title
                for sibling in parent.children
                if sibling is not node and sibling.title and not parser.is_generic_title(sibling.title)
            ]
            if siblings:
                context.append("соседние темы: " + "; ".join(siblings[:5]))
        return context

    def _describe_node(
        self,
        node: tree.TreeNode,
        *,
        by_id: dict[str, tree.TreeNode],
    ) -> None:
        node_segments = self._node_segments(node)
        text = self._node_text(node)[: tree.DESCRIBE_MAX_TEXT_CHARS]
        if not text.strip():
            return
        if self._can_describe():
            self.describe_calls += 1
            self.calls += 1
            system, user = prompts.describe_messages(
                node_segments,
                current_title=node.title,
                current_summary=node.summary,
                context=self._describe_context(node, by_id),
            )
            try:
                raw = self.pipeline._call_llm(
                    self.client,
                    user,
                    prompts.describe_schema(),
                    system=system,
                    grammar=prompts.describe_grammar(),
                    max_tokens=MAX_DESCRIBE_TOKENS,
                    thinking=False,
                )
                parsed = parser.parse_describe(raw)
            except SummaryError as exc:
                if exc.code in ("cancelled", "summary_timeout"):
                    raise
                log.info(
                    "describe failed for node %s: %s", node.node_id, exc.code
                )
                parsed = None
            if parsed is not None:
                new_title = str(parsed["title"]).strip()
                new_summary = str(parsed["summary"]).strip()
                old_title = str(node.title or "").strip()
                old_summary = str(node.summary or "").strip()
                if (
                    new_title.casefold() == old_title.casefold()
                    and new_summary.casefold() == old_summary.casefold()
                ):
                    parsed = None  # модель просто скопировала текущее описание
                else:
                    node.title = new_title
                    node.summary = new_summary
                    return
        fallback = parser.fallback_describe(text, current_title=node.title)
        node.title = fallback["title"]
        node.summary = fallback["summary"]
        self.fallback_used = True

    def _describe_pass(self, root: tree.TreeNode) -> None:
        by_id = {node.node_id: node for node in root.walk()}
        planned = [
            node
            for node in root.walk()
            if node is not root
            and parser.needs_description(
                node.title, node.summary, self._node_text(node)
            )
        ]
        if not planned:
            return
        planned.sort(
            key=lambda node: (node.depth, -self._node_duration(node))
        )
        # DESCRIBE идёт в той же стадии построения дерева: прогресс «splitting».
        self.split_total += len(planned)
        self._notify("splitting", self.split_done, self.split_total)
        for node in planned:
            self.pipeline._check_cancel(self.cancel)
            self._describe_node(node, by_id=by_id)
            self._advance_split()
        # Гарантия: после DESCRIBE не остаётся слабых заголовков/описаний —
        # иначе детерминированный fallback (осмысленная фраза, не первая фраза).
        for node in root.walk():
            if node is root:
                continue
            text = self._node_text(node)
            if not str(node.summary or "").strip():
                node.summary = parser.description_from_text(text)
            if (
                not node.title
                or parser.is_generic_title(node.title)
                or parser.title_is_text_prefix(node.title, text)
                or parser.summary_repeats_title(node.summary, node.title)
            ):
                theme = parser.theme_from_description(node.summary)
                if not theme or parser.is_generic_title(theme):
                    theme = parser.derive_title(text)
                node.title = theme
            if parser.summary_repeats_title(node.summary, node.title):
                node.summary = parser.description_from_text(text)

    # ---------- финальная детерминированная пост-обработка ----------

    def _unique_title(
        self,
        node: tree.TreeNode,
        siblings: list[tree.TreeNode],
        sibling_titles: list[str],
    ) -> str:
        sibling_texts = [self._node_text(sibling) for sibling in siblings]
        return parser.unique_theme_title(
            node.summary,
            self._node_text(node),
            sibling_titles,
            sibling_texts,
        )

    def _dedupe_descriptions(self, root: tree.TreeNode) -> None:
        """Убирает копии родительских/сиблинг-описаний и дубли заголовков."""
        for parent in list(root.walk()):
            if not parent.children:
                continue
            parent_summary = str(parent.summary or "")
            for child in parent.children:
                own_text = self._node_text(child)
                current = str(child.summary or "")
                near_parent = bool(
                    parent_summary
                    and parser.is_near_duplicate(current, parent_summary)
                )
                near_sibling = any(
                    parser.is_near_duplicate(current, str(other.summary or ""))
                    for other in parent.children
                    if other is not child
                )
                if not current.strip() or near_parent or near_sibling:
                    replacement = parser.description_from_text(own_text)
                    if replacement:
                        child.summary = replacement
            sibling_titles: list[str] = []
            for child in parent.children:
                own_text = self._node_text(child)
                bad_title = (
                    not child.title
                    or parser.is_generic_title(child.title)
                    or parser.title_is_text_prefix(child.title, own_text)
                    or parser.summary_repeats_title(child.summary, child.title)
                    or child.title.casefold().strip()
                    in {title.casefold().strip() for title in sibling_titles}
                )
                if bad_title:
                    child.title = self._unique_title(
                        child,
                        [other for other in parent.children if other is not child],
                        sibling_titles,
                    )
                sibling_titles.append(child.title)

    # ---------- rev3: root overview по темам верхних уровней ----------

    def _root_topics(self, root: tree.TreeNode) -> list[dict[str, Any]]:
        """Темы уровня «Темы» (top-level); если она одна — её подтемы."""
        topics = list(root.children)
        if len(topics) == 1 and topics[0].children:
            topics = list(topics[0].children)
        return [
            {"title": node.title or "", "summary": node.summary or ""}
            for node in topics[:12]
        ]

    def _root_overview(self, root: tree.TreeNode) -> None:
        """Верхнеуровневое саммари — детерминированно из тем верхнего уровня.

        Формат: «О чём видео: <вступление>. Темы: <t1>; <t2>; …» — без сырого
        описания первого куска и без мусорных префиксов; темы не дублируются.
        """
        topics = self._root_topics(root)
        overview = parser.compose_root_summary(topics) if topics else ""
        if not overview:
            overview = parser.description_from_text(
                " ".join(str(s.get("text") or "") for s in self.ordered)
            )
        root.title = None
        root.summary = overview or "О чём видео: лекция разбирает несколько тем."
        # прогресс: один шаг «splitting»
        self.split_total += 1
        self._advance_split()

    # ---------- сборка ----------

    def _promote_forced_top_level(self, root: tree.TreeNode) -> None:
        """Крупный top-level блок, разбитый force-split, заменяем его подтемами.

        Иначе уровень «Темы» показывает один блок на 95% видео. Дети уже
        образуют непрерывное разбиение родителя, поэтому инварианты покрытия
        сохраняются, а дерево становится осмысленным на всех уровнях.
        """
        if not root.children:
            return
        promoted: list[tree.TreeNode] = []
        changed = False
        for child in list(root.children):
            if (
                child.node_id in self.forced_node_ids
                and child.children
                and len(promoted) + len(child.children) + 1 <= 12
            ):
                promoted.extend(child.children)
                changed = True
            else:
                promoted.append(child)
        if not changed:
            return
        root.children = promoted
        for child in promoted:
            child.parent_id = root.node_id
            child.depth = 1
        tree.renumber(root)
        log.info(
            "promoted force-split top-level topics: %d -> %d",
            len(self.forced_node_ids),
            len(root.children),
        )

    def _expand_promoted_topics(self, root: tree.TreeNode) -> None:
        """Поднятые наверх подтемы-листья, которые всё ещё крупные, дробим дальше."""
        for child in list(root.children):
            if child.children:
                continue
            if not self._needs_force_split(child):
                continue
            self.forced_node_ids.add(child.node_id)
            children = self._force_split_children(child)
            added = self._add_children(child, children, force=True)
            self.force_splits += 1
            self._advance_split()
            if added >= 2:
                for grandchild in child.children:
                    self._expand(grandchild)

    def build(self) -> tree.TreeNode:
        root_summary, top_blocks = self._outline_all()
        root_summary = str(root_summary or "").strip()[: prompts.MAX_SUMMARY_CHARS]
        if not root_summary:
            root_summary = parser.leaf_summary(self.ordered)
        if not root_summary:
            root_summary = f"Лекция из {len(self.ordered)} фрагментов транскрибации."
        root = tree.make_root(
            [int(segment["id"]) for segment in self.ordered], root_summary
        )
        top_blocks = top_blocks[: max(0, tree.MAX_NODES - 1)]
        for block in top_blocks:
            root.add_child(
                segment_ids=list(block["segment_ids"]),
                title=block.get("title"),
                summary=str(block.get("summary") or ""),
            )
            self.children_created += 1
        self.split_total = max(1, len(root.children))
        self.split_done = 0
        self._notify("splitting", 0, self.split_total)
        for child in list(root.children):
            self._expand(child)
        self._promote_forced_top_level(root)
        self._expand_promoted_topics(root)
        # Листья: описание без LLM — нормализованные 1–2 предложения текста
        # (а не первая фраза целиком), слабый title заменит DESCRIBE-пасс.
        for node in root.walk():
            if not node.is_leaf:
                continue
            text = self._node_text(node)
            if not parser.needs_description(node.title, node.summary, text):
                continue  # у листа уже есть осмысленное описание от модели
            fallback = parser.fallback_describe(text, current_title=node.title)
            node.summary = fallback["summary"]
            if not node.title or parser.is_generic_title(node.title):
                node.title = fallback["title"]
        self._describe_pass(root)
        self._dedupe_descriptions(root)
        self._root_overview(root)
        return root


__all__ = [
    "FALLBACK_DETAIL",
    "MAX_MERGE_TOKENS",
    "MAX_OUTLINE_TOKENS",
    "MAX_SPLIT_TOKENS",
    "MERGE_GROUP_SIZE",
    "SummaryError",
    "SummaryPipeline",
    "merge_call_estimate",
]
