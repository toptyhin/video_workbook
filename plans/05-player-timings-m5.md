# 05. M5 — Предпросмотр и тайминги

> Этап: M5 · Оценка: 2.5 дня · Зависит от: M2 (файлы), M3 (сегменты), M4 (переход из поиска) · Разблокирует: M6 (теги сегментов), M7 (метки и их редактирование), M9
> Владелец: writer-search

## 1. Цель и границы

M5 делает центральную нижнюю панель рабочим инструментом: `<video>` плеер с Range-стримингом, панель таймингов с активным сегментом и автопрокруткой, таймлайн с фоновыми блоками сегментов и маркерами меток, восстановление раскладки и позиции воспроизведения. Этап закрывает критерий `../TARGET.md` §7 п.5 и принимает переход из поиска M4 (`start_ms`).

**Что делает этап:**
- `GET /api/videos/{id}/stream` — 206 Range-стриминг, `Accept-Ranges: bytes`, 416 на невалидный диапазон;
- `GET /api/videos/{id}/thumb` — JPEG-превью с кэшем в `$VL_DATA_DIR/cache/thumbs/` (базовый endpoint реализует M2, `./02-library-m2.md` D-02.8; M5 использует как постер и blob-кэш, не дублируя сервис);
- `GET /api/videos/{id}/segments` — сегменты + метки (чтение; запись меток — M7);
- плеер: play/pause, ±5 с, громкость, fullscreen, `J/K/L`, `Space`, `←/→`, крупное время;
- панель таймингов: строки сегментов, активный сегмент по playback clock, `scrollIntoView({block:'nearest'})`, клик → seek, «Транскрипция ещё не готова» + «Обработать сейчас»;
- таймлайн: блоки сегментов (синий 15% opacity, tooltip), цветные маркеры меток (только отображение и клик → seek), клик/скраббинг → seek;
- ресайз/сворачивание панели, ширина и состояние в `localStorage`, восстановление позиции после перезапуска;
- e2e-smoke Playwright `_electron`.

**Чего этап не делает (границы):**
- не создаёт, не редактирует и не удаляет метки, не рисует drag-границы и контекстное меню метки — это M7; M5 рисует `AnnotationMarker` и обрабатывает клик → seek;
- не назначает теги сегментам/меткам (M6/M7) — только читает `segment_tags` для бейджей, если M6 их уже пишет;
- не делает waveform/аудиодорожку, скорость воспроизведения, PiP, субтитры (вне объёма TARGET);
- не конвертирует видео для предпросмотра: неподдерживаемый контейнер/кодек → деградация UI (§3 D14), транскодинг — открытый вопрос §4;
- не делает хоткеи поиска/меток (`Ctrl+F`, `Ctrl+M`) — M4/M7/M9; `Space` и стрелки ограничены областью плеера/панели таймингов;
- не меняет `videos.status` и очередь — кнопка «Обработать сейчас» лишь вызывает существующие эндпоинты M3.

**Готово, когда** (`../TARGET.md` §6, M5): открыл файл → вижу сегменты, клик → плеер прыгает на нужное время.

## 2. Предусловия

| Предусловие | Как проверить |
|---|---|
| M2: `videos` с `duration_ms`, `path`; открытие файла из списка по двойному клику | dev-сборка: файл открывается, панель предпросмотра разворачивается |
| M3: `segments` для `videos.status='done'`; SSE `video.progress`/`video.status` | после обработки сегменты видны в БД и приходят события |
| M4: результат поиска умеет передать `video_id` + `start_ms` | клик по сниппету открывает файл (проверить до начала M5, временной заглушкой) |
| A3/A4: токен в `window.vl.getBackend()`, `X-VL-Token` для `/api/*` | запрос без токена → 401 |
| A11: `VL_RESOURCES_DIR/ffmpeg/ffmpeg` доступен в dev и prod-раскладке | `ffmpeg -version` из ресурсов |
| `$VL_DATA_DIR/cache/thumbs/` и `GET /videos/{id}/thumb` (M2, D-02.8/D-02.9) | каталог существует, thumb отдаёт JPEG или 404 до готовности; M5 не дублирует сервис |
| A12: `localStorage` доступен в рендерере, префикс `vl.` | проверить в DevTools Electron |
| A14: Playwright `_electron` запускает собранный main | `npm run e2e` на скелете M1 зелёный |
| A15: `formatTimecode` в `lib/time.ts`, строки в `i18n/ru.json` | `tsc --noEmit` |

## 3. Решения

**D1. Range-стриминг: FileResponse как основной путь, ручной стример как страховка.** Starlette `FileResponse` в закреплённой версии отдаёт `Accept-Ranges: bytes`, 206 и `Content-Range`, но поведение зависит от версии. Поэтому `services/streaming.py` содержит `parse_range()` и потоковый итератор, покрытые unit-тестами, а роутер выбирает реализацию по результату теста `FileResponse` в CI. Если `FileResponse` не даёт 206 — переключаемся на ручной `StreamingResponse` (см. §4, фрагмент) без изменения публичного контракта.

**D2. Токен в query только для `/stream`.** `<video src>` не может передать `X-VL-Token`, а fetch+blob убивает Range и seek по большому файлу, поэтому поток принимает `?token=`, как `/api/events` (расширение A4 — §4). Превью (`<img>`/постер) решается иначе: `fetch` с заголовком → `blob:`-URL с кэшем в store (решение M2, `./02-library-m2.md` D-02.9), так A4 расширяется минимально. Снижение утечки для потока: токен не логируется, URL не попадает в `backend.log`, `Referrer-Policy: no-referrer`, токен живёт только в памяти Electron.

**D3. Только ручные контролы, `controls={false}`.** Нативные контролы Chromium нельзя стилизовать, они перехватывают `Space` и стрелки и ломают горячие клавиши и крупное время. Кастомная панель — часть контракта §6: play/pause, ±5 с, громкость, fullscreen.

**D4. Playback clock — от `video.currentTime`, а не от wall-clock.** `usePlaybackClock` использует `requestVideoFrameCallback` при наличии, иначе `requestAnimationFrame`; публикует `positionMs` с троттлингом 4 Гц, немедленно — на `seeked`, `pause`, `play`. Активный сегмент вычисляется бинарным поиском по отсортированным `start_ms`; в разрыве между сегментами активного нет. Никаких `Date.now()` в расчёте позиции — это устраняет дрейф.

**D5. Автопрокрутка с «follow mode».** `TimingPanel` хранит `followActive`. Автоскролл выполняется, только если `followActive`; ручной wheel/touch/scroll (с guard-флагом программного скролла) выключает follow на 5 с и показывает кнопку «К текущему сегменту»; повторное включение — кнопкой, `play` или кликом по строке. Программный `scrollIntoView({block:'nearest'})` вызывается в `useEffect` по `activeSegmentId` и не дерётся с ручной прокруткой.

**D6. Таймлайн — DOM, не canvas.** Десятки-сотни блоков сегментов и маркеров отлично живут как абсолютно позиционированные `div` (`left: start/duration*100%`). Это даёт доступность (фокус, `title`, `aria-label`), tooltip без ручной отрисовки и клики без hit-testing. Canvas отброшен как ненужная сложность на этом объёме. Вся координатная математика вынесена в `lib/timelineGeometry.ts` (`msToPx`/`pxToMs`) — M7 переиспользует её для drag/resize, формула не дублируется в компонентах.

**D7. Скраббинг через Pointer Events.** `pointerdown` → `setPointerCapture` → `pointermove` (seek через `requestAnimationFrame`, не чаще кадра) → `pointerup`; клик без движения — мгновенный seek. Под таймлайном — `role="slider"` с `aria-valuenow`/`aria-valuetext`, `←/→` (+5 с), `Home/End`.

**D8. Маркер метки — «тупой» компонент.** `AnnotationMarker` получает `{annotation, durationMs, onSeek}` и ничего не знает о редактировании. `Timeline` принимает `annotations`, `segments`, `currentMs`, `selectedAnnotationId?`, `onSeek`, `onMarkerClick?`; M7 добавляет `onAnnotationEdit`, drag-границы и контекстное меню, не меняя отвечающий за отображение код. Это внутренний компонентный контракт (не API), но зафиксирован в §4 и §6, чтобы M7 не переписывал таймлайн.

**D9. Панель таймингов и её геометрия.** Ширина 280–560 px, хэндл-сплиттер `useResizable` (pointer events + `role="separator"`), сворачивание в полосу 32 px кнопкой `◀/▶`. Ключи — канонические из `./09-polish-m9.md` §4.5: `vl.ui.timingsWidth`, `vl.ui.timingsCollapsed`, значение в обёртке `{v:1, value}`; M5 вводит общий `usePersistedState`/`lib/storage.ts` (M9 переиспользует его для темы, сортировки и сброса). Чтение — при инициализации стора (до первого рендера), запись — debounce 150 мс, клампинг при ресайзе окна.

**D10. Позиция воспроизведения — карта в `localStorage`.** Ключ `vl.playback.positions` в обёртке `{v:1, value}` — объект `{videoId: {positionMs, updatedAt}}`, максимум 50 последних записей (LRU). Запись: throttled 2 с во время `play`, плюс `pause`/`seeked`/закрытие панели. Восстановление: если `positionMs > 5 с` и `< duration − 10 с` — seek и toast «Продолжить с 12:34» / «Начать сначала». Иначе — с нуля.

**D11. Сегменты и метки грузятся одним запросом.** `GET /videos/{id}/segments` → `{segments:[…], annotations:[…]}` (контракт 00 §4, этап M5). `playerStore` кэширует по `video_id`; инвалидация — по SSE `video.status` (стал `done`) и `annotations.changed` (M7). Пока грузится — скелетон панели, ошибка — inline-сообщение с «Повторить».

**D12. «Транскрипция ещё не готова» — по статусу и наличию сегментов.** `pending` → «Обработать сейчас» вызывает `POST /videos/{id}/enqueue`; `error` → «Переобработать» (`POST /videos/{id}/reprocess`) с текстом ошибки; `queued`/`processing` — сообщение и прогресс из SSE, кнопка disabled; `done` без сегментов — «Транскрипция не дала сегментов» + reprocess.

**D13. Неподдерживаемый формат — деградация, а не падение.** `mkv/avi/mov` могут не открыться в Chromium (нет демуксера/кодека). Ошибка `error` на `<video>` или `canPlayType('') === ''` → оверлей «Предпросмотр недоступен для этого формата» + кнопка «Показать в папке» (`window.vl.revealInExplorer`); панель таймингов при этом остаётся рабочей (сегменты из БД), клик по строке показывает таймкод без seek. Транскодинг — вне M5 (открытый вопрос §4).

**D14. Безопасность медиа-роутов.** Path резолвится только из БД по `video_id` (никаких пользовательских путей), файл должен существовать; 404/410 → `{detail, code}`; поток читается чанками 64 КБ; никакой отдачи каталогов; `Content-Type` — по расширению из белого списка, иначе `application/octet-stream`.

**D15. Ошибки плеера — в лог и UI.** `error`/`stalled`/`waiting` дольше 8 с → toast и запись в `backend.log` через `window.vl.log`; при 404 файла на диске — оверлей «Файл не найден» и кнопка «Удалить из индекса» (M2).

## 4. Изменения контрактов

**Реализуется без изменения контракта** (00 §4, §6, §7):

| Артефакт | Что именно | Источник |
|---|---|---|
| `GET /api/videos/{id}/stream` | 206 Range, `Accept-Ranges: bytes`, `Content-Range`, `Content-Length` | 00 §4 |
| `GET /api/videos/{id}/thumb` | JPEG, кэш в `cache/thumbs`; базовый endpoint — M2 (`./02-library-m2.md` D-02.8), M5 — потребитель | 00 §4, §7 |
| `GET /api/videos/{id}/segments` | `{segments:[…], annotations:[…]}` | 00 §4 (этап M5) |
| `window.vl.revealInExplorer`, `window.vl.getBackend`, `window.vl.log` | без новых каналов | 00 §6 |
| `localStorage`-ключи | `vl.ui.timingsWidth`, `vl.ui.timingsCollapsed` (канон M9 §4.5), `vl.player.volume`, `vl.playback.positions`; все — в обёртке `{v:1, value}` | 00 §2 A12, `./09-polish-m9.md` §4.5 |
| `frontend/src/lib/timelineGeometry.ts` | `msToPx(ms, duration, width)`, `pxToMs(x, duration, width)`, `clampMs`; round-trip без потерь | внутренний контракт для M7 (`./07-annotations-m7.md` D6/T-07.4); публичный API не меняет |

**Ратифицировано Lead'ом (`./00-conventions.md` §2 A4, §4.1):**

| Артефакт | Решение | Обоснование |
|---|---|---|
| Токен в query только для `/stream` | принято: `?token=` для `/api/videos/{id}/stream`; превью — fetch+blob (M2) | A4 обновлён; `<video>` не умеет заголовки |
| `GET /api/videos/{id}/thumb?at_ms=` (опционально) | принято как аддитивный параметр | hover-превью; при отказе M5 использует постер M2 |
| `Content-Disposition: inline` + `Referrer-Policy: no-referrer` | реализация, не изменение контракта | защита URL с токеном |
| Внутренний контракт `Timeline`/`AnnotationMarker` | принято (внутренний, не API) | M7 расширяет без переписывания |
| `hooks/usePersistedState.ts` + `lib/storage.ts` | принято: владелец — M5; M9 переиспользует | ключи M5: `vl.player.volume`, `vl.playback.positions` |

**Фрагмент ручного Range-стримера** (страховка D1):

```python
def parse_range(header: str, size: int) -> tuple[int, int]:
    m = re.fullmatch(r"bytes=(\d*)-(\d*)", header.strip())
    if not m or (not m.group(1) and not m.group(2)):
        raise RangeNotSatisfiable(size)
    if not m.group(1):                      # bytes=-N (suffix)
        n = int(m.group(2)); start = max(0, size - n); end = size - 1
    else:
        start = int(m.group(1)); end = int(m.group(2) or size - 1)
    if start >= size or start > end:
        raise RangeNotSatisfiable(size)
    return start, min(end, size - 1)
```

**Фрагмент playback clock** (иллюстративно, ≤25 строк):

```ts
export function usePlaybackClock(video: Ref<HTMLVideoElement | null>, setMs: (ms: number) => void) {
  useEffect(() => {
    const el = video.current; if (!el) return;
    let stop = false;
    const tick = () => { if (stop) return; setMs(Math.round(el.currentTime * 1000)); raf = requestAnimationFrame(tick); };
    const onSeeked = () => setMs(Math.round(el.currentTime * 1000));
    el.addEventListener('seeked', onSeeked);
    let raf = requestAnimationFrame(tick);
    return () => { stop = true; cancelAnimationFrame(raf); el.removeEventListener('seeked', onSeeked); };
  }, [video, setMs]);
}
```

**Решения по открытым вопросам (ратифицировано Lead'ом, `00` §4.1):**
1. Токен в query — **только** для `/stream` (A4); превью — fetch+blob (M2). Одноразовые URL `?st=` и blob для потока отклонены.
2. `mkv/avi/mov` — деградация D13 в M5 (оверлей + «Показать в папке», панель таймингов работает); транскодинг для предпросмотра — stretch после M9, в объём M5 не входит.
3. `?at_ms` — принят как опциональный аддитивный параметр; базовый постер — M2.
4. Автопрокрутка — «follow mode» с паузой 5 с после ручного скролла и кнопкой «К текущему сегменту».
5. `Space` — владелец M5 (область плеера/панели таймингов); M7 перехватывает `Delete` только при фокусе в списке/маркерах меток и не дублирует `Space`.
6. `thumb` — реализован в M2, M5 расширяет `?at_ms=`; второй сервис не создаётся (`00` §4.1 п.4).
7. `usePersistedState` — владелец M5; M9 переиспользует хук для темы/сортировки/сброса (`00` §4.1 п.7).

## 5. Задачи

Оценки — в долях дня, сумма `2.50`.

### T-05.1. Range-стриминг

**Файлы:** `backend/app/routers/videos.py`, `backend/app/services/streaming.py`, `backend/app/main.py` (исключение токена), `backend/tests/test_stream.py`
**Что сделать:**
1. Реализовать `parse_range()` и ручной `StreamingResponse`-генератор чанками 64 КБ; `RangeNotSatisfiable` → 416 с `Content-Range: bytes */{size}`.
2. Проверить `FileResponse`: если отдаёт 206 и `Accept-Ranges: bytes` — использовать его; иначе — ручной путь (D1); решение зафиксировать в `docs/architecture.md`.
3. Поддержать `Accept-Ranges`, `HEAD`, одиночный диапазон, suffix `bytes=-N`, open-ended `bytes=N-`; multi-range → 200 полным телом (допустимо по RFC 7233).
4. Расширить middleware: `?token=` принимается только для `/api/videos/{id}/stream`; в логах query вырезается; `/thumb` не трогаем (M2, fetch+blob).
5. Обновить `api/client.ts`: `mediaUrl(videoId)` добавляет токен в query для потока; `Referrer-Policy: no-referrer`.
**Готово, когда:** pytest подтверждает: 200 без Range; 206 с корректными `Content-Range`/`Content-Length` для `bytes=0-`, `bytes=100-199`, `bytes=-100`; 416 на `bytes=size-` и мусор; несуществующий файл — 404 `{detail, code}`; без токена — 401.
**Оценка:** 0.40

### T-05.2. Сегменты, метки и интеграция превью

**Файлы:** `backend/app/routers/videos.py`, `backend/app/services/annotations_service.py` (чтение), `backend/tests/test_segments_api.py`, `frontend/src/state/playerStore.ts`
**Что сделать:**
1. `GET /videos/{id}/segments`: сегменты по `start_ms`, метки (чтение, включая `tag_ids` через `annotation_tags`, если таблица уже есть) — в формате 00 §4; сортировка по `start_ms`; пустая транскрипция — пустые массивы, не 404.
2. Превью использовать из M2 (D-02.8/D-02.9): `GET /thumb` по `{id}.jpg`, 404 до готовности; постер грузится через `fetch` + `blob:` с кэшем в `playerStore` и `revokeObjectURL` при смене файла; placeholder при 404/ошибке.
3. Если к началу M5 endpoint `/thumb` ещё не реализован (M2 в работе) — M5 добавляет его по 00 §4 как fallback, без второго сервиса; владение фиксируется в §4 «Открытые вопросы».
4. `?at_ms` (если согласован §4) — только для hover-превью; при отказе используется постер M2.
5. Тесты: `/segments` схема и сортировка, пустые массивы, чтение меток; клиент — один blob-запрос на файл, отзыв URL.
**Готово, когда:** pytest зелёный; `/segments` соответствует схеме и не падает без транскрипции; постер загружается один раз и освобождается при смене файла.
**Оценка:** 0.35

### T-05.3. Плеер: контролы, клавиши, fullscreen

**Файлы:** `frontend/src/components/player/VideoPlayer.tsx`, `VideoControls.tsx` (новый), `frontend/src/hooks/useHotkeys.ts`, `frontend/src/hooks/usePlaybackClock.ts`, `frontend/src/state/playerStore.ts`, `frontend/src/styles/tokens.css`
**Что сделать:**
1. `<video>` с `src=mediaUrl`, `preload="metadata"`, без нативных контролов; постер — blob из `/thumb` (M2); оверлеи ошибок/загрузки.
2. Контролы: play/pause, −5 с/+5 с, громкость (slider + mute), fullscreen на контейнер (`requestFullscreen`, `fullscreenchange`), крупное время `position / duration` через `formatTimecode`.
3. Клавиши в области плеера/панели таймингов: `Space` — play/pause, `←/→` — ±5 с, `J/K/L` — −10 с / play-pause / +10 с (стандарт монтажных петель); не перехватывать, если фокус в `input`/`textarea`/`contentEditable`.
4. `usePlaybackClock` (D4) публикует `positionMs` в `playerStore`; `play/pause/seek(ms)` — экшены, seek клампится в `[0, duration]`.
5. `video.error` → оверлей D13/D15; `stalled` > 8 с → toast.
**Готово, когда:** Playwright/vitest: play/pause меняет состояние, `←/→` двигают `currentTime` на 5 с, `J/L` — на 10 с, `Space` не срабатывает в поле поиска; fullscreen вызывается; ошибка видео показывает оверлей.
**Оценка:** 0.40

### T-05.4. Активный сегмент и синхронизация

**Файлы:** `frontend/src/state/playerStore.ts`, `frontend/src/lib/time.ts`, `frontend/src/hooks/usePlaybackClock.ts`, `frontend/src/state/playerStore.test.ts`
**Что сделать:**
1. Хранить `segments` отсортированными по `start_ms`; `activeSegmentId` вычислять бинарным поиском: `start_ms <= t < end_ms`, при перекрытии — последний начавшийся; в разрыве — `null`.
2. Подписка на позицию с троттлингом 4 Гц; при `seek` в поисковый результат — немедленный пересчёт активного сегмента и синхронизация панели.
3. Тесты границ: 0 мс, точное `start_ms`, `end_ms`, разрыв, последний сегмент, пустой список, видео без длительности.
**Готово, когда:** vitest на наборе границ зелёный; `activeSegmentId` не мигает между соседними сегментами при 4 Гц.
**Оценка:** 0.20

### T-05.5. Панель таймингов

**Файлы:** `frontend/src/components/player/TimingPanel.tsx`, `SegmentRow.tsx`, `AnnotationRow.tsx`, `frontend/src/hooks/useResizable.ts`, `frontend/src/state/uiStore.ts`, `frontend/src/lib/i18n/ru.json`
**Что сделать:**
1. Строки: `[MM:SS]` + текст, активная — фон `--vl-accent-soft`, hover; клик → `seek(start_ms)`; `Enter` на строке — то же.
2. Автопрокрутка D5: `scrollIntoView({block:'nearest', behavior:'smooth'})`, только при `followActive`; кнопка «К текущему сегменту»; guard программного скролла.
3. Метки — строки в хронологическом порядке, цветной фон/иконка 🏷, клик → seek, двойной клик зарезервирован под M7 (сейчас — no-op + комментарий-контракт).
4. Состояния: скелетон, «Транскрипция ещё не готова»/«Обработать сейчас» по D12, ошибка загрузки, пустые сегменты.
5. Ресайз/сворачивание панели (D9): сплиттер `role="separator"`, кнопка `◀/▶`, сохранение в `localStorage`, клампинг 280–560 px.
**Готово, когда:** RTL: клик по строке вызывает `seek(start_ms)`, активный сегмент получает класс, `scrollIntoView` вызван с `block:'nearest'` (мок), сворачивание сохраняет состояние, для `pending` показывается кнопка и вызывается `enqueue`.
**Оценка:** 0.35

### T-05.6. Таймлайн и геометрия `ms ↔ px`

**Файлы:** `frontend/src/components/player/Timeline.tsx`, `components/player/AnnotationMarker.tsx`, `components/player/Timeline.test.tsx`, `frontend/src/lib/timelineGeometry.ts` (новый), `frontend/src/lib/timelineGeometry.test.ts`, `frontend/src/styles/tokens.css`
**Что сделать:**
1. `timelineGeometry.ts`: чистые `msToPx(ms, duration, width)`, `pxToMs(x, duration, width)`, `clampMs`; round-trip `pxToMs(msToPx(m))` без потерь, защита от `duration = 0`; это контракт для M7 (drag/resize, `./07-annotations-m7.md` D6/T-07.4).
2. Дорожка длительности, блоки сегментов: `left = msToPx(start)/width`, ширина по `end - start`, фон `rgba(59,130,246,.15)`, `title` — текст сегмента (trim 120 символов), hover — усиление фона.
3. Маркеры меток: цвет из `annotation.color`, `left = msToPx(start)`, минимальная ширина 3 px; клик → `seek(start_ms)`; tooltip «label + timecode»; слой поверх сегментов, `pointer-events` так, чтобы клик по маркеру не уходил в скраббинг.
4. Клик по дорожке → seek; скраббинг D7 (pointer capture, rAF-троттлинг, `role="slider"`, `aria-valuenow`, `←/→`, `Home/End`).
5. Контракт расширения M7 (D8): `selectedAnnotationId`, `onMarkerClick`, слот для drag-границ; зафиксировать комментарием и типами в `Timeline.tsx`.
**Готово, когда:** RTL: блок сегментов имеет ожидаемые `left/width`, клик по дорожке/маркеру вызывает `seek`, `annotation.color` применён, скраббинг не отправляет больше одного seek на кадр, клавиатура работает; round-trip-тест геометрии зелёный.
**Оценка:** 0.35

### T-05.7. Восстановление раскладки и позиции

**Файлы:** `frontend/src/state/uiStore.ts`, `frontend/src/state/playerStore.ts`, `frontend/src/App.tsx`, `frontend/src/hooks/usePersistedState.ts` (новый), `frontend/src/lib/storage.ts` (новый)
**Что сделать:**
1. Чтение `vl.ui.timingsWidth`/`vl.ui.timingsCollapsed` (канон M9 §4.5) до первого рендера; запись debounce 150 мс; валидация/клампинг значений.
2. Позиция D10: карта `vl.playback.positions` (LRU 50), throttled-запись, восстановление с toast «Продолжить с …»/«Начать сначала»; очистка записи при удалении видео из индекса.
3. `usePersistedState` + `storage.ts`: обёртка `{v:1, value}`, безопасные `getJSON/setJSON` (try/catch, квоты, битые данные → дефолт + WARNING в лог); M9 переиспользует хук для темы/сортировки/сброса.
4. Восстановление после перезапуска приложения (закрыть/открыть, файл остаётся выбранным — состояние `selectedVideoId` в `uiStore`).
**Готово, когда:** e2e/vitest: после «перезапуска» ширина и сворачивание панели восстановлены; позиция > 5 с предлагается и применяется; битые значения в `localStorage` не ломают приложение.
**Оценка:** 0.20

### T-05.8. Тесты, e2e-smoke, документация

**Файлы:** `e2e/player.spec.ts`, `e2e/fixtures/` (короткое видео + БД), `playwright.config.ts`, `docs/user-guide.md`, `docs/architecture.md`
**Что сделать:**
1. Playwright `_electron` smoke: запуск приложения с фикстурой, открытие файла, появление сегментов, клик по строке → `currentTime` изменился, таймлайн отрисовал блок и маркер, панель сворачивается.
2. Фикстуры: 10-секундный mp4, БД с 3 сегментами и 1 меткой; запуск с `VL_DATA_DIR` во временном каталоге.
3. `docs/user-guide.md`: плеер, горячие клавиши, таймлайн, восстановление позиции; `docs/architecture.md`: Range-стриминг и кэш превью (1 абзац).
4. Прогнать `scripts/test.sh` + `npm run e2e`, приложить логи в отчёт этапа.
**Готово, когда:** e2e зелёный в CI-контейнере с `xvfb-run`; документация обновлена; нет «известных регрессий» M1–M4.
**Оценка:** 0.25

**Итого: 0.40 + 0.35 + 0.40 + 0.20 + 0.35 + 0.35 + 0.20 + 0.25 = 2.50 дня.**

## 6. UI/UX-спецификация

```
┌──────────────────────────────────────────────────────────────┬──────────────────┐
│   <video> (постер = thumb, controls=false)                   │  ТАЙМИНГИ  [◀]   │
│                                                              │  [00:12] Введение│
│  ┌────────────────────────────────────────────────────────┐  │  [01:45] Основные│
│  │▓▓▓ блоки сегментов (синий 15%)   ◆◆ маркеры меток      │  │ ▸[02:10] Пример │
│  └────────────────────────────────────────────────────────┘  │  [05:30] Итоги   │
│  ▶ 00:00 ──────────●────────────────────── 12:34  🔊  ⛶      │  [＋ метка] M7   │
└──────────────────────────────────────────────────────────────┴──────────────────┘
```

**Плеер:**

| Элемент | Поведение |
|---|---|
| play/pause | клик или `Space` (фокус в плеере/панели); иконка меняется, `aria-label` обновляется |
| ±5 с | кнопки и `←/→`; seek клампится в допустимый диапазон |
| `J/K/L` | `J` −10 с, `K` play/pause, `L` +10 с; не работают при фокусе в поле поиска/диалоге |
| время | крупно (`--vl-font-time`, ≥ 20 px) `MM:SS / HH:MM:SS`; обновляется 4 Гц |
| громкость | slider + mute, значение `vl.player.volume` (localStorage) |
| fullscreen | на контейнер панели, `Esc` выходит; состояние не сохраняется |
| поиск M4 | открытие файла с `start_ms` → seek до первого кадра, панель прокручивается к сегменту с подсветкой 1.5 с |

**Панель таймингов — состояния:**

| Состояние | Отображение |
|---|---|
| загрузка | скелетон 5 строк |
| сегменты есть | список, активная строка подсвечена и (при follow) в видимой области |
| метки есть | строки меток в хронологическом порядке с цветным фоном, между/поверх сегментов |
| `pending` | «Транскрипция ещё не готова» + «Обработать сейчас» (enqueue) |
| `queued`/`processing` | «Транскрипция идёт: N%» + прогресс-бар из SSE, кнопка disabled |
| `error` | текст ошибки + «Переобработать» (reprocess) |
| `done`, сегментов 0 | «Сегментов нет» + reprocess |
| ошибка загрузки | inline «Не удалось загрузить сегменты» + «Повторить» |

**Таймлайн:** высота 28–36 px; блоки сегментов — синий 15% opacity (`--vl-segment-bg`), tooltip = текст; маркеры — цвет метки, шириной не менее 3 px, hover увеличивает высоту; playhead — вертикальная линия 2 px; клик → seek; перетаскивание — скраббинг с обновлением времени без «дрожания» (rAF). В тёмной теме фон и подсветка пересчитываются, контраст playhead ≥ 3:1.

**Клавиатура и доступность:** фокус-кольца на контролах и строках; `aria-label` у иконок; таймлайн — `role="slider"` с `aria-valuetext` («2 минуты 10 секунд»); строки — `role="option"`; `prefers-reduced-motion` отключает smooth-скролл и анимацию подсветки.

**localStorage:** `vl.ui.timingsWidth`, `vl.ui.timingsCollapsed` (канон M9 §4.5), `vl.player.volume`, `vl.playback.positions` — все в обёртке `{v:1, value}`.

## 7. Тесты и проверки

| Проверка | Инструмент | Где | Ожидаемый результат |
|---|---|---|---|
| Range: 200/206/416, suffix, open-ended, HEAD | pytest | `backend/tests/test_stream.py` | корректные `Content-Range`/`Content-Length`, тело совпадает с файлом |
| Токен в query только для media-роутов | pytest | `test_stream.py` | 401 без токена, 200 с токеном, для `/api/videos` query-токен не работает |
| Кэш превью и ошибки | pytest (M2) + vitest | `backend/tests/test_thumbnail.py`, `VideoPlayer.test.tsx` | 1 генерация на файл; 404 → placeholder; один blob-fetch на файл, `revokeObjectURL` вызван |
| `/segments`: сегменты + метки, пустая транскрипция | pytest | `backend/tests/test_segments_api.py` | схема 00 §4, сортировка по `start_ms` |
| Активный сегмент: границы, разрыв, пустой список | vitest | `playerStore.test.ts` | бинарный поиск корректен на всех границах |
| Клик → seek, горячие клавиши, `Space` вне поля ввода | vitest + RTL | `TimingPanel.test.tsx`, `VideoPlayer.test.tsx` | `seek()` с ожидаемым ms; клавиша в `input` не перехватывается |
| Автопрокрутка и follow mode | vitest (мок `scrollIntoView`) | `TimingPanel.test.tsx` | `block:'nearest'`; после ручного скролла автоскролл выключен |
| Таймлайн: позиции блоков/маркеров, скраббинг, клавиатура | RTL | `Timeline.test.tsx` | `left/width` по формуле; один seek на кадр; `aria-valuenow` верный |
| Ресайз/сворачивание/восстановление | vitest + `localStorage` mock | `uiStore.test.ts` | значения сохранены и восстановлены, клампинг 280–560 |
| Восстановление позиции | vitest | `playerStore.test.ts` | > 5 с — предлагается, < 5 с — игнор, битые данные не падают |
| Ошибка/неподдерживаемый формат | RTL | `VideoPlayer.test.tsx` | оверлей с текстом и кнопкой «Показать в папке», панель таймингов жива |
| E2E smoke | Playwright `_electron` | `e2e/player.spec.ts` | открыть файл → сегменты → клик по строке меняет `currentTime` → маркер виден |
| Контраст активной строки/playhead | ручной аудит + axe | dev-сборка | ≥ 4.5:1 (текст), ≥ 3:1 (playhead) |

## 8. Критерии готовности и коммиты

**DoD:**
- [ ] `GET /videos/{id}/stream` отдаёт 206 с корректными заголовками, 416 на мусор, 401 без токена;
- [ ] `/videos/{id}/segments` отдаёт сегменты и метки; плеер использует `/thumb` из M2 (кэш, 404 → placeholder, blob освобождается);
- [ ] геометрия таймлайна (`msToPx`/`pxToMs`) вынесена в `timelineGeometry.ts` и покрыта round-trip-тестом (M7 переиспользует);
- [ ] плеер: play/pause, ±5 с, громкость, fullscreen, `J/K/L`, `Space`, `←/→`, крупное время;
- [ ] панель таймингов: активный сегмент по playback clock, `scrollIntoView({block:'nearest'})`, клик → seek, состояния «не готова»/«Обработать сейчас»;
- [ ] таймлайн: блоки сегментов (синий 15%), маркеры меток, клик → seek, скраббинг;
- [ ] ресайз/сворачивание панели и позиция воспроизведения восстанавливаются после перезапуска;
- [ ] e2e-smoke Playwright зелёный, `scripts/test.sh` зелёный, `ruff`/`tsc --noEmit` без ошибок;
- [ ] `Timeline`/`AnnotationMarker` содержат контракт расширения M7 (D8) и он описан в §4;
- [ ] критерий `../TARGET.md` §7 п.5 подтверждён вручную; §7 п.8 (в части размеров панелей) — тоже;
- [ ] отклонения от 00 (токен в query для `/stream`, `at_ms`) ратифицированы в `00` A4/§4.1 и зафиксированы в §4 этого плана.

**Ожидаемые коммиты (Conventional Commits):**
1. `feat(m5): add range streaming for video files`
2. `feat(m5): add segments endpoint and preview integration`
3. `feat(m5): implement video player with controls and hotkeys`
4. `feat(m5): add timing panel with active segment autoscroll`
5. `feat(m5): add timeline, layout persistence and playback restore`
6. `test(m5): add player unit tests and electron e2e smoke`

## 9. Риски и откаты

| Риск | Вероятность | Влияние | Смягчение / откат |
|---|---|---|---|
| **R-05.1. Range/звук в Electron.** `<video>` в Chromium не любит некоторые сочетания контейнер/кодек; Range-запросы могут давать «залипание» seek или отсутствие звука | Высокая | Высокое: критерий §7 п.5 не выполняется на части файлов | D1: ручной 206-стример + тесты; D13: преflight и деградация; откат — переключить `settings.player_stream_mode="blob"` для проблемных файлов (fetch всего файла, работает для коротких уроков) без изменения контракта |
| **R-05.2. Дрейф playback clock.** Позиция, вычисленная по таймеру, отстаёт/убегает от видео, активный сегмент «прыгает» | Средняя | Среднее: подсветка не там, автопрокрутка раздражает | D4: только `video.currentTime`, троттлинг 4 Гц, немедленное обновление на `seeked`; тест границ; откат — снизить частоту до 2 Гц и обновлять активный сегмент только на `timeupdate` (контракт не меняется) |
| **R-05.3. Автопрокрутка дерётся с ручной прокруткой.** Пользователь листает вверх, а панель возвращает к активному сегменту | Высокая | Среднее: панелью невозможно пользоваться во время воспроизведения | D5: follow mode, пауза на 5 с после ручного скролла, кнопка «К текущему»; RTL-тест; откат — follow выключен по умолчанию, включается кнопкой (флаг `vl.ui.playerFollow`, `{v:1, value}`) |
| **R-05.4. Неподдерживаемые контейнеры (`mkv/avi/mov`).** TARGET §3.1 требует их индексировать, но предпросмотр в Chromium невозможен | Высокая | Высокое: часть библиотеки нельзя смотреть в приложении | D13: явный оверлей + «Показать в папке»; панель таймингов и клик по таймкоду остаются рабочими; откат — транскодинг для предпросмотра (M9) в `cache/preview`, решение — открытый вопрос §4 |
| **R-05.5. Токен в query (D2) утекает.** URL медиа может попасть в referrer, историю, лог | Средняя | Высокое: локальный токен = доступ к API | `Referrer-Policy: no-referrer`, вырезание query из логов, токен только в памяти, 127.0.0.1; откат — одноразовые подписанные URL `?st=…` с TTL 5 мин (точечная правка `mediaUrl`) |

## 10. Трассировка и ссылки

**Ссылки:**
- `../TARGET.md` §2.4 (плеер, таймлайн, панель таймингов, раскладка), §3.3 (переход из поиска на `start_ms`), §3.5 (метки — отображение на таймлайне), §4 (API `stream`/`thumb`/`segments`), §6 M5 («Готово, когда»), §7 п.5 и п.8, §8 (отзывчивость UI, диск).
- `./00-conventions.md` §2 A4/A6/A12/A14, §4 (эндпоинты M5), §6 (`window.vl`), §7 (`cache/thumbs`, `VL_DATA_DIR`), §9 (e2e M5), §12 (точка расширения M7 на таймлайне/панели).
- `./09-polish-m9.md` §4.5 — канонические ключи `localStorage` и обёртка `{v:1, value}`; M5 вводит механизм и ключи таймингов раньше, M9 переиспользует его для темы/сортировки/сброса и добавляет «Сбросить UI-состояние».
- `./02-library-m2.md` — открытие файла, `revealInExplorer`, удаление из индекса; `./03-transcription-m3.md` — сегменты, SSE-статусы, `enqueue`/`reprocess`; `./04-search-m4.md` — приём `video_id` + `start_ms`; `./06-tags-m6.md` — бейджи тегов; `./07-annotations-m7.md` — создание/редактирование меток, drag-границ, контекстное меню; `./08-packaging-m8.md` — ffmpeg в `resources`.

**Критерий `../TARGET.md` §7 → проверка:**

| Критерий | Чем проверяется в M5 |
|---|---|
| п.5 «Тайминг»: клик по сегменту → плавный seek; активный сегмент подсвечивается и автопрокручивается | RTL `TimingPanel.test.tsx`, `playerStore.test.ts`, e2e `player.spec.ts`, ручной сценарий |
| п.8 «Перезапуск» (в части размеров панелей и позиции) | vitest `uiStore.test.ts`, e2e-перезапуск, ручная проверка |
| §8 «UI отзывчив при транскрипции» | e2e под нагрузкой (мок SSE) + ручная проверка; полный замер — план 10 |

**Требование → раздел/задача:**

| Требование | Где реализуется |
|---|---|
| `<video>` плеер: play/pause, ±5 с, громкость, fullscreen, `J/K/L`, `Space`, `←/→`, крупное время | §3 D3/D4, §6, T-05.3 |
| `/stream` 206 Range | §3 D1, §4, T-05.1 |
| Интеграция `/thumb` (кэш M2, blob-постер, 404 → placeholder) | §3 D2/D14, §4, T-05.2 |
| Панель таймингов: строки, активный сегмент, автопрокрутка nearest, клик → seek | §3 D4/D5, §6, T-05.4/T-05.5 |
| «Транскрипция ещё не готова» + «Обработать сейчас» | §3 D12, §6, T-05.5 |
| Таймлайн: блоки сегментов (синий 15%, tooltip), маркеры меток, клик → seek, скраббинг | §3 D6/D7/D8, §6, T-05.6 |
| Ресайз/сворачивание, `localStorage`, восстановление позиции | §3 D9/D10, §6, T-05.7 |
| e2e-smoke Playwright | §7, T-05.8 |
| Контракт рендера маркеров для M7 (только отображение и клик → seek) | §3 D8, §4, T-05.6 |
| Геометрия `msToPx`/`pxToMs` для M7 (drag/resize) | §3 D6, §4, T-05.6 |
