"""Семантический (векторный) индекс сегментов транскрибации (M12).

Модель — ``intfloat/multilingual-e5-small`` в ONNX int8: mean-pooling по
``last_hidden_state`` с attention mask и L2-нормализация; префиксы e5
``query: `` / ``passage: ``. Без sqlite-vec: векторы хранятся в таблице
``segment_embeddings`` (BLOB float32), а для поиска кэшируются матрицей в памяти.
"""
from __future__ import annotations

import html
import logging
import sqlite3
import threading
from pathlib import Path
from typing import Any, Literal

import numpy as np

from ..config import Config
from ..db import connect
from . import model_resolver, tags_service
from .events import EventBus

EMBEDDING_MODEL = "multilingual-e5-small"
EMBEDDING_DIM = 384
QUERY_PREFIX = "query: "
PASSAGE_PREFIX = "passage: "
BATCH_SIZE = 32
MAX_LENGTH = 512
CANDIDATES_LIMIT = 500
MODEL_FILE = "onnx/model_quantized.onnx"
TOKENIZER_FILE = "tokenizer.json"
SNIPPET_LIMIT = 400

log = logging.getLogger(__name__)

EncodeKind = Literal["query", "passage"]


class EmbeddingError(RuntimeError):
    """Ошибка загрузки модели или вычисления эмбеддингов."""


def _short_error(exc: BaseException) -> str:
    message = str(exc).strip().splitlines()[0] if str(exc).strip() else type(exc).__name__
    return message[:300]


def _module_present(name: str) -> bool:
    import importlib.util

    try:
        return importlib.util.find_spec(name) is not None
    except (ImportError, ValueError):  # pragma: no cover - сломанное окружение
        return False


class EmbeddingEncoder:
    """Ленивая загрузка onnxruntime + tokenizers; ``encode(texts, kind) -> [n, dim]``."""

    def __init__(self, model_dir: Path, threads: int = 2) -> None:
        self.model_dir = Path(model_dir)
        self.threads = max(1, int(threads))
        self._lock = threading.RLock()
        self._tokenizer: Any = None
        self._session: Any = None
        self._input_names: set[str] = set()
        self._detail: str | None = None
        self._load_failed = False

    @property
    def dim(self) -> int:
        return EMBEDDING_DIM

    @property
    def detail(self) -> str | None:
        with self._lock:
            return self._detail

    @property
    def available(self) -> bool:
        """Модель пригодна к использованию (файлы + зависимости; загрузка — ленивая)."""
        with self._lock:
            if self._load_failed:
                return False
            if self._session is not None:
                return True
            if not self._files_present():
                self._detail = f"Файлы модели эмбеддингов не найдены: {self.model_dir}"
                return False
            missing = [name for name in ("onnxruntime", "tokenizers") if not _module_present(name)]
            if missing:
                self._load_failed = True
                self._detail = f"Не установлены зависимости: {', '.join(missing)}"
                return False
            return True

    def _files_present(self) -> bool:
        return (self.model_dir / TOKENIZER_FILE).is_file() and (
            self.model_dir / MODEL_FILE
        ).is_file()

    def _ensure_loaded(self) -> None:
        if self._session is not None:
            return
        if self._load_failed:
            raise EmbeddingError(self._detail or "Модель эмбеддингов недоступна")
        if not self._files_present():
            self._detail = f"Файлы модели эмбеддингов не найдены: {self.model_dir}"
            raise EmbeddingError(self._detail)
        try:
            import onnxruntime as ort
            from tokenizers import Tokenizer
        except Exception as exc:  # pragma: no cover - зависимости из requirements-ml
            self._load_failed = True
            self._detail = f"onnxruntime/tokenizers недоступны: {_short_error(exc)}"
            raise EmbeddingError(self._detail) from exc
        try:
            tokenizer = Tokenizer.from_file(str(self.model_dir / TOKENIZER_FILE))
            tokenizer.enable_padding()
            tokenizer.enable_truncation(max_length=MAX_LENGTH)
            options = ort.SessionOptions()
            options.intra_op_num_threads = self.threads
            options.inter_op_num_threads = 1
            options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
            session = ort.InferenceSession(
                str(self.model_dir / MODEL_FILE),
                sess_options=options,
                providers=["CPUExecutionProvider"],
            )
        except Exception as exc:
            self._load_failed = True
            self._detail = f"Не удалось загрузить модель эмбеддингов: {_short_error(exc)}"
            log.warning("Embedding model load failed: %s", _short_error(exc))
            raise EmbeddingError(self._detail) from exc
        self._tokenizer = tokenizer
        self._session = session
        self._input_names = {item.name for item in session.get_inputs()}
        self._detail = None

    def encode(self, texts: list[str], *, kind: EncodeKind) -> np.ndarray:
        if kind not in ("query", "passage"):
            raise EmbeddingError(f"Неизвестный вид эмбеддинга: {kind}")
        cleaned = [(text or "").strip() for text in texts]
        if not cleaned:
            return np.zeros((0, self.dim), dtype=np.float32)
        prefix = QUERY_PREFIX if kind == "query" else PASSAGE_PREFIX
        with self._lock:
            self._ensure_loaded()
            try:
                encodings = self._tokenizer.encode_batch([prefix + text for text in cleaned])
                length = max(len(encoding.ids) for encoding in encodings)
                input_ids = np.zeros((len(encodings), length), dtype=np.int64)
                attention_mask = np.zeros((len(encodings), length), dtype=np.int64)
                for index, encoding in enumerate(encodings):
                    ids = encoding.ids
                    input_ids[index, : len(ids)] = ids
                    attention_mask[index, : len(ids)] = encoding.attention_mask
                feeds: dict[str, np.ndarray] = {
                    "input_ids": input_ids,
                    "attention_mask": attention_mask,
                }
                if "token_type_ids" in self._input_names:
                    feeds["token_type_ids"] = np.zeros_like(input_ids)
                hidden = self._session.run(None, feeds)[0]
            except Exception as exc:
                self._detail = f"Ошибка эмбеддингов: {_short_error(exc)}"
                log.warning("Embedding inference failed: %s", self._detail)
                raise EmbeddingError(self._detail) from exc
            weights = attention_mask[..., None].astype(np.float32)
            pooled = (hidden * weights).sum(axis=1) / np.clip(weights.sum(axis=1), 1e-9, None)
            norms = np.linalg.norm(pooled, axis=1, keepdims=True)
            return (pooled / np.clip(norms, 1e-12, None)).astype(np.float32)


class SemanticIndexManager:
    """Индексация сегментов и векторный поиск; деградирует без исключений."""

    def __init__(
        self,
        config: Config,
        bus: EventBus,
        encoder: EmbeddingEncoder | None = None,
    ) -> None:
        self.config = config
        self.bus = bus
        self._encoder_explicit = encoder is not None
        self._encoder_lock = threading.RLock()
        if encoder is not None:
            self.encoder = encoder
        else:
            # M13/D-13.9: data dir → legacy resources → fallback на старый путь
            # (доступность проверяет сам EmbeddingEncoder, поиск деградирует в FTS).
            self.encoder = self._create_encoder()
        self.model = config.embedding_model_name
        self.dim = int(getattr(self.encoder, "dim", config.embedding_dim))
        self._state_lock = threading.RLock()
        self._cache_lock = threading.RLock()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._indexing = False
        self._worker_detail: str | None = None
        self._revision = 0
        self._cache_ids: np.ndarray | None = None
        self._cache_matrix: np.ndarray | None = None
        self._cache_revision = -1

    # ---------- статус и жизненный цикл ----------

    def status(self, conn: sqlite3.Connection) -> dict[str, Any]:
        available = self._available()
        indexed = _count(
            conn, "SELECT COUNT(*) FROM segment_embeddings WHERE model = ?", (self.model,)
        )
        total = _count(conn, "SELECT COUNT(*) FROM segments")
        with self._state_lock:
            indexing = self._indexing
            worker_detail = self._worker_detail
        encoder_detail = self._encoder_detail()
        detail = encoder_detail or worker_detail
        if not available and not detail:
            detail = "Семантика недоступна"
        return {
            "available": available,
            "model": self.model,
            "dim": self.dim,
            "indexed_segments": indexed,
            "total_segments": total,
            "indexing": indexing,
            "autoindex": bool(self.config.embedding_autoindex),
            "detail": detail,
        }

    def start(self) -> None:
        """Фоновая доиндексация пропусков при старте (не блокирует запуск)."""
        if not self.config.embedding_autoindex:
            return
        with self._state_lock:
            if self._indexing or (self._thread is not None and self._thread.is_alive()):
                return
            self._indexing = True
            self._stop.clear()
            self._thread = threading.Thread(
                target=self._autoindex_worker, name="embedding-autoindex", daemon=True
            )
            self._thread.start()

    def shutdown(self) -> None:
        self._stop.set()
        with self._state_lock:
            thread = self._thread
        if thread is not None and thread.is_alive():
            thread.join(timeout=5)

    def _autoindex_worker(self) -> None:
        detail: str | None = None
        try:
            if not self._available():
                detail = self._encoder_detail()
                return
            result = self.index_missing()
            detail = result.get("detail")
            if detail is None:
                with self._state_lock:
                    self._worker_detail = None
        except Exception:  # pragma: no cover - index_missing сам не бросает
            log.exception("Automatic semantic indexing failed")
            detail = "Ошибка автоиндексации"
            self._worker_detail = detail
        finally:
            with self._state_lock:
                self._indexing = False
            self._publish_state("idle", detail)

    # ---------- индексация ----------

    def index_video(self, video_id: int) -> int:
        """Синхронно доиндексирует сегменты одного видео; ошибки только логируются."""
        try:
            self._refresh_encoder()
            conn = connect(self.config.db_path)
            try:
                rows = conn.execute(
                    "SELECT s.id, s.text FROM segments s "
                    "LEFT JOIN segment_embeddings e "
                    "ON e.segment_id = s.id AND e.model = ? "
                    "WHERE s.video_id = ? AND e.segment_id IS NULL ORDER BY s.id",
                    (self.model, int(video_id)),
                ).fetchall()
                if not rows:
                    return 0
                return self._encode_and_store(conn, rows)
            finally:
                conn.close()
        except Exception:
            log.exception("Semantic indexing failed for video %s", video_id)
            self._worker_detail = f"Ошибка индексации видео {video_id}"
            return 0

    def index_missing(self, *, force: bool = False) -> dict[str, Any]:
        """Индексирует все сегменты без эмбеддинга текущей модели (или все при force)."""
        conn = connect(self.config.db_path)
        try:
            if force:
                rows = conn.execute("SELECT id, text FROM segments ORDER BY id").fetchall()
            else:
                rows = conn.execute(
                    "SELECT s.id, s.text FROM segments s "
                    "LEFT JOIN segment_embeddings e "
                    "ON e.segment_id = s.id AND e.model = ? "
                    "WHERE e.segment_id IS NULL ORDER BY s.id",
                    (self.model,),
                ).fetchall()
            total = len(rows)
            if not self._available():
                detail = self._encoder_detail()
                self._publish_state("idle", detail)
                return {"indexed": 0, "total": total, "detail": detail}
            self._publish_state("indexing", None)
            self._publish_progress(0, total)
            indexed = 0
            try:
                for offset in range(0, total, BATCH_SIZE):
                    if self._stop.is_set():
                        break
                    batch = rows[offset : offset + BATCH_SIZE]
                    vectors = self.encoder.encode(
                        [row["text"] or "" for row in batch], kind="passage"
                    )
                    self._upsert(conn, batch, vectors)
                    conn.commit()
                    indexed += len(batch)
                    self._invalidate_cache()
                    self._publish_progress(indexed, total)
            except Exception as exc:
                self._worker_detail = f"Ошибка индексации: {_short_error(exc)}"
                log.exception("Semantic indexing failed")
                self._publish_state("idle", self._worker_detail)
                return {"indexed": indexed, "total": total, "detail": self._worker_detail}
            self._publish_state("idle", None)
            return {"indexed": indexed, "total": total}
        finally:
            conn.close()

    def start_reindex(self, *, force: bool = False) -> dict[str, Any]:
        """Запускает фоновую переиндексацию; возвращает статус для 202-ответа."""
        conn = connect(self.config.db_path)
        try:
            status = self.status(conn)
        finally:
            conn.close()
        if not status["available"]:
            return {"state": "idle", **status}
        with self._state_lock:
            if not self._indexing:
                self._indexing = True
                self._stop.clear()
                self._thread = threading.Thread(
                    target=self._reindex_worker,
                    args=(force,),
                    name="embedding-reindex",
                    daemon=True,
                )
                self._thread.start()
            status["indexing"] = True
        return {"state": "indexing", **status}

    def _reindex_worker(self, force: bool) -> None:
        detail: str | None = None
        try:
            result = self.index_missing(force=force)
            detail = result.get("detail")
            if detail is None:
                with self._state_lock:
                    self._worker_detail = None
        except Exception:  # pragma: no cover - index_missing сам не бросает
            log.exception("Semantic reindex failed")
            detail = "Ошибка переиндексации"
            self._worker_detail = detail
        finally:
            with self._state_lock:
                self._indexing = False
            self._publish_state("idle", detail)

    # ---------- поиск ----------

    def search(
        self,
        conn: sqlite3.Connection,
        query: str,
        *,
        video_id: int | None = None,
        tag_ids: list[int] | None = None,
        tag_mode: str = "any",
        include_children: bool = True,
        file_prefix: str | None = None,
        limit: int = 20,
    ) -> list[dict[str, Any]]:
        """Top-N семантических сегментов; при любой ошибке — ``[]`` (деградация)."""
        try:
            text = (query or "").strip()
            if not text or limit <= 0:
                return []
            if not self._available():
                return []
            query_vector = np.asarray(
                self.encoder.encode([text], kind="query")[0], dtype=np.float32
            )
            if query_vector.shape[0] != self.dim:
                raise EmbeddingError("Размерность вектора запроса не совпадает с индексом")
            rows = self._candidate_rows(
                conn,
                video_id=video_id,
                tag_ids=tag_ids,
                tag_mode=tag_mode,
                include_children=include_children,
                file_prefix=file_prefix,
            )
            if not rows:
                return []
            ids, matrix = self._matrix(conn)
            if ids.size == 0 or matrix.size == 0:
                return []
            candidate_ids = np.fromiter(
                (int(row["id"]) for row in rows), dtype=np.int64, count=len(rows)
            )
            positions = np.searchsorted(ids, candidate_ids)
            clipped = np.clip(positions, 0, ids.size - 1)
            found = ids[clipped] == candidate_ids
            if not found.any():
                return []
            selected = matrix[clipped[found]]
            scores = selected @ query_vector
            candidates = [rows[int(index)] for index in np.nonzero(found)[0]]
            video_keys = np.fromiter(
                (int(row["video_id"]) for row in candidates), dtype=np.int64, count=len(candidates)
            )
            start_keys = np.fromiter(
                (int(row["start_ms"]) for row in candidates), dtype=np.int64, count=len(candidates)
            )
            order = np.lexsort((start_keys, video_keys, -scores))
            items: list[dict[str, Any]] = []
            for index in order[: min(int(limit), CANDIDATES_LIMIT)]:
                row = candidates[int(index)]
                snippet_text = (row["text"] or "")[:SNIPPET_LIMIT]
                items.append(
                    {
                        "kind": "segment",
                        "video_id": int(row["video_id"]),
                        "video_title": row["video_title"] or "",
                        "segment_id": int(row["id"]),
                        "start_ms": int(row["start_ms"]),
                        "end_ms": int(row["end_ms"]),
                        "text": snippet_text,
                        "snippet_html": html.escape(snippet_text, quote=False),
                        "score": round(float(scores[int(index)]), 4),
                        "semantic": True,
                    }
                )
            return items
        except Exception:
            log.exception("Semantic search failed; degrading to empty result")
            return []

    # ---------- внутреннее ----------

    def _encode_and_store(self, conn: sqlite3.Connection, rows: list[Any]) -> int:
        indexed = 0
        for offset in range(0, len(rows), BATCH_SIZE):
            if self._stop.is_set():
                break
            batch = rows[offset : offset + BATCH_SIZE]
            vectors = self.encoder.encode([row["text"] or "" for row in batch], kind="passage")
            self._upsert(conn, batch, vectors)
            conn.commit()
            indexed += len(batch)
            self._invalidate_cache()
        return indexed

    def _upsert(
        self, conn: sqlite3.Connection, rows: list[Any], vectors: np.ndarray
    ) -> None:
        matrix = np.asarray(vectors, dtype=np.float32)
        if matrix.ndim != 2 or matrix.shape[0] != len(rows):
            raise EmbeddingError("Число векторов не совпадает с числом сегментов")
        if matrix.shape[1] != self.dim:
            raise EmbeddingError(
                f"Неверная размерность эмбеддинга: {matrix.shape[1]} вместо {self.dim}"
            )
        conn.executemany(
            "INSERT INTO segment_embeddings(segment_id, model, dim, vector) "
            "VALUES (?, ?, ?, ?) "
            "ON CONFLICT(segment_id) DO UPDATE SET model = excluded.model, "
            "dim = excluded.dim, vector = excluded.vector, "
            "updated_at = CURRENT_TIMESTAMP",
            [
                (int(row["id"]), self.model, int(matrix.shape[1]), vector.tobytes())
                for row, vector in zip(rows, matrix, strict=True)
            ],
        )

    def _candidate_rows(
        self,
        conn: sqlite3.Connection,
        *,
        video_id: int | None,
        tag_ids: list[int] | None,
        tag_mode: str,
        include_children: bool,
        file_prefix: str | None,
    ) -> list[Any]:
        where = ["1=1"]
        params: list[Any] = [self.model]
        if video_id is not None:
            where.append("s.video_id = ?")
            params.append(int(video_id))
        if file_prefix:
            where.append("LOWER(v.title) LIKE ?")
            params.append(f"%{file_prefix.lower()}%")
        effective = list(tag_ids or [])
        if include_children and effective:
            effective = tags_service.descendant_ids(conn, effective)
        if effective:
            placeholders = ",".join("?" for _ in effective)
            params.extend(effective)
            if tag_mode == "all":
                where.append(
                    f"(SELECT COUNT(DISTINCT st.tag_id) FROM segment_tags st "
                    f"WHERE st.segment_id = s.id AND st.tag_id IN ({placeholders})) = ?"
                )
                params.append(len(effective))
            else:
                where.append(
                    f"EXISTS (SELECT 1 FROM segment_tags st WHERE st.segment_id = s.id "
                    f"AND st.tag_id IN ({placeholders}))"
                )
        sql = (
            "SELECT s.id, s.video_id, s.start_ms, s.end_ms, s.text, "
            "v.title AS video_title "
            "FROM segments s "
            "JOIN videos v ON v.id = s.video_id "
            "JOIN segment_embeddings e ON e.segment_id = s.id AND e.model = ? "
            f"WHERE {' AND '.join(where)} ORDER BY s.id"
        )
        return conn.execute(sql, params).fetchall()

    def _matrix(self, conn: sqlite3.Connection) -> tuple[np.ndarray, np.ndarray]:
        with self._cache_lock:
            if (
                self._cache_ids is not None
                and self._cache_matrix is not None
                and self._cache_revision == self._revision
            ):
                return self._cache_ids, self._cache_matrix
            rows = conn.execute(
                "SELECT segment_id, vector FROM segment_embeddings "
                "WHERE model = ? ORDER BY segment_id",
                (self.model,),
            ).fetchall()
            ids = np.fromiter(
                (int(row["segment_id"]) for row in rows), dtype=np.int64, count=len(rows)
            )
            if rows:
                matrix = np.vstack(
                    [np.frombuffer(row["vector"], dtype=np.float32) for row in rows]
                )
                if matrix.shape[1] != self.dim:
                    raise EmbeddingError(
                        f"Индекс повреждён: размерность {matrix.shape[1]} вместо {self.dim}"
                    )
            else:
                matrix = np.zeros((0, self.dim), dtype=np.float32)
            self._cache_ids = ids
            self._cache_matrix = matrix
            self._cache_revision = self._revision
            return ids, matrix

    def _invalidate_cache(self) -> None:
        with self._cache_lock:
            self._revision += 1
            self._cache_ids = None
            self._cache_matrix = None
            self._cache_revision = -1

    def _create_encoder(self) -> EmbeddingEncoder:
        model_dir = model_resolver.resolve_embedding(self.config) or self.config.embedding_model_dir
        return EmbeddingEncoder(model_dir, self.config.embedding_threads)

    def _refresh_encoder(self) -> None:
        """M13: модель могла быть скачана/удалена после старта приложения."""
        if self._encoder_explicit:
            return
        try:
            model_dir = model_resolver.resolve_embedding(self.config)
        except Exception:  # pragma: no cover - резолвер не должен бросать
            log.exception("Embedding model resolution failed")
            return
        if model_dir is None:
            return
        with self._encoder_lock:
            current = getattr(self.encoder, "model_dir", None)
            if current is not None and Path(current) == Path(model_dir):
                return
            self.encoder = EmbeddingEncoder(model_dir, self.config.embedding_threads)
            self.dim = int(getattr(self.encoder, "dim", self.config.embedding_dim))

    def _available(self) -> bool:
        try:
            self._refresh_encoder()
            return bool(self.encoder.available)
        except Exception:
            log.exception("Embedding availability check failed")
            return False

    def _encoder_detail(self) -> str | None:
        try:
            return getattr(self.encoder, "detail", None)
        except Exception:  # pragma: no cover - detail не должен бросать
            return None

    def _publish(self, event_type: str, payload: dict[str, Any]) -> None:
        try:
            self.bus.publish_threadsafe(event_type, payload)
        except Exception:  # pragma: no cover - SSE не должен ломать индексацию
            log.warning("Failed to publish %s", event_type, exc_info=True)

    def _publish_progress(self, indexed: int, total: int) -> None:
        percent = 100 if total <= 0 else int(round(indexed * 100 / total))
        self._publish("embedding.progress", {"indexed": indexed, "total": total, "percent": percent})

    def _publish_state(self, state: str, detail: str | None) -> None:
        self._publish("embedding.state", {"state": state, "detail": detail})


def _count(conn: sqlite3.Connection, sql: str, params: tuple[Any, ...] = ()) -> int:
    row = conn.execute(sql, params).fetchone()
    return int(row[0]) if row else 0


__all__ = [
    "BATCH_SIZE",
    "CANDIDATES_LIMIT",
    "EMBEDDING_DIM",
    "EMBEDDING_MODEL",
    "EmbeddingEncoder",
    "EmbeddingError",
    "PASSAGE_PREFIX",
    "QUERY_PREFIX",
    "SemanticIndexManager",
]
