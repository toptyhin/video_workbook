# 12. Семантический (векторный) поиск по транскрибации

> Статус: **реализован** (M12, сверх `TARGET.md`; связан с M4 «Поиск»). Доказательства — `PLAN.md` §15, `docs/acceptance.md`.
> Контракты ниже обязательны для backend/frontend исполнителей. Требование пользователя:
> основная задача — **русский язык**; дополнительно исправить перекрытие окна результатов
> поиска вкладками «Файлы/Метки».

## 1. Задача и решение

Сейчас поиск по транскрибации — только лексический FTS5 (`segments_fts`, bm25): нет морфологии
и синонимов («производная» ≠ «производные»). Нужен **векторный поиск по сегментам транскрибации**
+ гибридный режим (FTS + вектора), локально и офлайн.

### Решения (зафиксировано)

| Аспект | Решение | Обоснование |
|---|---|---|
| Модель эмбеддингов | **`intfloat/multilingual-e5-small`**, ONNX int8 (`Xenova/multilingual-e5-small`), 384 измерения | Сильная многоязычная retrieval-модель, хорошие результаты на русском (MTEB multilingual); ~118 МБ + 17 МБ tokenizer; e5 требует префиксов `query: ` / `passage: `. Не нужен torch/sentence-transformers (только `onnxruntime` + `tokenizers`, уже есть транзитивно от faster-whisper) |
| Inference | ONNX Runtime CPU, mean-pooling по `last_hidden_state` с attention mask, L2-нормализация; батчи по 32; `max_length=512` | ~0.2 с загрузка, ~0.06 с на 64 сегмента в dev; CPU-потоки `VL_EMBED_THREADS` (default 2) |
| Хранение векторов | SQLite-таблица `segment_embeddings` (BLOB float32, модель, dim), каскад от `segments`; **без sqlite-vec** | Нет новой бинарной зависимости/хука PyInstaller; брутфорс-косинус по матрице numpy для локальной библиотеки (до ~10⁵ сегментов) — миллисекунды; кэш матрицы в памяти |
| Индексация | Автоматически после транскрипции (`queue._store_result` → `SemanticIndexManager.index_video`), inline (быстро) + фоновая индексация пропусков при старте (`VL_EMBED_AUTOINDEX=1` по умолчанию) + `POST /api/search/semantic/reindex` | Пользователю не нужно ничего нажимать; старые видео доиндексируются в фоне |
| Режимы поиска | API `mode=fts|semantic|hybrid`; **API default = `fts`** (обратная совместимость), **UI default = `hybrid`**, если семантика доступна, иначе `fts` | гибрид = FTS + вектора через Reciprocal Rank Fusion (k=60) |
| Семантика и scope | Векторный поиск — только по **сегментам** транскрибации; в `mode=hybrid` файлы/метки идут лексически, сегменты — гибридно | Именно транскрибация — требование |
| Модель в поставке | `resources/models/multilingual-e5-small-onnx/` (gitignored), скрипт `scripts/fetch-embed-model.sh`; в `.deb` попадает с `resources/models` | Как whisper-модели; офлайн-рантайм |
| Отказ/нет модели | Семантика `available=false` c `detail`; API откатывается на `mode_used=fts`; UI дизейблит режимы с пояснением | Приложение не ломается без модели/onnxruntime |
| Ошибка эмбеддингов | Логируется; транскрипция всё равно `done`; поиск продолжает работать лексически | Некритичная подсистема |

### Выбор модели (русский язык) — обоснование

- `multilingual-e5-small` обучена на многоязычных парах (ru присутствует), retrieval-ориентирована,
  работает с mixed ru/en терминами (типично для лекций: «производная», «Python», «API»).
- Проверено в dev: запрос «как найти производную сложной функции» → пассаж про производную (cos 0.871)
  выше математически близкого «квадратного уравнения» (0.813); «древний Рим республика» → 0.890.
- Альтернативы отклонены: `rubert-tiny2` — только русский и слабее в retrieval; `ru-en-RoSBERTa` —
  ~1.6 ГБ fp32/сотни МБ int8 и тяжелее для CPU; sentence-transformers → тянет torch (~800 МБ) в поставку.
- ONNX int8 даёт ~130 МБ на диске, загрузка 0.2 с, индексация 64 сегментов ~0.06 с (dev CPU).
- Лицензия модели — MIT (`intfloat/multilingual-e5-small`; ONNX-экспорт `Xenova/...`), добавить в
  `resources/THIRD-PARTY-NOTICES.md`.

## 2. Данные

`Config`:
- `embedding_model_dir = VL_EMBEDDING_MODEL_DIR` или `resources/models/multilingual-e5-small-onnx`;
- `embedding_model_name = "multilingual-e5-small"`, `embedding_dim = 384`;
- `embedding_autoindex = env VL_EMBED_AUTOINDEX != "0"` (тесты выставляют `0`).
- окружение: `VL_EMBED_THREADS` (default 2).

Миграция `backend/app/migrations/009_segment_embeddings.sql`:

```sql
CREATE TABLE IF NOT EXISTS segment_embeddings (
  segment_id INTEGER PRIMARY KEY REFERENCES segments(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  dim INTEGER NOT NULL,
  vector BLOB NOT NULL,              -- float32, L2-нормированный
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_segment_embeddings_model ON segment_embeddings(model);
```

Инварианты: `dim = len(vector)/4`; `vector` — L2-нормированный float32; эмбеддинг удаляется каскадом
вместе с сегментом (повторная транскрипция/удаление видео). Версия схемы становится **9**.

## 3. Backend

### 3.1. `backend/app/services/embeddings.py`

```python
EMBEDDING_MODEL = "multilingual-e5-small"
EMBEDDING_DIM = 384
QUERY_PREFIX = "query: "
PASSAGE_PREFIX = "passage: "

class EmbeddingError(RuntimeError): ...

class EmbeddingEncoder:
    """Ленивая загрузка onnxruntime + tokenizers; encode(texts, kind) -> np.ndarray [n, 384]."""
    def __init__(self, model_dir: Path, threads: int = 2): ...
    @property
    def available(self) -> bool: ...
    @property
    def detail(self) -> str | None: ...
    def encode(self, texts: list[str], *, kind: Literal["query", "passage"]) -> np.ndarray: ...

class SemanticIndexManager:
    def __init__(self, config: Config, bus: EventBus, encoder: EmbeddingEncoder | None = None): ...
    def status(self, conn) -> dict: ...
    def start(self) -> None                         # фоновый автоиндекс, если доступно и autoindex
    def shutdown(self) -> None
    def index_video(self, video_id: int) -> int     # sync, вызывается queue после транскрипции
    def index_missing(self, *, force: bool = False) -> dict
    def start_reindex(self, *, force: bool = False) -> dict   # фоновый поток -> 202
    def search(self, conn, query: str, *, video_id: int | None, tag_ids: list[int],
               tag_mode: str, include_children: bool,
               file_prefix: str | None, limit: int) -> list[dict]  # semantic segment items
```

- `status(conn)` → `{available, model, dim, indexed_segments, total_segments, indexing, autoindex, detail}`;
  `indexed_segments` — по текущей модели; `total_segments` — все сегменты.
- `encode`: tokenizer `tokenizer.json`, `padding=true`, truncation 512; inputs `input_ids`,
  `attention_mask`, `token_type_ids` (если объявлен); mean-pool; normalize. Модель
  `model_dir/onnx/model_quantized.onnx`; кэш энкодера; lock.
- `search`: SQL-кандидаты (join `segments`/`videos`, фильтры `video_id`, `file_prefix`, теги с
  `include_children`); загрузка векторов; кэш матрицы (revision инкрементится при индексации);
  `cos = E @ q`; top-N (≤500), `score=round(cos,4)`; item идентичен segment-kind + `semantic=True`;
  `snippet_html = html.escape(text[:400])` (без `<mark>`); никаких исключений наружу — при ошибке
  вернуть `[]` + залогировать (поиск деградирует).
- `index_video`: сегменты видео без актуальной модели → encode батчами 32 → upsert, commit.
- `index_missing(force=False)`: все сегменты без эмбеддинга текущей модели (force — все заново);
  публикует SSE `embedding.progress {indexed,total,percent}` и `embedding.state {state:'indexing'|'idle'}`.
- `start_reindex`: поток-демон, один одновременно (`indexing`), ошибки → `detail` + лог, затем idle.
- `start()`: если `autoindex` и модель доступна — фоновый поток индексирует пропуски (не блокирует старт).
- `stop` — `threading.Event`, join с таймаутом.
- Потокобезопасность: RLock вокруг энкодера/кэша/статуса; запись в БД в отдельных соединениях.

### 3.2. `queue.py`

`TranscriptionQueue.__init__(config, bus, embeddings: SemanticIndexManager | None = None)`.
После `_store_result` (commit, статус `done`, SSE): `self.embeddings.index_video(video_id)` в try/except
(ошибка — warning, статус видео не меняется). Запуск/остановка manager — в `main.py` lifespan;
`app.state.embeddings = embeddings`.

### 3.3. `search_service.py` + `routers/search.py`

`search(..., mode: str = "fts", semantic=None)`:
- `mode ∈ {fts, semantic, hybrid}`, иначе `SearchError("invalid_mode", ..., 422)`.
- FTS-часть — как сейчас (`_files/_segments/_annotations`), при `mode != "fts"` тоже нужна для hybrid.
- `semantic_items = semantic.search(...)` при `mode in {semantic, hybrid}`, `scope in {all, segments}`,
  `semantic.status()["available"]`; иначе `[]`.
- `mode_used`: фактический режим (если семантика недоступна → `fts`; для scope files/annotations
  semantic-режим → `fts`).
- `semantic` в ответе `query`: `{available, model, indexed_segments, total_segments, indexing, detail}`.
- Merge:
  - `fts` — как сейчас;
  - `semantic` — только semantic_items (scope segments/all), сортировка по score;
  - `hybrid` — RRF: для каждого FTS-ранга и semantic-ранга `1/(60+rank+1)`; дедуп по
    (`kind`, id); при совпадении полей берётся FTS-item + `semantic=True`; сортировка по
    `(-score, KIND_ORDER, video_id, start_ms)`; `total` = число уникальных.
- `limit/offset` — после merge; `query.took_ms` как сейчас.
- Эндпоинты:
  - `GET /api/search/semantic/status` → `status()`;
  - `POST /api/search/semantic/reindex` body `{force?: bool}` → `202 {state:"indexing", **status}`;
- SSE (A5): `embedding.progress {indexed,total,percent}`, `embedding.state {state, detail}`.

### 3.4. Зависимости

`backend/requirements-ml.txt`: явно `onnxruntime>=1.17,<2.0`, `tokenizers>=0.15,<1.0`, `numpy>=1.24`
(фактически уже стоят транзитивно; явно — для воспроизводимости). `packaging/backend.spec`:
в `collect_all` добавить `onnxruntime` (и при необходимости `tokenizers` уже есть) — проверить сборку.
`backend/tests/conftest.py`: `monkeypatch.setenv("VL_EMBED_AUTOINDEX", "0")` в фикстуре `config`
(детерминизм тестов; явные семантические тесты включают индекс вручную).

## 4. Frontend

### 4.1. Контракты (types/client/searchStore)

```ts
export type SearchMode = 'fts' | 'semantic' | 'hybrid';

export interface SemanticStatus {
  available: boolean;
  model: string;
  dim: number;
  indexed_segments: number;
  total_segments: number;
  indexing: boolean;
  autoindex: boolean;
  detail: string | null;
}

export interface SearchQueryEcho {
  raw: string; fts: string | null; scope: SearchScope;
  prefixes: { tags: string[]; file: string | null };
  mode?: SearchMode; mode_used?: SearchMode; semantic?: SemanticStatus; took_ms?: number;
}
export interface SearchItemBase { ...; semantic?: boolean; }
export interface SearchParams { ...; mode?: SearchMode; }
```

`api.search` передаёт `mode`; `api.semanticStatus()`, `api.semanticReindex(force?)`.

`searchStore`: `mode` (localStorage `vl.search.mode`, default `'hybrid'`, при недоступности —
нормализуется в `fts`), `modeUsed`, `semantic: SemanticStatus | null`, `semanticLoading`;
`setMode(mode)` (persist + повторный поиск), `loadSemanticStatus()`, `reindexSemantic()`;
`runSearch` передаёт `mode`; после ответа — `semantic = response.query.semantic`, `modeUsed`;
`clear()` режим не сбрасывает. SSE `embedding.progress/state` → обновлять статус.

### 4.2. UI и исправление перекрытия

- **Починить перекрытие окна результатов**: сейчас `<SearchResults/>` рендерится *над* полосой
  вкладок «Файлы/Метки», из-за чего панель сжимается (`flex`), список обрезается, а последняя
  строка визуально упирается/перекрывается таб-баром. Решение:
  - `<SearchResults/>` переносится **под** `.vl-app__viewbar` и при активном поиске **заменяет**
    `.vl-app__list` (результаты получают всё оставшееся место); вкладки остаются сверху и больше
    ничего не перекрывают;
  - клик по вкладке «Файлы/Метки» при активном поиске очищает поиск (`searchStore.clear()`) и
    показывает обычный список; кнопка «×» в панели результатов делает то же;
  - `.vl-search { min-height: 0; overflow: hidden; }`, `.vl-search__list { flex: 1 1 auto;
    overflow-y: auto; }` — список скроллится внутри панели, ничего не обрезается;
  - e2e-проверка геометрии: `search.top >= viewbar.bottom`, панель внутри `.vl-app__main`,
    количество видимых строк равно числу результатов (без обрезания).
- В шапке `SearchResults` — переключатель режима: **Обычный / Семантика / Гибрид** (segmented
  buttons, `aria-pressed`), строка статуса: «Индексируется: X/Y», «Семантика недоступна: {detail}»,
  кнопка «Переиндексировать» (вызывает API, показывает прогресс через SSE/опрос).
  Недоступные режимы (`semantic`/`hybrid` без модели) дизейблятся с пояснением; `fts` доступен всегда.
  При выборе semantic/hybrid для scope `files/annotations` показывать подсказку, что семантика
  работает по сегментам (или автоматически использовать hybrid для всех scope).
- Элемент результата с `semantic=true` — маленький чип «семантика» (только визуальный маркер).

## 5. Тесты

### Backend (`backend/tests/test_m12_semantic_search.py`)

- fake-encoder (детерминированные векторы по ключевым словам, dim 8/16) через
  `SemanticIndexManager(encoder=...)`: индексация сегментов, `index_video`, каскадное удаление,
  upsert/force, `status`, `search` (косинус, top), гибридный RRF (порядок, дедуп, `semantic=True`),
  fallback при `available=false` (`mode_used=fts`), `invalid_mode` 422, scope files/annotations.
- API: `GET /api/search/semantic/status`, `POST /api/search/semantic/reindex` (202, статус),
  `GET /api/search?mode=...` (fake manager в `app.state.embeddings`), SSE события (если проверяемо).
- migration: версия 9, таблица `segment_embeddings` (обновить `test_m1_skeleton.py`).
- queue hook: после `_store_result` эмбеддинги записаны (fake manager).
- **Реальная модель** (skip, если `resources/models/multilingual-e5-small-onnx` отсутствует):
  проиндексировать 4 русских сегмента, запрос «как найти производную сложной функции» → топ-1
  «Производная сложной функции…», cos ≥ 0.8, dim 384; mixed ru/en запрос.
- e2e-server: `VL_EMBED_AUTOINDEX=1` (дефолт), модель берётся из `resources/`.

### Frontend (`vitest`)

- `searchStore`: mode persist/переключение/rerun, `mode` в api.search, `semantic` из ответа, fallback
  при недоступности, reindex.
- `SearchResults`: переключатель режимов (aria-pressed), disabled semantic/hybrid при unavailable,
  статус индексации, чип «семантика», существующие тесты kinds/open — зелёные.
- e2e: в `app.spec.ts` (или `e2e/semantic-search.spec.ts`):
  - после транскрипции lesson-03 дождаться `GET /api/search/semantic/status` `indexed_segments>0`;
    если `available=false` — `test.skip`;
  - переключить режим «Гибрид», scope «Сегменты», запрос «производные сложных функций» → результат
    `lesson-03.webm` с таймкодом; клик → seek;
  - геометрия: `.vl-search` начинается ниже `.vl-app__viewbar`, не пересекается с ним, строки видны.

## 6. Документация и поставка

- `docs/user-guide.md`: раздел «Семантический поиск» (режимы, что индексируется, требования к модели,
  индексация/переиндексация, ограничения, русский язык); исправление описания панели результатов.
- `docs/architecture.md`: модель, ONNX/mean-pooling, таблица `segment_embeddings`, RRF, SSE, миграция 009,
  отсутствие sqlite-vec и почему, модель в `resources/models`, размер +~130 МБ.
- `README.md`: возможности, размер `.deb`, `scripts/fetch-embed-model.sh`, тесты.
- `docs/acceptance.md`: M12-раздел с доказательствами (backend fake+real, e2e, замеры latency/size).
- `resources/THIRD-PARTY-NOTICES.md`: `multilingual-e5-small` (MIT), Xenova ONNX export.
- `scripts/fetch-embed-model.sh`: скачать `onnx/model_quantized.onnx`, `tokenizer.json`, `config.json`,
  `tokenizer_config.json` из `Xenova/multilingual-e5-small` в
  `resources/models/multilingual-e5-small-onnx/`; идемпотентно, проверка размера, без лишних зависимостей.
- `PLAN.md`: M12 в роадмапе/индексе/статусе; `plans/00-conventions.md`: API, SSE, миграция 009, ADR.

## 7. Риски и ограничения

| Риск | Митигация |
|---|---|
| Качество на русских лекциях ниже ожидаемого | retrieval-модель e5 multilingual + гибрид с FTS; настраиваемый `mode`; тест на реальной модели |
| CPU-нагрузка | int8 ONNX, 2 потока, батчи; 64 сегмента ≈ 0.06 с; индексация после транскрипции не блокирует UI (worker) |
| Размер поставки +130 МБ | как whisper-модели в `resources/models`; опционально: без модели приложение работает (FTS) |
| Рост БД | 1.5 КБ/сегмент (~150 КБ на 10-мин видео); каскадное удаление |
| Брутфорс по всем векторам | кэш матрицы + ограничение кандидатов фильтрами; при >10⁵ сегментов — sqlite-vec как развитие |
| Смена модели | `model`-колонка, переиндексация (кнопка/эндпоинт); старые вектора не смешиваются |

## 8. Разделение работ

| Владелец | Scope |
|---|---|
| Lead | `plans/12*`, `plans/00*`, `PLAN.md`, `scripts/fetch-embed-model.sh`, модель в resources, интеграция/финальная проверка, packaging-заметки |
| backend-vector | `backend/app/**`, `backend/tests/**` (embeddings, migration 009, search, queue, main, config, requirements-ml) |
| ui-search | `frontend/src/**` (search UI/store/types/client, App layout fix, CSS, i18n, frontend tests) |
| qa-docs | `e2e/**`, `scripts/e2e-server.sh`, `docs/**`, `README.md`, `resources/THIRD-PARTY-NOTICES.md`, финальный прогон |
