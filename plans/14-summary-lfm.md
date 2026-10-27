# 14. M14 — Иерархическое саммари (LFM2.5-350M-Thinking) и динамическая шкала детализации

> Статус: **реализован, rev2** (переделка по замечанию пользователя 2026-10-27; доказательства — `PLAN.md` §15, `docs/acceptance.md`, `docs/summary-eval.md`).
> Этап: M14 · Оценка: 9–10 дней (rev2) · Зависит от: M13 (загрузка моделей), M3 (сегменты), M5 (панель таймингов), M12 (паттерн фонового менеджера/SSE).
> Владелец: Lead.
>
> **Rev3 (по замечанию пользователя 2026-10-27).** Для блоков, которые модель отказалась делить, добавлено принудительное деление крупных блоков (порог `max(45 c, 18% длительности)`: force-SPLIT → мелкие чанки (~800 токенов) → fallback), проверка инвариантов «дети = непрерывное покрытие родителя» и отказ от невалидного split, промотирование гигантских top-level тем, детерминированная дедупликация title/description и чистый root «О чём видео + Темы». Это устраняет лист 3:39 из 4-минутного видео, который rev2 оставлял из-за `split=false`/fallback.
>
> **Изменение алгоритма (rev2).** Первая версия резала транскрибацию на произвольные окна 90–150 с и делала MAP/REDUCE по этим кускам. Пользователь потребовал иначе: сначала анализировать **весь текст** (при нехватке контекста — чанки, но с верхнеуровневым саммари), затем **рекурсивно делить на смысловые блоки** до отдельных строк, а шкалу детализации строить **по фактической глубине дерева конкретного видео**, а не фиксированно 0–4.

## 1. Цель и границы

Пользователь хочет читать саммари, управляя детализацией одним вертикальным ползунком в панели таймингов: максимум — дословные строки транскрибации, минимум — короткое верхнеуровневое саммари всего видео. Промежуточные положения — осмысленные блоки/подблоки, полученные иерархическим делением, а не нарезкой по времени.

**Что делает этап:**
- **Шаг 1 — OUTLINE:** анализ всей транскрибации: о чём видео (root summary) и на какие логические/смысловые блоки оно делится (2–8 блоков, полное покрытие, хронология). Если текст не влезает в контекст — contiguous-чанки по бюджету токенов, OUTLINE по каждому, затем MERGE chunk-саммари → единое верхнеуровневое саммари; top-level блоки собираются из чанков.
- **Шаг 2 — рекурсивный SPLIT:** для каждого блока модель решает, делится ли он по смыслу на подблоки. Если нет — блок-лист; если да — подблоки и рекурсия дальше, вплоть до отдельных строк. Блок, не влезающий в контекст, делится на чанки, по которым строится список подблоков (с сохранением родителя).
- **Шаг 3 — дерево и уровни:** узлы дерева сохраняются в БД; из глубины дерева материализуются уровни детализации (level 1 — самый подробный, `max_level` — корневое саммари). Шкала в UI показывает ровно столько детентов, сколько уровней реально получилось у этого видео.
- Фоновая генерация (`SummaryManager`), прогресс/отмена/ошибки через SSE, кэш per-model по `source_hash` + `model` + `prompt_version`, crash-recovery, compute-gate с транскрипцией.
- UI: динамическая шкала (`Дословно … Обзор`), блоки с заголовками/таймкодами, клик → seek, активный блок, метки между блоками.
- Обновление тестов/e2e/документации; реальные проверки на LFM2.5-350M и Qwen2.5-0.5B.

**Чего этап не делает (границы):**
- не делает ручное редактирование/перестановку блоков саммари (только перегенерация);
- не экспортирует саммари в отдельный файл;
- не индексирует саммари в поиске (FTS остаётся по сегментам);
- не обещает качество на языках, не заявленных моделью; не делает облачные вызовы;
- не выполняет генерацию без установленной модели (M13) — level 0 работает всегда;
- не запоминает уровень per-video (глобальный `localStorage` + клампинг по `max_level`).

## 2. Предусловия

| Предусловие | Проверка |
|---|---|
| M13: реестр моделей, `kind:"summary"`, загрузка/импорт | `GET /api/models` → `ready` у summary-модели |
| M3/M5: сегменты и панель таймингов | открыть видео → строки, seek |
| M12: паттерн менеджера/SSE | `embedding.progress/state` доходят до UI |
| `resources/llama/llama-cli` (pinned b11669) | `llama-cli --version` |
| Миграции 011/012 | `PRAGMA user_version = 12` |

## 3. Решения

### D-14.1. Модели: KoarAI LFM2.5-350M-Thinking — рекомендованная, Qwen2.5-0.5B — альтернатива

| Кандидат | Размер | Thinking | Лицензия | Роль |
|---|---|---|---|---|
| `KoarAI/LFM2.5-350M-Thinking` (GGUF Q4_K_M) | 219 МиБ | `<think>` | LFM Open License v1.0 (производная) | **Рекомендованная**/*default*, значок без предупреждений |
| `Qwen2.5-0.5B-Instruct` (GGUF Q4_K_M) | 469 МиБ | нет | Apache-2.0 | **Альтернатива**: лучше русский, без reasoning |

Обе устанавливаются одновременно; активная — `summary.model` (default `summary-lfm2.5-350m`), переключение без повторной загрузки; кэш/дерево per-model.

### D-14.2. Inference: llama.cpp, GBNF, `-sys`/`-p`

- pinned CPU-runtime b11669 в `resources/llama` (MIT), spawn на вызов, timeout 180 с, kill, вырезание `<think>`.
- `--json-schema` в сборке падает → **GBNF `--grammar-file`** для OUTLINE/SPLIT/MERGE; инструкция — `-sys`, данные — `-p`, `-st`, `-rea off`.
- Fake-режим `VL_SUMMARY_FAKE=1` для тестов/e2e.

### D-14.3. Иерархическая декомпозиция (ядро rev2)

**a) OUTLINE всего текста.** Оценка входа `chars/3.5`, бюджет ≈1800–2200 токенов.
- Если влезает: один вызов; JSON `{summary, blocks:[{segment_ids,title,summary}]}`; `blocks` — 2–8 логических блоков, покрытие всех сегментов по порядку, без пропусков/пересечений.
- Если не влезает: contiguous-чанки по сегментам в пределах бюджета (без нарезки посередине сегмента); OUTLINE по каждому чанку; top-level `blocks` = объединение блоков чанков по порядку; `root_summary` = MERGE по chunk-саммари (при >8 чанках — иерархический MERGE группами). Верхнеуровневое саммари создаётся **всегда**.

**b) Рекурсивный SPLIT.** Для каждого блока (title/summary + его сегменты) модель отвечает `{split:false}` либо `{split:true, blocks:[{segment_ids,title,summary}]}`:
- деление только по смыслу, не по времени и не по количеству строк; полное покрытие без пересечений;
- если сегментов ≤ 2, или `depth ≥ MAX_DEPTH (8)`, или `split=false`, или вернулся 1 блок — узел становится листом; summary листа — аккуратный текст его сегментов (без LLM);
- если блок не влезает в контекст — чанки внутри блока + OUTLINE по чанкам; дети = объединение их блоков, рекурсия по детям;
- лимиты: `MAX_NODES` (250), `MAX_LLM_CALLS`, таймауты; repair 1 раз → эвристический fallback (деление по границе предложения/пополам), дерево всегда валидно.

**c) Дерево.** Root depth 0 (`node_id="0"`), дети `0.1`, `0.1.2`, …; поля `parent_id`, `depth`, `order_idx`, `segment_ids`, `start_ms/end_ms` (вычисляются из id), `title`, `summary`, `children_count`. Покрытие: каждый сегмент ровно в одном листе.

### D-14.4. Динамические уровни детализации

- `max_depth` = максимальная глубина листьев; `max_level = max_depth + 1` (минимум 1, если корень атомарен).
- `level 1` — самый подробный: узлы глубины `max_depth` (листья/группы строк);
  `level k` — узлы глубины `max_depth − (k−1)`;
  `level max_level` — **один корневой блок** с `root_summary`.
- Метки уровней (по фактической структуре): `max_level` — «Обзор», уровень верхних блоков — «Темы», `level 1` — «Подробно», промежуточные — «Средне»/«Кратко»; уровень 0 в UI — «Дословно» (сегменты, не генерируется).
- Шкала рисует `max_level+1` детентов; при смене видео/`max_level` сохранённый уровень клампится.

### D-14.5. Промпты и thinking

- `PROMPT_VERSION = 2`: OUTLINE_SYSTEM, OUTLINE_CHUNK_SYSTEM, MERGE_SYSTEM, SPLIT_SYSTEM (ru, без примеров-заглушек; запрет выдумывать id/факты; «дели только по смыслу»).
- JSON валидируется схемой и парсером; реальный вывод ограничен GBNF.
- Thinking: `summary.thinking=auto|off`; structured-стадии запускаются с `-rea off`, `<think>` вырезается и не сохраняется.

### D-14.6. Хранение и инвалидация

- Миграция `012_summary_tree.sql`: `summary_nodes` (дерево), `summary_levels` (level,label,blocks), `summary_jobs.max_level`; старый кэш MAP удаляется (это кэш).
- `source_hash = sha256(сегменты + model + prompt_version + параметры)`. При несовпадении — `stale`, перегенерация по запросу; переобработка/удаление видео — каскад; «зависшие» outlining/splitting/summarizing при старте → `error` («generation interrupted»), повтор по кнопке.
- Переключение модели не удаляет дерево другой модели.

### D-14.7. Фоновый менеджер и прогресс

`SummaryManager` (один worker, один job, очередь): compute-gate (`TranscriptionQueue.is_idle()`), `VL_SUMMARY_THREADS` (default 4), автозапуск после `video.status=done` при `summary.auto`, иначе — по кнопке. Этапы прогресса: `outline` (0/1 или чанки), `splitting` (`done`/`total` растёт по мере открытия детей), `summarizing`/финализация; SSE `summary.progress` ≤4/с, `summary.state`. Ошибки не ломают транскрипцию/поиск/плеер.

### D-14.8. API, SSE, настройки

- `GET /api/videos/{id}/summary` → `{video_id,state,max_level,levels:{"1":{level,label,blocks},…},root_summary,model,progress,detail,error_code}`;
- `POST {level?,force?}` → `202 {video_id,state,level}`; `DELETE` → `204`;
- ошибки: 400 `invalid_level`, 404 `video_not_found`, 409 `transcription_not_ready|model_missing|summary_disabled|generation_in_progress`;
- SSE: `summary.progress {video_id,stage:"outline"|"splitting"|"summarizing",done,total,percent}`, `summary.state`;
- настройки: `summary.enabled`, `summary.auto`, `summary.thinking`, `summary.model`.

### D-14.9. UI: динамическая шкала и режим саммари

- `TimingPanel` — flex-row `[скроллируемый контент][DetailScale 44 px]`.
- **DetailScale:** число детентов = `max_level+1`; 0 «Дословно» (текущие сегменты), 1..max_level — уровни саммари; метки — из `levels[level].label` (fallback «Уровень N из M»); лупа «+» сверху, «−» снизу; pointer/клавиши/Home/End/PageUp/Down, ARIA vertical, персист `vl.ui.detailLevel`, клампинг при смене `max_level`.
- Уровни >0: `SummaryBlockRow` — заголовок (жирным) + саммари + таймкод; для `max_level` — один корневой блок; клик → seek, активный блок по `positionMs`, follow/автоскролл; метки между блоками (read-only).
- Состояния: нет транскрипции (M5); нет саммари → «Сгенерировать»; `outlining/splitting/summarizing` → прогресс с текстом этапа; ошибка → «Повторить»; `stale` → «Перегенерировать»; `model_missing`/`summary.enabled=false` → CTA.

### D-14.10. Деградация

Без модели/при выключенном саммари шкала показывает только уровень 0 (или CTA); level 0 всегда доступен; ошибки генерации не влияют на статус видео.

## 4. Изменения контрактов

### 4.1. Миграция `backend/app/migrations/012_summary_tree.sql`

```sql
DROP TABLE IF EXISTS summary_chunks;
DROP TABLE IF EXISTS summary_levels;

CREATE TABLE summary_nodes (
  video_id INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  node_id TEXT NOT NULL, parent_id TEXT,
  depth INTEGER NOT NULL, order_idx INTEGER NOT NULL,
  start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL,
  segment_ids TEXT NOT NULL, title TEXT, summary TEXT,
  children_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (video_id, model, node_id)
);
CREATE INDEX idx_summary_nodes_depth ON summary_nodes(video_id, model, depth, order_idx);

CREATE TABLE summary_levels (
  video_id INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  model TEXT NOT NULL, level INTEGER NOT NULL,
  label TEXT, blocks TEXT NOT NULL,
  source_hash TEXT NOT NULL, prompt_version INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (video_id, model, level)
);

ALTER TABLE summary_jobs ADD COLUMN max_level INTEGER;
```

### 4.2. API

| Метод | Path | Ответ |
|---|---|---|
| GET | `/api/videos/{id}/summary` | `{video_id,state,max_level,levels:{"1":{level,label,blocks:[{node_id,start_ms,end_ms,title,text,keywords?}]},…},root_summary,model:{id,label,installed},progress,detail,error_code}` |
| POST | `/api/videos/{id}/summary` | `{level?:1..max_level, force?:bool}` → `202 {video_id,state,level}` |
| DELETE | `/api/videos/{id}/summary` | `204` (409 при активном job) |

### 4.3. SSE (реестр A5)

- `summary.progress` — `{video_id,stage:"outline"|"splitting"|"summarizing",done,total,percent}`;
- `summary.state` — `{video_id,state,detail?}`.

### 4.4. Настройки / localStorage

`summary.enabled` (bool), `summary.auto` (bool), `summary.thinking` (`auto|off`), `summary.model` (id); `vl.ui.detailLevel` (`0..max_level`, клампится при загрузке).

## 5. Задачи (rev2)

### T-14.1. Модели и протокол качества (выполнено)
`model_manifest.json` (две summary-модели, recommended/default, supports_thinking), `docs/summary-eval.md`; реальные LFM/Qwen прогоны.
**Оценка:** 1,5 дня.

### T-14.2. llama.cpp runtime и клиент (выполнено)
`scripts/fetch-llama-runtime.sh`, `services/llm/llama_cli.py` (GBNF, `-sys/-p/-st/-rea off`, timeout/kill, `<think>`), fake.
**Оценка:** 1 день.

### T-14.3. Иерархическая декомпозиция (rev2)
`services/summary/{tree,chunker,prompts,parser}.py`: OUTLINE (fits/chunked+merge), рекурсивный SPLIT (листья, глубина, чанки внутри блока, лимиты), нормализация покрытия, fallback; `prompt_version=2`; GBNF для outline/split/merge.
**Готово, когда:** дерево покрывает все сегменты, глубина и листья корректны, chunked-режим даёт root_summary.
**Оценка:** 2 дня.

### T-14.4. Pipeline/Manager/API (rev2)
`pipeline.py`: запись `summary_nodes`, материализация `summary_levels`/`max_level`, progress `outline/splitting/summarizing`, кэш/инвалидация; `manager.py`, `routers/summaries.py` (новая форма ответа), регистрация в main.py (Lead).
**Готово, когда:** GET отдаёт динамические уровни; повторный GET без LLM; stale/reprocess работают.
**Оценка:** 1,5 дня.

### T-14.5. Frontend: динамическая шкала и дерево (rev2)
`summaryStore` (maxLevel/levels/root_summary, clamp, generate, SSE), `DetailScale` (детенты по maxLevel, labels, ARIA), `SummaryBlockRow` (title+text), `TimingPanel` (динамические уровни, корневой блок, level 0).
**Готово, когда:** шкала совпадает с фактической глубиной, уровни переключаются, seek/прогресс/CTA работают.
**Оценка:** 2,5 дня.

### T-14.6. Тесты/e2e/доки/приёмка
Переписать `test_m14_*`, frontend tests, e2e `summary.spec.ts` (динамический maxLevel), замеры, `docs/*`, acceptance.
**Оценка:** 1,5 дня.

**Итого:** ~9,5 дня (rev2).

## 6. UI/UX-спецификация

- Шкала справа в панели таймингов; детентов = `max_level+1`; верх — «лупа +», низ — «лупа −»; метки из ответа API; при `max_level=0` шкала неактивна (только транскрибация).
- `level 0` — текущий `SegmentRow`/`AnnotationRow` без регрессий; `level>0` — `SummaryBlockRow`: заголовок, текст, таймкод, keywords; `max_level` — корневой блок (root_summary).
- Состояния/прогресс: заголовочные тексты этапов (`Анализ всего текста…`, `Разбиение на смысловые блоки: X/Y`, `Подготовка саммари…`); ошибки/повтор/stale/model missing/disabled.
- Активный блок подсвечивается по `positionMs`; follow/автоскролл; «К текущему блоку»; метки read-only между блоками.
- Доступность: `role=slider`, vertical, `aria-valuemin/max/now/valuetext`, клавиатура, контраст.

## 7. Тесты и проверки

| Проверка | Инструмент | Ожидание |
|---|---|---|
| OUTLINE: fits | unit с fake | root_summary + блоки покрывают 100% сегментов |
| OUTLINE: chunked | unit с fake/низким бюджетом | чанки + MERGE, root_summary есть, блоки покрывают всё |
| SPLIT-рекурсия | unit с fake | дерево, листья ≤2 сегментов, depth ≤ MAX_DEPTH, полное покрытие |
| Блок больше контекста | unit | внутри блока чанки+outline, дети покрывают блок |
| Материализация уровней | unit | `level1`=листья, `max_level`=корень, labels/`max_level` корректны |
| Pipeline/кэш/reprocess | pytest | повторный GET без вызовов LLM; stale/force |
| API/SSE/manager | pytest (fake) | формы/коды/события/этапы, cancel/gate/auto |
| Реальные модели | pytest `VL_SUMMARY_REAL=1` | дерево строится на LFM/Qwen, покрытие/таймкоды валидны |
| Frontend: DetailScale | vitest | детенты по maxLevel 1/3/5, clamp, labels, ARIA |
| Frontend: TimingPanel | vitest | динамические уровни, корневой блок, level 0 |
| E2E | Playwright fake | шкала до `max_level`, блоки, seek, возврат к сегментам |
| Приёмка | ручной чек-лист | качество блоков/саммари, покрытие, отсутствие модели |

## 8. Критерии готовности и коммиты

- [ ] Верхнеуровневое саммари строится по всему тексту; при переполнении — чанки + merge.
- [ ] Рекурсивное смысловое дерево: блоки → подблоки → строки; покрытие полное, листья ≤2 строк.
- [ ] Шкала динамическая: число детентов = фактическому `max_level+1` этого видео; клампинг.
- [ ] Уровни 1..max_level отображаются, клик → seek, активный блок/прогресс/ошибки/CTA.
- [ ] Level 0 без регрессий (сегменты/метки/мультивыбор/автопрокрутка).
- [ ] Кэш/инвалидация/переключение моделей работают; e2e/тесты/доки зелёные.
- [ ] Артефакты собираются, модели скачиваются, llama-runtime в бандле.

Коммиты: `feat(m14): hierarchical outline/split pipeline`, `feat(m14): dynamic detail levels and API`, `feat(m14): dynamic detail scale in timings panel`, `test(m14): hierarchy/e2e`, `docs(m14): rev2 algorithm and eval`.

## 9. Риски и откаты

| Риск | Вер. | Влияние | Мера |
|---|---|---|---|
| Дерево получается слишком глубоким/дорогим | Средняя | Среднее | MAX_DEPTH 8, MIN_LEAF 2, MAX_NODES/CALLS, таймауты, fallback |
| Модель «дробит по времени/строкам», а не по смыслу | Высокая | Среднее | Явные промпты SPLIT, деление только по смыслу, валидация покрытия/границ, fallback |
| Модель не разбивает атомарный блок | Низкая | Низкое | `split=false` → лист; это корректное поведение |
| Качество русского/сжатия у 350M/Qwen | Высокая | Среднее | Рекомендованная LFM, Qwen-альтернатива, протокол в `docs/summary-eval.md` |
| Контекст/чанки теряют смысл на границах | Средняя | Среднее | Чанки только contiguous по сегментам, merge верхнего уровня; блоки не пересекаются |
| Медленно на слабом CPU | Средняя | Среднее | compute-gate, 4 потока, кэш, прогресс/отмена, лимиты вызовов |
| Регрессия level 0 | Средняя | Высокое | level 0 не трогается пайплайном, тесты/e2e |
| Откат | — | — | `summary.enabled=false`, удалить дерево/кэш, шкала скрыта; остальное приложение не затронуто |

## 10. Трассировка и ссылки

- `TARGET.md` §2.4 (панель таймингов), §3.2, §7 п.3/5, §8 (RAM/CPU).
- `plans/00-conventions.md` A18/A19, API, миграции 010–012, §12 (требование пользователя).
- `plans/13-model-store.md` — модели/загрузка.
- `plans/05-player-timings-m5.md` — панель/seek/follow.
- Модели: [LiquidAI/LFM2.5-350M](https://huggingface.co/LiquidAI/LFM2.5-350M), [KoarAI/LFM2.5-350M-Thinking-GGUF](https://huggingface.co/KoarAI/LFM2.5-350M-Thinking-GGUF), [LFM Open License](https://www.liquid.ai/lfm-license), [Qwen2.5-0.5B-Instruct](https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF), llama.cpp [PR #14620](https://github.com/ggml-org/llama.cpp/pull/14620), [PR #24234](https://github.com/ggml-org/llama.cpp/pull/24234).
- Замечание пользователя (rev2): «сначала весь текст → смысловые блоки; если не влезает — чанки, но верхнеуровневое саммари; затем рекурсивно подблоки до строк; шкалу строить по факту детализации этого видео».
