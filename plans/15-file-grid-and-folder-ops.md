# V5: блочный режим списка файлов + «Переместить/Скопировать в папку»

> **Статус.** ✅ Реализовано (backend + frontend + e2e). Проверки: pytest 279 passed/4 skipped
> (из них 8 новых в `backend/tests/test_m15_file_ops.py`), vitest 269 (25 файлов, +30), e2e 19
> (6 новых в `e2e/file-grid.spec.ts`); `ruff`/`tsc` чистые.
> **Зависимости.** M2 (список/скан/`/api/fs/list`), M9 (настройки), M13/M14 не затрагиваются.
> **Скоуп.** Только панель «Файлы» (`frontend/src/components/FileList.tsx`). Панель результатов
> поиска (`SearchResults`) не меняется.

## 1. Задача пользователя

1. Для панели просмотра файлов — режим отображения **блоками в ряд**. Количество блоков в ряд
   настраивается, по умолчанию **6 в ряд**. Режим и число блоков запоминаются между запусками.
2. Для файлов в **строчном и блочном** режимах — пункты контекстного меню **«Переместить в папку»** и
   **«Скопировать в папку»**.
3. Приложение хранит **историю перемещений (5 записей)** и предлагает на выбор: переместить/скопировать
   в один из недавних адресатов **или выбрать новое размещение** (диалог выбора папки).

## 2. Решения

| # | Вопрос | Решение |
|---|---|---|
| D1 | Где хранить режим отображения и число колонок | `localStorage`: ключи `vl.ui.viewMode` (`"list"`/`"grid"`) и `vl.ui.gridColumns` (int, по умолчанию 6, диапазон 2…12). UI-предпочтение, на backend не дублируем. |
| D2 | Где хранить историю адресатов | Backend-настройка `files.recent_destinations` (`settings`), список абсолютных путей, максимум 5, свежие — первыми, без дублей. Пишет её backend при успешном transfer; клиент только читает (`GET /api/settings`) и обновляет из ответа transfer. |
| D3 | Куда можно перемещать/копировать | Только внутрь **отслеживаемых папок** (watched roots), включая их подкаталоги. Так библиотека остаётся консистентной: файл не «исчезает» из индекса. Вне корней — `403 forbidden_path`. Выбор — через существующий `GET /api/fs/list` (навигация по дереву) в модальном диалоге. |
| D4 | Семантика перемещения | `shutil.move` (переименование/кросс-девайс), затем `UPDATE videos SET path=…` — запись сохраняет id, теги, сегменты, метки, эмбеддинги, thumb-кэш. При ошибке DB — best-effort откат файла. |
| D5 | Семантика копирования | `shutil.copy2` в папку-назначение, затем индексация копии через `scanner.upsert_file` (probe + строка в `videos`). Копия того же контента получает `status="duplicate"` и `duplicate_of` — это существующая политика дедупликации G8/`UNIQUE(sha256)`. UI сообщает, что копии помечены как дубликаты. |
| D6 | Конфликт имён | Если файл с таким именем уже есть в назначении (или на этот путь ссылается строка `videos`) — файл не перезаписывается: per-item ошибка `target_exists`. |
| D7 | Групповые операции | ids — до 500, обрабатываются по одному; ответ 200 с per-item результатами (частичный успех). Ошибки уровня запроса — 4xx. |
| D8 | События | На каждый успешный элемент — SSE `video.status` (`{video_id, status}`); после обновления истории — SSE `settings.changed` с `{keys:["files.recent_destinations"]}`. |

## 3. Контракт backend

### 3.1 `POST /api/videos/transfer`

Request:

```json
{"action": "move" | "copy", "ids": [1, 2], "destination": "/home/u/videos/Учёба"}
```

Ответ `200`:

```json
{
  "action": "move",
  "destination": "/home/u/videos/Учёба",
  "items": [
    {"id": 1, "ok": true, "code": null, "detail": null,
     "path": "/home/u/videos/Учёба/lesson-01.mp4", "new_id": null},
    {"id": 2, "ok": false, "code": "target_exists",
     "detail": "В папке назначения уже есть файл lesson-02.mp4", "path": null, "new_id": null}
  ],
  "moved": 1, "copied": 0, "failed": 1,
  "recent_destinations": ["/home/u/videos/Учёба", "/home/u/videos/Разное"]
}
```

* `new_id` — id новой строки `videos` для копии; для перемещения `null`.
* `moved`/`copied` — количество `ok`-элементов соответствующего действия, `failed` — число `ok=false`.
* `recent_destinations` — актуальная история после операции (обновляется, только если был хотя бы один `ok`).

Ошибки уровня запроса: `400 {"detail","code"}`:

| code | Условие |
|---|---|
| `invalid_action` | `action` не `move`/`copy` |
| `invalid_ids` | `ids` не непустой список целых; больше 500 |
| `invalid_path` | `destination` пустой/не строка/не существует/не каталог |
| `forbidden_path` | `destination` вне watched roots (после `resolve()`) |

Per-item `code`: `not_found`, `missing_file`, `same_folder`, `target_exists`, `move_failed`,
`copy_failed`, `index_error` (файл скопирован, но строка в `videos` не создана — при этом `ok=true`).

### 3.2 Настройка `files.recent_destinations`

* `settings_service.DEFAULTS["files.recent_destinations"] = []`.
* Валидация `PATCH /api/settings`: список строк (1…4096 символов), без дублей, не больше 5; иначе
  `400 invalid_setting`.
* Helper `settings_service.remember_destination(conn, destination) -> list[str]` — кладёт путь первым,
  убирает дубли, обрезает до 5. Используется сервисом transfer.

### 3.3 Модуль `backend/app/services/file_ops.py`

* `TransferError(code, detail, status_code)` — ошибка уровня запроса.
* `transfer(conn, config, *, action, ids, destination) -> dict` — вся логика из §3.1; публикацию SSE
  и ответ делает роутер `videos.py` (он уже умеет `request.app.state.bus`).
* Нормализация путей: `Path(...).expanduser().resolve()` и проверка `path == root or root in path.parents`.
* Никаких миграций БД: истории достаточно в `settings`.

## 4. Контракт frontend

### 4.1 `frontend/src/state/fileBrowserStore.ts` (zustand)

```ts
export type FileViewMode = 'list' | 'grid';
export type TransferAction = 'move' | 'copy';

interface FileBrowserState {
  viewMode: FileViewMode;            // readStorage(STORAGE_KEYS.viewMode, 'list')
  gridColumns: number;               // readStorage(STORAGE_KEYS.gridColumns, 6), clamp 2..12
  recentDestinations: string[];      // из настроек
  folders: Folder[];                 // watched roots (для подписей и стартовой папки диалога)
  transfer: { action: TransferAction; ids: number[] } | null;
  transferring: boolean;

  initialize(): Promise<void>;       // api.getSettings() + api.folders(), один раз
  setViewMode(mode): void;           // + writeStorage
  setGridColumns(count): void;       // clamp + writeStorage
  openTransfer(action, ids): void;
  closeTransfer(): void;
  transferTo(action, ids, destination): Promise<void>;
}
```

`transferTo` → `api.transferVideos(...)`, затем: обновить `recentDestinations` из ответа,
`useLibraryStore.getState().refresh()`, toast:
* все ок, `action='move'` → `toast.moved` `{count}`;
* все ок, `action='copy'` → `toast.copied` `{count}` (+ пометка про дубликаты, если `items` содержат
  `code`/статус копии — достаточно текста `toast.copiedDuplicates`);
* частично → `toast.transferPartial` `{ok, failed, detail}` (warning);
* все ошибки → error-toast с `detail` первого элемента;
* исключение `ApiError` → error-toast.

### 4.2 UI `FileList.tsx`

* В шапке списка (над прокруткой) — переключатель вида: две кнопки `aria-pressed`
  «Списком» / «Блоками» (`files.viewList` / `files.viewGrid`) и, только в блочном режиме,
  `label` «Блоков в ряд» + `<select>` 2…12 (`files.gridColumns`).
* Блочный режим — `div.vl-filegrid` с `style={{ '--vl-grid-columns': gridColumns }}`,
  `role="listbox"` / карточки `role="option"`; в карточке: превью `mediaUrl(video.id,'thumb')`
  (16:9, `object-fit: cover`, при ошибке — placeholder 🎬), длительность, название, `StatusBadge`,
  счётчик тегов. Клик/`Ctrl`/`Shift`/двойной клик/контекстное меню/`Enter`/`Space`/стрелки
  (↑↓ — на строку, ←→ — на карточку) ведут себя как в таблице. Drag&drop тега на карточку и
  Drag&drop файлов в панель работают в обоих режимах.
* Контекстное меню (в обоих режимах) после пунктов тегов:
  * «Переместить в папку» → подменю: до 5 последних адресатов (подпись — путь относительно
    watched root, `title` — полный путь) + разделитель + «Выбрать другую папку…»;
  * «Скопировать в папку» → то же самое.
  Пункты работают с текущим выделением (`contextTargets`).
* Для `ContextMenuItem` добавить необязательное поле `title?: string` (тултип) — сам `ContextMenu`
  прокидывает его в `title` кнопки.
* **Исправление (по репорту):** подменю рендерится порталом в `document.body` с `position: fixed`
  и позиционируется по кнопке-якорю (справа, при нехватке места — слева; по вертикали прижимается
  к вьюпорту с ограничением высоты и скроллом). Раньше `position: absolute` внутри `.vl-menu`
  с `overflow-y: auto` обрезало подменю, а у краёв окна оно уходило за экран. Закрытие по клику
  снаружи учитывает портал (`[data-submenu]`), иначе mousedown в подменю закрывал меню до выбора.

### 4.3 Диалог выбора папки `frontend/src/components/FolderPickerDialog.tsx` (+ `.css`)

* Открывается из store (`transfer !== null`), рендерится в `FileList` (или `App` — на усмотрение
  фронтенда, главное — не внутри прокручиваемого списка).
* `role="dialog"`, `aria-modal`, заголовок «Переместить в папку»/«Скопировать в папку», закрытие
  `Escape`/«Отмена», focus-trap как в остальных диалогах.
* Данные: `api.folders()` → корни; навигация через `api.fsList(path)` (как `FolderTree`):
  список подпапок, «↑ На уровень выше», хлебные крошки/текущий путь. Стартовая папка — родительская
  папка первого выбранного файла (если внутри watched root), иначе список корней.
* Кнопка подтверждения «Переместить сюда»/«Скопировать сюда» (disabled, пока не выбран каталог и
  пока `transferring`); показывает «Выбрано файлов: N».
* После успешного подтверждения диалог закрывается; ошибки — toast, диалог остаётся открытым.

### 4.4 Прочее

* `frontend/src/api/types.ts`: `TransferAction`, `TransferItemResult`, `TransferResponse`.
* `frontend/src/api/client.ts`: `transferVideos(payload)`.
* `frontend/src/lib/constants.ts`: `STORAGE_KEYS.viewMode`, `STORAGE_KEYS.gridColumns`.
* `frontend/src/App.tsx`: в первичной инициализации (backendReady) вызвать
  `useFileBrowserStore.getState().initialize()`.
* `frontend/src/lib/i18n/ru.json`: ключи `files.viewList`, `files.viewGrid`, `files.gridColumns`,
  `files.moveTo`, `files.copyTo`, `files.chooseFolder`, `files.folderPickTitleMove`,
  `files.folderPickTitleCopy`, `files.moveHere`, `files.copyHere`, `files.up`, `files.roots`,
  `files.noSubfolders`, `files.selectedCount`, `files.recent`, `files.path`, `files.cancel`,
  `toast.moved`, `toast.copied`, `toast.copiedDuplicates`, `toast.transferPartial`.
* CSS — в `FileList.css` (сетка, карточки, выбранное/фокус/drop-target, адаптивность карточки),
  `FolderPickerDialog.css` — по аналогии с существующими диалогами.

## 5. Тесты

### Backend (`backend/tests/test_m15_file_ops.py`)

1. Перемещение одного файла: watched root A/B, строка `videos` в A → `POST /api/videos/transfer
   {"action":"move"}` в B; файл на диске в B, в A нет; `GET /api/videos` отдаёт новый путь, id тот же;
   `moved=1`; история содержит B.
2. Копирование настоящего короткого видео: оригинал проиндексирован, копия → файл в B, `copied=1`,
   `new_id`; строка копии `status="duplicate"`, `duplicate_of` = исходный id.
3. Ошибки уровня запроса: `invalid_action`, `invalid_ids`, `invalid_path` (нет каталога),
   `forbidden_path` (вне watched roots) — 400/403 и коды.
4. Per-item: `same_folder`, `target_exists`, `missing_file`, `not_found`; частичный успех 200.
5. История: 6 успешных transfer в разные папки → в `GET /api/settings` ровно 5, свежий первый,
   дубли не растут; `PATCH /api/settings {"files.recent_destinations": [...]}` валидирует тип/длину.
6. После move теги/метки/сегменты не потеряны (создать тег на видео и проверить `tags_count`).

### Frontend (`FileList.test.tsx`, `fileBrowserStore.test.ts`, `FolderPickerDialog.test.tsx`)

1. Переключение вида: по умолчанию `table`; клик «Блоками» → `role="listbox"`, 6 карточек,
   `--vl-grid-columns: 6`; режим сохранён в localStorage; перезагрузка компонента (пере-рендер)
   берёт сохранённый режим.
2. Выбор `<select>` 4 → `--vl-grid-columns: 4`, значение в localStorage; clamp 2…12.
3. Контекстное меню в блочном режиме: пункты «Переместить в папку»/«Скопировать в папку»,
   в подменю видны история (до 5) и «Выбрать другую папку…»; клик по истории вызывает
   `api.transferVideos({action,ids,destination})` и refresh.
4. Диалог выбора папки: открывается из «Выбрать другую папку…», ходит по `fsList`, кнопка
   подтверждения зовёт `transferVideos` с выбранным путём, закрывается.
5. Store: clamp/персист колонок, `initialize` читает `files.recent_destinations` и folders,
   `transferTo` обновляет историю и тосты (успех/частичный/ошибка).

## 6. Приёмка

* `bash scripts/test.sh` — ruff + pytest + tsc + vitest зелёные (число тестов вырастет).
* `bash scripts/dev.sh` / собранный frontend: в панели «Файлы» переключается вид, 6 блоков по
  умолчанию, число меняется; меню «Переместить/Скопировать в папку» показывает историю из 5 записей
  после операций и позволяет выбрать новую папку; файлы реально перемещаются/копируются, библиотека
  обновляется.
* Обновить `README.md` (краткое описание), `docs/user-guide.md` (раздел «Вид панели файлов» и
  «Перемещение/копирование в папку»), `plans/00-conventions.md` (строка API + ключ настройки).
