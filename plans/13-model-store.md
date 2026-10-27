# 13. M13 — Модели: загрузка из настроек, вне бандла

> Статус: **реализован** (M13; доказательства — `PLAN.md` §15, `docs/acceptance.md`).
> Этап: M13 · Оценка: 6–7 дней · Зависит от: M8 (упаковка), M9 (настройки), M12 (модель эмбеддингов) · Разблокирует: M14 (саммари на LFM2.5-350M)
> Владелец: writer-release
> Требование пользователя: **вынести загрузку всех моделей из бандла в ручную загрузку после запуска приложения из меню настроек.**
> Заменяет A11 (`plans/00-conventions.md` §2) и создаёт исключение из `TARGET.md` §10 — см. §3 D-13.7 и §10.

## 1. Цель и границы

Сейчас модели лежат в `resources/models` внутри `.deb`/`.AppImage` (whisper + e5, ~594 MiB в релизной сборке): артефакт 941 МБ/823 МБ, каждая установка тащит все веса. Требование — **не поставлять модели в бандле**, а управлять ими из `Настройки → Модели`: скачать, обновить, удалить, импортировать офлайн-файл.

**Что делает этап:**
- реестр моделей (manifest) с pinned-ревизиями, размерами, SHA-256 и лицензиями;
- хранилище моделей в `$VL_DATA_DIR/models` (writable и в AppImage) с атомарной установкой;
- загрузчик: прогресс, докачка, отмена, повтор, проверка контрольной суммы, проверка свободного места; зеркало HF;
- импорт модели из каталога/архива (air-gapped и сети с блокировками);
- API `GET/POST/DELETE /api/models…`, SSE `model.progress`/`model.state`;
- разрешение путей: **data dir → resources (legacy)** — старые установки с встроенными моделями продолжают работать;
- UI-раздел «Модели» в настройках, первый запуск без модели, CTA из ошибок `model_missing`;
- удаление `resources/models` из `extraResources`, правка `after-pack.js`/`check-artifacts.sh`/`make-release.sh` и размерных гейтов;
- обновление лицензий/нотисов и документации.

**Чего этап не делает (границы):**
- не добавляет LLM-саммари и модель LFM — это M14 (здесь только механизм загрузки/реестра);
- не скачивает ffmpeg и бинарь llama.cpp — они остаются в бандле (критичный рантайм, а не данные);
- не делает автоматическую загрузку моделей «в фоне при старте»: сеть — только по явному действию пользователя (D-13.7);
- не переносит уже встроенные legacy-модели в data dir (они просто распознаются как `bundled`);
- не делает P2P/торренты/собственный CDN, не вводит аккаунт HF;
- не меняет формат хранения существующих моделей whisper/e5 (CTranslate2/ONNX-раскладка сохраняется).

## 2. Предусловия

| Предусловие | Как проверить |
|---|---|
| `Config.data_dir` и `ensure_dirs()` существуют, data dir writable в AppImage | `$VL_DATA_DIR/library.db` создаётся при старте |
| `httpx` и `huggingface_hub` уже в sidecar (транзитивно от faster-whisper) | `_internal/httpx*`, `_internal/huggingface_hub` в `backend-dist` |
| SSE-инфраструктура: `EventBus`, `/api/events`, `sse.ts` | события `video.progress` доходят до UI |
| `SettingsDialog` с секциями и `patch()`-обёрткой | `frontend/src/components/dialogs/SettingsDialog.tsx` |
| `GET /api/models` (M9) как основа нового контракта | `backend/app/routers/settings.py:35-58` |
| Скрипты `fetch-model.sh`/`fetch-embed-model.sh` — источник файлов/URL для manifest | в репозитории, модели в `resources/models` (dev) |
| Проверки артефактов: `after-pack.js`, `check-artifacts.sh` | падают при отсутствии моделей (будут изменены) |

## 3. Решения

**D-13.1. Реестр моделей — встроенный JSON-manifest.** `backend/app/model_manifest.json` (версия схемы `1`) — единственный источник правды о доступных моделях. Поля записи: `id` (`whisper-tiny…medium`, `embedding-e5-small`, `summary-lfm2.5-350m`, `summary-qwen2.5-0.5b`), `kind` (`transcription|embedding|summary`), `label`, `local_dir`, `source` (`type:"huggingface"`, `repo`, `revision`, `files:[{path, local, size, sha256}]`), `license` (`name`, `url`), `recommended`, `default`, `estimate_bytes`, `meta` (`supports_thinking` для суммаризаторов). Для суммаризации в реестре **две** модели: `summary-lfm2.5-350m` (KoarAI LFM2.5-350M-Thinking, `recommended:true`, `default:true`) и `summary-qwen2.5-0.5b` (Qwen2.5-0.5B-Instruct, `recommended:false`) — см. `plans/14` D-14.1. Ревизии — commit hash, не `main`; SHA-256 фиксируются при реализации. Манифест версионируется; при обновлении приложения сравнение `installed_revision ≠ manifest.revision` даёт статус `update_available`.

**D-13.2. Хранение — `$VL_DATA_DIR/models/<local_dir>/`.** Установленная модель — каталог с payload-файлами и маркером `.installed.json` (запись manifest + фактические SHA-256 + `installed_at`). Раскладка совпадает с текущей (`faster-whisper-small/`, `multilingual-e5-small-onnx/`, `lfm2.5-350m-thinking/model.gguf`), поэтому `queue.py`/`embeddings.py` используют существующие ожидания путей. `VL_MODELS_DIR` переопределяет корень (dev/e2e/тесты). Разрешение: `$VL_MODELS_DIR`/data dir → `$VL_RESOURCES_DIR/models` (legacy bundled) → «нет модели». При конфликте побеждает data dir.

**D-13.3. Установка атомарна.** Скачивание во `models/.tmp/<id>-<attempt>/`, проверка размеров и SHA-256, затем `os.replace` каталога в целевой и запись `.installed.json`. Частичный каталог никогда не виден резолверу. Прерванные загрузки (`status=downloading`) при старте помечаются `absent`; `.part`-файлы сохраняются для докачки.

**D-13.4. Загрузчик — собственный httpx-клиент по URL манифеста.** URL: `${endpoint}/${repo}/resolve/${revision}/${path}`; `endpoint` по умолчанию `https://huggingface.co`, переопределяется настройкой `models.endpoint` / env `VL_MODELS_ENDPOINT` (зеркало, например `https://hf-mirror.com`). `follow_redirects=True` (CDN HF), потоковая запись чанками 1 МиБ, прогресс ≤5 событий/с, `Range`-докачка при обрыве (если сервер вернул 206; иначе — перезапись файла), до 3 повторов с backoff, отмена через `Event`, таймаут на соединение 30 с. Свои `httpx` вместо `huggingface_hub.download` — детерминированный прогресс/resume и отсутствие зависимости от HF-cache/Xet в frozen-сборке.

**D-13.5. Проверка места и целостности.** Перед загрузкой: `shutil.disk_usage(models_dir).free ≥ estimate_bytes × 1.05 + 200 МиБ`, иначе `409 {code:"insufficient_disk"}`. После загрузки каждого файла — SHA-256 из манифеста; при несовпадении — удалить файл, `error` с `code:"checksum_mismatch"`, повтор не автоматический. Лимит размера файла — из манифеста (защита от подмены ответа).

**D-13.6. Импорт для офлайн-установки.** `POST /api/models/{id}/import {path}`: `path` выбирается в Electron-диалоге (`window.vl.openFolder`). Поддерживаются каталог с точной раскладкой `local_dir` и архивы `.zip`/`.tar.gz`. Архив распаковывается в `.tmp` с защитой от path traversal и абсолютных путей; затем проверка SHA-256/размеров и атомарная установка. Это основной путь для air-gapped и для сетей, где HF недоступен.

**D-13.7. Сеть — только по явному действию; офлайн-режим.** Исключение из `TARGET.md` §10/`A11` формулируется так: **никаких фоновых/автоматических сетевых запросов; единственный исходящий трафик — HTTPS-загрузка модели, инициированная нажатием «Скачать» (или импорт, который сети не требует)**. Настройка `models.offline` (bool, default `false`) / env `VL_OFFLINE=1`: при `true` эндпоинты загрузки отвечают `403 {code:"offline_mode"}`, UI скрывает кнопки с пояснением; импорт остаётся. Прокси — стандартные `HTTPS_PROXY`/`NO_PROXY`; токены/HF-аккаунт не поддерживаются.

**D-13.8. Статусы и модель состояний.** `absent → queued → downloading → verifying → ready`; `error` (с `detail`/`code`); `update_available` (ready, но revision в манифесте новее); `bundled` (найдено в resources). В памяти — один активный download job (single-flight); очередь из остальных запросов. Прогресс: `{bytes_received,total_bytes,percent}`; при нескольких файлах — суммарный по всем файлам записи.

**D-13.9. Использование модели в рантайме.** `queue.py` резолвит whisper через `model_resolver.resolve_whisper(name)`; если модели нет — видео получает `status='error'`, `error_code='model_missing'`, текст «Модель распознавания не установлена. Откройте Настройки → Модели»; SSE `video.status` дополняется `code`. `embeddings.py` резолвит e5 тем же способом и деградирует в FTS, как сейчас. Удаление/обновление модели запрещено, пока она используется активной транскрипцией/индексацией/саммари (`409 model_in_use`).

**D-13.10. API — замена контракта `GET /api/models`** (breaking change относительно M9; UI обновляется в этом же этапе, внешних потребителей нет). Старый `POST /api/maintenance/clear-model-cache` удаляется (его роль выполняет `DELETE /api/models/{id}`); `clear-preview-cache` остаётся.

**D-13.11. Упаковка.** Из `packaging/electron-builder.yml` удаляется `extraResources: resources/models`. `scripts/after-pack.js` больше не требует модели (требует backend/frontend/ffmpeg/llama-runtime/лицензии). `scripts/check-artifacts.sh` для релиза **проверяет отсутствие** `resources/models` и наличие `resources/THIRD-PARTY-NOTICES.md`; dev/e2e-сборки продолжают использовать `resources/models` через `VL_MODELS_DIR`/legacy-резолв. `scripts/make-release.sh` перестаёт вызывать `fetch-model.sh`/`fetch-embed-model.sh` по умолчанию (скрипты остаются для dev/e2e). Добавляется реальный размерный гейт: AppImage ≤ 450 МБ, `.deb` ≤ 400 МБ, установленный размер ≤ 1.1 ГБ (по замерам после выноса моделей: ≈370 МБ AppImage / ≈270 МБ `.deb`).

**D-13.12. Лицензии.** Каждая модель получает запись в `resources/THIRD-PARTY-NOTICES.md` (название, репозиторий, ревизия, лицензия, URL) и файл лицензии внутри `$VL_DATA_DIR/models/<id>/LICENSE` (скачивается из репозитория модели). В «О программе» — список установленных моделей и их лицензий. Для LFM (M14) — отдельное требование LFM Open License v1.0 (см. `plans/14-summary-lfm.md` §3).

**D-13.13. Совместимость со старыми установками.** Модели, найденные в `resources/models` (предыдущие `.deb`/AppImage), показываются как `bundled`: доступны для использования, но `DELETE`/`UPDATE` для них отключены (read-only раздел пакета). После обновления приложения, где модели исчезли из resources, UI предлагает скачать их заново; перенос файлов не делается.

**D-13.14. Dev/e2e/CI.** `scripts/fetch-*.sh` остаются для локальной разработки и e2e; e2e-server получает `VL_MODELS_DIR=${VL_MODELS_DIR:-$ROOT/resources/models}`. Unit-тесты загрузчика не ходят в сеть: используются локальный `http.server` (фикстура) и маленькие файлы; проверяются прогресс, resume, retry, checksum mismatch, cancel. Полные скачивания — только manual/acceptance.

## 4. Изменения контрактов

### 4.1. Манифест моделей (`backend/app/model_manifest.json`)

```json
{
  "schema": 1,
  "models": [
    {
      "id": "summary-lfm2.5-350m",
      "kind": "summary",
      "label": "LFM2.5-350M-Thinking (GGUF Q4_K_M)",
      "local_dir": "lfm2.5-350m-thinking",
      "recommended": true,
      "default": true,
      "meta": {"supports_thinking": true},
      "estimate_bytes": 229314528,
      "source": {
        "type": "huggingface",
        "repo": "KoarAI/LFM2.5-350M-Thinking-GGUF",
        "revision": "<commit-hash>",
        "files": [{"path": "LFM2.5-350M-Thinking-Q4_K_M.gguf",
                    "local": "model.gguf", "size": 229314528, "sha256": "<sha256>"}]
      },
      "license": {"name": "LFM Open License v1.0", "url": "https://www.liquid.ai/lfm-license"}
    },
    {
      "id": "summary-qwen2.5-0.5b",
      "kind": "summary",
      "label": "Qwen2.5-0.5B-Instruct (GGUF Q4_K_M)",
      "local_dir": "qwen2.5-0.5b-instruct",
      "recommended": false,
      "default": false,
      "meta": {"supports_thinking": false},
      "estimate_bytes": 491000000,
      "source": {
        "type": "huggingface",
        "repo": "Qwen/Qwen2.5-0.5B-Instruct-GGUF",
        "revision": "<commit-hash>",
        "files": [{"path": "qwen2.5-0.5b-instruct-q4_k_m.gguf",
                    "local": "model.gguf", "size": 491000000, "sha256": "<sha256>"}]
      },
      "license": {"name": "Apache-2.0", "url": "https://www.apache.org/licenses/LICENSE-2.0"}
    }
  ]
}
```

### 4.2. Миграция `backend/app/migrations/010_model_store.sql`

```sql
CREATE TABLE IF NOT EXISTS model_downloads (
  model_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,            -- absent|queued|downloading|verifying|ready|error
  bytes_received INTEGER NOT NULL DEFAULT 0,
  total_bytes INTEGER NOT NULL DEFAULT 0,
  revision TEXT,
  error TEXT,
  error_code TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE videos ADD COLUMN error_code TEXT;   -- model_missing|ffmpeg_failed|…
```

### 4.3. API (дополнение к `plans/00` §4)

| Метод | Path | Назначение |
|---|---|---|
| GET | `/api/models` | `{items:[{id,kind,label,installed,bundled,status,revision,update_available,size_bytes,progress:{bytes_received,total_bytes,percent},license,recommended,default,meta,error,error_code}], total_installed_bytes, total_available_bytes, models_dir, offline}` |
| POST | `/api/models/{id}/download` | `202 {id,status:"queued"}`; `409 already_installed\|download_in_progress`; `403 offline_mode`; `409 insufficient_disk` |
| POST | `/api/models/{id}/cancel` | `200 {id,status:"absent"}`; идемпотентно |
| DELETE | `/api/models/{id}` | `204`; `409 model_in_use`; для `bundled` — `409 model_bundled` |
| POST | `/api/models/{id}/import` | `{path}` → `202 {id,status:"verifying"}`; `400 import_path_invalid\|archive_unsafe\|checksum_mismatch` |

Ошибки: `{"detail":"…","code":"…"}`. `GET /api/models` — новый формат вместо M9 (см. D-13.10).

### 4.4. SSE (реестр A5)

- `model.progress` — `{model_id,status,bytes_received,total_bytes,percent}` (≤5/с);
- `model.state` — `{model_id,status,error,error_code?}`.
- `video.status` дополняется необязательным `code` (`model_missing`, …) — обратная совместимость сохраняется.

### 4.5. Настройки (`settings_service.DEFAULTS`/`ALLOWED_VALUES`)

| Ключ | Тип/значения | Дефолт |
|---|---|---|
| `models.endpoint` | строка, `https://…` или `http://127.0.0.1…`, ≤300 символов | `""` (= huggingface.co) |
| `models.offline` | `bool` | `false` |
| `models.auto_download` | `bool` — автоскачивание whisper-модели при постановке в очередь | `false` (по требованию: ручная загрузка) |

### 4.6. Пути (`plans/00` §7)

| Что | Значение |
|---|---|
| Модели (runtime) | `$VL_DATA_DIR/models/`; переопределение `VL_MODELS_DIR` |
| Legacy-модели | `$VL_RESOURCES_DIR/models/` (только чтение, статус `bundled`) |
| Частичные загрузки | `$VL_DATA_DIR/models/.tmp/` (чистятся при старте) |
| Runtime llama.cpp | `resources/llama/` (бандл, M14) |

## 5. Задачи

### T-13.1. Манифест, пути, миграция 010
**Файлы:** `backend/app/model_manifest.json` (новый), `backend/app/config.py`, `backend/app/models.py` (при необходимости), `backend/app/migrations/010_model_store.sql` (новый), `backend/app/services/model_resolver.py` (новый), `backend/tests/test_m13_manifest.py`.
**Что сделать:** (1) manifest со всеми моделями (whisper tiny/base/small/medium, e5, **две summary-модели**: KoarAI `recommended/default` и Qwen-альтернатива) c pinned revision и SHA-256; (2) `Config.models_dir`/`VL_MODELS_DIR`; (3) `resolve_whisper(name)`, `resolve_embedding()`, `resolve_summary()` с порядком data → resources → None; (4) миграция 010; (5) обновить `queue.py`/`embeddings.py` на резолвер, прокинуть `error_code="model_missing"`.
**Готово, когда:** при отсутствии модели `queue` ставит `error` + `error_code`, e2e/тесты видят `bundled` в resources; резолвер покрыт unit-тестами (data-wins, legacy, отсутствие).
**Оценка:** 1 день.

### T-13.2. Загрузчик моделей
**Файлы:** `backend/app/services/model_store.py` (новый), `backend/tests/test_m13_downloader.py`, `backend/tests/fixtures/http_model_server.py`.
**Что сделать:** (1) streaming download, прогресс, resume/retry/cancel; (2) SHA-256 и размеры; (3) проверка диска; (4) атомарная установка и `.installed.json`; (5) восстановление статусов при старте; (6) зеркало/endpoint и прокси; (7) single-flight.
**Готово, когда:** локальный HTTP-сервер: успешная загрузка, обрыв+resume, неверный checksum → `checksum_mismatch`, cancel → `absent`, нет места → `insufficient_disk`; сеть в тестах не используется.
**Оценка:** 1,5 дня.

### T-13.3. Импорт, удаление, занятость, офлайн-режим
**Файлы:** `backend/app/services/model_store.py`, `backend/app/routers/settings.py` → новый `routers/models.py` (или расширение settings), `backend/tests/test_m13_import.py`.
**Что сделать:** (1) импорт каталога и zip/tar.gz с защитой от traversal; (2) верификация и атомарная установка; (3) DELETE с проверкой `model_in_use` (активная транскрипция/индексация/саммари); (4) `models.offline`/`VL_OFFLINE=1` → `403 offline_mode`; (5) запрет delete/update для `bundled`.
**Готово, когда:** все негативные кейсы покрыты тестами; импорт работает без сети.
**Оценка:** 1 день.

### T-13.4. API, SSE, настройки, интеграция
**Файлы:** `backend/app/routers/models.py` (новый), `backend/app/main.py`, `backend/app/services/settings_service.py`, `backend/tests/test_api_models.py`, `frontend/src/api/client.ts`, `frontend/src/api/sse.ts`.
**Что сделать:** (1) эндпоинты §4.3; (2) события §4.4; (3) ключи §4.5; (4) `GET /api/models` с полным статусом; (5) удалить `clear-model-cache`; (6) типы/клиент/реестр событий frontend.
**Готово, когда:** pytest API зелёный; SSE-события приходят при download/import/delete; `tsc --noEmit` зелёный.
**Оценка:** 1 день.

### T-13.5. UI «Модели» в настройках
**Файлы:** `frontend/src/components/dialogs/SettingsDialog.tsx`, `frontend/src/state/modelsStore.ts` (новый), `frontend/src/components/dialogs/ModelsSection.tsx` (новый), `SettingsDialog.css`, `frontend/src/lib/i18n/ru.json`, `frontend/src/state/modelsStore.test.ts`, `ModelsSection.test.tsx`.
**Что сделать:** (1) группы «Распознавание / Поиск / Саммари»; (2) строка модели: размер, лицензия, значки **«Рекомендованная»** (KoarAI) / **«Альтернатива»** (Qwen), статус, прогресс-бар, Скачать/Отмена/Удалить/Обновить; обе summary-модели можно устанавливать одновременно; (3) «Импорт из файла…» через `window.vl.openFolder`; (4) «Открыть папку моделей» через существующий `vl().revealInExplorer(modelsDir)` (новый IPC не потребовался); (5) поля «Зеркало» и «Офлайн-режим»; (6) баннер первого запуска «Нет модели распознавания» и CTA из `model_missing`; (7) i18n + тесты.
**Готово, когда:** в dev-сборке можно скачать/удалить/импортировать модель, прогресс виден без перезагрузки; UI не блокируется; RTL-тесты зелёные.
**Оценка:** 1,5 дня.

### T-13.6. Упаковка, скрипты, документация, приёмка
**Файлы:** `packaging/electron-builder.yml`, `scripts/after-pack.js`, `scripts/check-artifacts.sh`, `scripts/make-release.sh`, `scripts/build-deb.sh`, `docs/architecture.md`, `docs/user-guide.md`, `docs/acceptance.md`, `README.md`, `resources/THIRD-PARTY-NOTICES.md`, `PLAN.md`.
**Что сделать:** (1) убрать модели из `extraResources`; (2) afterPack/check-artifacts по D-13.11 + размерный гейт; (3) make-release без fetch моделей; (4) ручной `.deb` — без моделей, с models-dir; (5) нотисы/лицензии; (6) доки и чек-лист приёмки (скачивание, зеркало, импорт, офлайн, отсутствие моделей в артефакте).
**Готово, когда:** `npm run dist` даёт AppImage ≤450 МБ и `.deb` ≤400 МБ без `resources/models`; `check-artifacts.sh` и `smoke-sidecar.sh` зелёные; приложение стартует без моделей и показывает CTA.
**Оценка:** 1 день.

**Итого:** 6,5 дня (6–7 дней).

## 6. UI/UX-спецификация

Раздел «Модели» в `SettingsDialog` (после «Распознавание», перед «Интерфейс»):

- **Группы:** «Распознавание речи» (whisper tiny/base/small/medium), «Семантический поиск» (e5), «Саммари» — **две модели**: `KoarAI LFM2.5-350M-Thinking` со значком «Рекомендованная» (дефолт) и `Qwen2.5-0.5B-Instruct` со значком «Альтернатива». Обе можно установить одновременно; активная summary-модель выбирается в настройках M14 (`summary.model`) без повторной загрузки; в M13 обе доступны для скачивания/удаления/импорта.
- **Строка модели:** название + бейдж (`Установлена`/`Встроена`/`Скачивается 42%`/`Ошибка`/`Доступно обновление`), размер, лицензия (ссылка), кнопки: `Скачать`, `Отмена`, `Удалить`, `Обновить`, `Импорт из файла…`.
- **Прогресс:** тонкий прогресс-бар под строкой, `received/total` (МБ), кнопка «Отмена»; при ошибке — текст + «Повторить»; при `insufficient_disk` — «Освободите N МБ».
- **Зеркало/офлайн:** поля в разделе «Данные»: «Зеркало моделей (URL)», чекбокс «Офлайн-режим (запретить сеть)»; изменение — один `PATCH /api/settings`.
- **Первый запуск:** если нет ни одной модели распознавания — ненавязчивый баннер в библиотеке и бейдж на «Настройки»: «Добавьте папку и скачайте модель для транскрипции» → открывает «Модели». При попытке поставить видео в очередь — тост/ошибка с действием «Скачать модель».
- **Импорт:** кнопка выбирает каталог (или архив) через Electron-диалог; диалог с пояснением ожидаемых файлов; после импорта — статус `ready` и тост.
- **Удаление:** подтверждение с размером; при `model_in_use` — пояснение, что модель используется, и отказ.
- **Доступность:** кнопки `aria-label`, прогресс `role="progressbar"` + `aria-valuenow`, фокус-ловушка диалога (уже есть), статусы озвучиваются через `aria-live="polite"`.
- **Ключи i18n:** `models.title`, `models.group.*`, `models.download`, `models.cancel`, `models.delete`, `models.update`, `models.import`, `models.importHint`, `models.installed`, `models.bundled`, `models.offline`, `models.endpoint`, `models.noModelBanner`, `models.modelInUse`, `models.insufficientDisk` и др.

## 7. Тесты и проверки

| Проверка | Инструмент | Где | Ожидаемый результат |
|---|---|---|---|
| Резолвинг путей (data/legacy/нет) | pytest | `test_m13_manifest.py` | data wins; legacy → `bundled`; нет → `model_missing` |
| Реестр summary: recommended/default/альтернатива | pytest | `test_m13_manifest.py` | LFM `recommended=true/default=true`; Qwen `recommended=false`; `supports_thinking` верный |
| Загрузка и прогресс | pytest + локальный HTTP | `test_m13_downloader.py` | файлы на месте, `.installed.json`, события `model.progress` |
| Resume/retry/cancel/checksum/диск | pytest | `test_m13_downloader.py` | корректные статусы и коды ошибок, нет частичных каталогов |
| Импорт dir/zip/tar и traversal | pytest | `test_m13_import.py` | успех для валидных; `archive_unsafe`/`checksum_mismatch` для плохих |
| API + SSE | pytest (ASGITransport) | `test_api_models.py` | контракт §4.3, коды 403/409/400, события |
| Занятость модели | pytest (мок-active job) | `test_api_models.py` | `409 model_in_use`, delete не выполняется |
| Офлайн-режим | pytest | `test_api_models.py` | `403 offline_mode`, импорт работает |
| Frontend store/UI | vitest + RTL | `modelsStore.test.ts`, `ModelsSection.test.tsx` | прогресс/статусы/кнопки, i18n, ошибки |
| Ручная приёмка | чек-лист | `docs/acceptance.md` | скачивание с HF/зеркала, импорт без сети, удаление, отсутствие моделей в артефакте |
| Артефакты | bash | `check-artifacts.sh` | `resources/models` отсутствует; размеры в гейте; AppImage/`.deb` стартуют |

## 8. Критерии готовности и коммиты

- [ ] `resources/models` не входит в релизный AppImage/`.deb`; размеры в гейте (§3 D-13.11).
- [ ] Пользователь скачивает/обновляет/удаляет/импортирует модели из «Настройки → Модели», прогресс и ошибки видны.
- [ ] Зеркало и офлайн-режим работают; импорт проходит без сети.
- [ ] Без модели распознавания приложение запускается и объясняет, что скачать; транскрипция даёт `model_missing` с CTA.
- [ ] Старые установки с моделями в resources продолжают работать (`bundled`).
- [ ] Все тесты §7 зелёные; `ruff`, `tsc --noEmit`, vitest, pytest — без ошибок; обновлены docs.
- [ ] `check-artifacts.sh`/`smoke-sidecar.sh` зелёные; AppImage/`.deb` проверены вручную (запуск, скачивание модели, транскрипция).

Ожидаемые коммиты: `feat(m13): add model manifest, resolver and model storage`, `feat(m13): implement resumable model downloader with checksum verification`, `feat(m13): add model import/delete and offline mode`, `feat(m13): expose model management API and SSE events`, `feat(m13): add models section to settings UI`, `build(m13): ship artifacts without bundled models`, `docs(m13): document model management and offline import`.

## 9. Риски и откаты

| Риск | Вер. | Влияние | Мера/откат |
|---|---|---|---|
| HF/зеркало недоступны в сети пользователя | Высокая | Высокое | Импорт модели из файла как основной fallback; настройка зеркала; документация; e2e/CI не зависят от сети |
| Большая загрузка обрывается/зависает | Средняя | Среднее | Докачка, таймауты, отмена, прогресс; статус `error` с повтором; частичные каталоги невидимы |
| Подмена/повреждение файлов | Низкая | Высокое | Pinned revision + SHA-256 + размеры; HTTPS; без произвольных URL из API |
| Не хватает диска | Средняя | Среднее | Предварительная проверка с запасом 200 МиБ; явный код `insufficient_disk` |
| Заблокированная модель удалена/обновлена во время работы | Средняя | Среднее | `model_in_use` (активная транскрипция/индексация/саммари); блокировка операций до завершения |
| Legacy-модели исчезают после обновления `.deb` | Средняя | Среднее | Резолвер data→resources; UI предлагает скачать; миграция не удаляет данные |
| Лицензионные требования моделей нарушены | Низкая | Высокое | Нотисы + файл лицензии в каталоге модели; проверка в чек-листе релиза |
| Сеть в рантайме противоречит TARGET §10 | Высокая | Среднее | Явное исключение D-13.7: только действие пользователя, офлайн-переключатель, нет телеметрии; зафиксировать в доках/приёмке |
| Откат | — | — | Вернуть `extraResources: resources/models` и `fetch-*` в make-release; приложение продолжит работать с legacy-резолвом (код D-13.2 совместим с обеими схемами) |

## 10. Трассировка и ссылки

- `TARGET.md` §10 (нет сети) — **пересматривается**: исключение только для явной загрузки модели (D-13.7); §7 п.1 (запуск без Python/ffmpeg), §8 (диск/RAM).
- `plans/00-conventions.md` §2 (A11 заменяется A18), §4 (API), §5 (миграция 010), §7 (пути), §12 (требование пользователя).
- `plans/08-packaging-m8.md` §3.7 (бюджеты — пересчитать), `plans/09-polish-m9.md` §4.5 (настройки/кэш моделей).
- `plans/12-semantic-search.md` (e5 уже скачивается скриптом — становится управляемой моделью).
- `plans/14-summary-lfm.md` — потребитель реестра (`kind:"summary"`: KoarAI LFM — рекомендуется/дефолт, Qwen2.5-0.5B — альтернатива).
- Требование пользователя: «вынос загрузки всех моделей из бандла в ручную загрузку после запуска приложения из меню настроек».
