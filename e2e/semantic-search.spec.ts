/**
 * E2E семантического поиска и регрессии раскладки панели результатов (M12).
 *
 * Контракт: plans/12-semantic-search.md §5 (e2e). Выполняется serial и ПОСЛЕ
 * app.spec.ts/recording.spec.ts (порядок файлов), поэтому lesson-03 уже
 * транскрибирован; при одиночном запуске спека сама ждёт появления семантического
 * индекса (`GET /api/search/semantic/status`) и lesson-03 в семантических
 * результатах (до 180 с: транскрипция + autoindex после `VL_EMBED_AUTOINDEX=1`).
 *
 * Модель multilingual-e5-small ONNX int8 лежит в resources/models; если её нет
 * (или onnxruntime недоступен) — тесты помечаются skip, а не падают.
 */
import { expect, request, test, type APIRequestContext, type Page } from '@playwright/test';

const TOKEN = 'e2e-token';
const API = 'http://127.0.0.1:8899';
const LESSON = 'lesson-03.webm';
/** Запрос из плана: FTS не находит морфологические формы, семантика обязана найти lesson-03. */
const MORPH_QUERY = 'как найти производную сложной функции';
/** Запрос для UI-сценария (панель режимов/гибрид). */
const QUERY = 'производные сложных функций';

interface SemanticStatus {
  available: boolean;
  model: string;
  dim: number;
  indexed_segments: number;
  total_segments: number;
  indexing: boolean;
  autoindex: boolean;
  detail: string | null;
}

interface SearchItem {
  kind: 'file' | 'segment' | 'annotation';
  video_id: number;
  video_title: string;
  segment_id?: number;
  annotation_id?: number;
  start_ms?: number;
  score: number;
  semantic?: boolean;
}

interface SearchResponse {
  query: {
    raw: string;
    mode?: string;
    mode_used?: string;
    semantic?: SemanticStatus;
    took_ms?: number;
  };
  total: number;
  items: SearchItem[];
}

interface VideoRow {
  id: number;
  title: string | null;
}

interface RecordedEvent {
  type: string;
  detail?: { videoId?: number; ms?: number };
}

test.describe.configure({ mode: 'serial' });

let api: APIRequestContext;
let lesson03Id = 0;
let ready = false;
let skipReason = '';
let initialStatus: SemanticStatus | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Формат как frontend `lib/time.ts:formatTimecode` (MM:SS или H:MM:SS). */
function formatTimecode(ms: number): string {
  const total = Math.max(0, Math.round(ms));
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  const seconds = Math.floor((total % 60_000) / 1000);
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

async function semanticStatus(): Promise<SemanticStatus> {
  const response = await api.get('/api/search/semantic/status');
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as SemanticStatus;
}

async function searchApi(query: string, mode: 'fts' | 'semantic' | 'hybrid', scope = 'segments'): Promise<SearchResponse> {
  const response = await api.get('/api/search', {
    params: { q: query, mode, scope, limit: 50 },
  });
  expect(response.status(), `search ${mode}: ${query}`).toBe(200);
  return (await response.json()) as SearchResponse;
}

function isLessonSegment(item: SearchItem, videoId: number): boolean {
  return item.kind === 'segment' && item.video_id === videoId;
}

test.beforeAll(async () => {
  api = await request.newContext({ baseURL: API, extraHTTPHeaders: { 'X-VL-Token': TOKEN } });
  try {
    const response = await api.get('/api/videos', { params: { limit: 100 } });
    const body = (await response.json()) as { items: VideoRow[] };
    lesson03Id = body.items.find((video) => video.title === LESSON)?.id ?? 0;
  } catch {
    lesson03Id = 0;
  }

  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    try {
      const status = await semanticStatus();
      initialStatus = status;
      // Модели/onnxruntime нет — ждать бессмысленно, помечаем skip с причиной.
      if (!status.available && status.detail && /модел|onnx|runtime/i.test(status.detail)) {
        skipReason = `семантика недоступна: ${status.detail}`;
        return;
      }
      if (status.available && status.indexed_segments > 0 && lesson03Id > 0) {
        // Ждём именно lesson-03: index_video вызывается после транскрипции (autoindex/queue hook).
        const response = await api.get('/api/search', {
          params: { q: MORPH_QUERY, mode: 'semantic', scope: 'segments', limit: 50 },
        });
        if (response.ok()) {
          const body = (await response.json()) as SearchResponse;
          if (body.items.some((item) => isLessonSegment(item, lesson03Id))) {
            ready = true;
            return;
          }
        }
      }
    } catch {
      /* сервер ещё поднимается/транскрибирует */
    }
    await sleep(500);
  }
  skipReason = `семантический индекс не готов за 180 с: ${JSON.stringify(initialStatus)}`;
});

test.afterAll(async () => {
  await api.dispose();
});

test.beforeEach(() => {
  test.skip(!ready, skipReason || 'семантика недоступна');
});

async function installEventRecorder(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const target = window as unknown as { __vlEvents?: RecordedEvent[] };
    target.__vlEvents = [];
    const push = (type: string, event: Event): void => {
      const detail = (event as CustomEvent<RecordedEvent['detail']>).detail;
      target.__vlEvents?.push({ type, detail });
    };
    window.addEventListener('vl:open', (event) => push('vl:open', event));
    window.addEventListener('vl:seek', (event) => push('vl:seek', event));
  });
}

async function recordedEvents(page: Page): Promise<RecordedEvent[]> {
  return page.evaluate(
    () => (window as unknown as { __vlEvents?: RecordedEvent[] }).__vlEvents ?? [],
  );
}

test('семантика и гибрид находят lesson-03, режимы, seek и переиндексация', async ({ page }) => {
  // ---------- API: контраст FTS vs semantic на морфологическом запросе ----------
  const fts = await searchApi(MORPH_QUERY, 'fts');
  expect(fts.query.mode_used).toBe('fts');
  expect(
    fts.items.filter((item) => isLessonSegment(item, lesson03Id)),
    'FTS не должен находить морфологически отличный запрос',
  ).toHaveLength(0);

  const semantic = await searchApi(MORPH_QUERY, 'semantic');
  expect(semantic.query.mode_used).toBe('semantic');
  expect(semantic.query.semantic?.available).toBe(true);
  expect(semantic.items.every((item) => item.kind === 'segment')).toBe(true);
  const semanticTop = semantic.items.find((item) => isLessonSegment(item, lesson03Id));
  expect(semanticTop, 'семантика должна найти lesson-03').toBeTruthy();
  expect(semanticTop?.semantic).toBe(true);
  expect(semanticTop?.score ?? 0).toBeGreaterThan(0.5);
  expect(semantic.query.took_ms ?? 0).toBeLessThan(1000);

  // ---------- API: гибрид/RRF ----------
  const hybrid = await searchApi(QUERY, 'hybrid');
  expect(hybrid.query.mode_used).toBe('hybrid');
  expect(hybrid.query.semantic?.available).toBe(true);
  const hybridItem = hybrid.items.find((item) => isLessonSegment(item, lesson03Id));
  expect(hybridItem, 'гибрид должен включать сегмент lesson-03').toBeTruthy();
  expect(hybridItem?.semantic).toBe(true);
  expect(hybridItem?.score ?? 0).toBeGreaterThan(0);
  expect(hybrid.query.took_ms ?? 0).toBeLessThan(1000);

  // ---------- UI: режим «Гибрид» (default) + «Семантика», чип и переход ----------
  await installEventRecorder(page);
  await page.goto('/');
  await expect(page.locator('.vl-toolbar')).toBeVisible();
  await page.getByLabel('Область поиска').selectOption('segments');
  await page.getByRole('searchbox', { name: 'Поиск' }).fill(QUERY);

  const panel = page.locator('.vl-search');
  await expect(panel).toBeVisible({ timeout: 30_000 });
  await expect(panel).toHaveAttribute('data-search-mode', 'hybrid', { timeout: 20_000 });
  await expect(panel.getByRole('group', { name: 'Режим' })).toBeVisible();

  const lessonResult = panel.locator('.vl-search__item').filter({ hasText: LESSON }).first();
  await expect(lessonResult).toBeVisible({ timeout: 60_000 });
  await expect(lessonResult.locator('.vl-search__semantic-badge')).toBeVisible();
  await expect(lessonResult.locator('.vl-search__time')).toHaveText(/^\d{2}:\d{2}$/);

  const semanticMode = panel.getByRole('button', { name: 'Семантика', exact: true });
  await expect(semanticMode).toBeEnabled();
  const semanticResponse = page.waitForResponse(
    (response) =>
      response.url().includes('/api/search?') &&
      new URL(response.url()).searchParams.get('mode') === 'semantic' &&
      response.ok(),
    { timeout: 30_000 },
  );
  await semanticMode.click();
  await semanticResponse;
  await expect(panel).toHaveAttribute('data-search-mode', 'semantic');
  await expect(lessonResult).toBeVisible({ timeout: 30_000 });
  await expect(lessonResult.locator('.vl-search__semantic-badge')).toBeVisible();

  const hybridMode = panel.getByRole('button', { name: 'Гибрид', exact: true });
  const hybridResponse = page.waitForResponse(
    (response) =>
      response.url().includes('/api/search?') &&
      new URL(response.url()).searchParams.get('mode') === 'hybrid' &&
      response.ok(),
    { timeout: 30_000 },
  );
  await hybridMode.click();
  await hybridResponse;
  await expect(panel).toHaveAttribute('data-search-mode', 'hybrid');
  await expect(lessonResult).toBeVisible({ timeout: 30_000 });

  // Кнопка переиндексации доступна в панели (сам API-reindex проверяется ниже).
  await expect(panel.getByRole('button', { name: 'Переиндексировать', exact: true })).toBeEnabled();

  // Клик по результату → vl:open/vl:seek и плеер на таймкоде сегмента.
  const expectedStartMs = hybridItem?.start_ms ?? 0;
  await lessonResult.click();
  await expect(page.locator('video')).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(async () => (await page.locator('video').getAttribute('src')) ?? '', { timeout: 20_000 })
    .toContain(`/api/videos/${lesson03Id}/stream`);

  const events = await recordedEvents(page);
  const openEvent = events.find(
    (event) => event.type === 'vl:open' && event.detail?.videoId === lesson03Id,
  );
  expect(openEvent, 'vl:open с videoId lesson-03').toBeTruthy();
  const seekEvent = events.find(
    (event) => event.type === 'vl:seek' && event.detail?.videoId === lesson03Id,
  );
  expect(seekEvent, 'vl:seek с videoId lesson-03').toBeTruthy();
  expect(seekEvent?.detail?.ms).toBe(expectedStartMs);
  await expect(page.locator('.vl-controls__time-current')).toHaveText(
    formatTimecode(expectedStartMs),
    { timeout: 20_000 },
  );

  // ---------- API: принудительная переиндексация ----------
  const reindexResponse = await api.post('/api/search/semantic/reindex', { data: { force: true } });
  expect(reindexResponse.status()).toBe(202);
  const reindexBody = (await reindexResponse.json()) as SemanticStatus & { state: string };
  expect(reindexBody.state).toBe('indexing');
  expect(reindexBody.indexing).toBe(true);
  await expect
    .poll(async () => (await semanticStatus()).indexing, {
      timeout: 120_000,
      intervals: [250, 500, 1000, 2000],
    })
    .toBe(false);
  const after = await semanticStatus();
  expect(after.indexed_segments).toBeGreaterThan(0);
  expect(after.total_segments).toBeGreaterThan(0);
  expect(after.detail).toBeNull();
});

test('регрессия раскладки: результаты под вкладками, список заменён, ничего не обрезано', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.vl-toolbar')).toBeVisible();
  await page.getByLabel('Область поиска').selectOption('segments');
  const searchInput = page.getByRole('searchbox', { name: 'Поиск' });
  await searchInput.fill(QUERY);

  const panel = page.locator('.vl-search');
  await expect(panel).toBeVisible({ timeout: 30_000 });
  await expect(panel.locator('.vl-search__item').first()).toBeVisible({ timeout: 60_000 });

  const geometry = await page.evaluate(() => {
    const main = document.querySelector<HTMLElement>('.vl-app__main');
    const viewbar = document.querySelector<HTMLElement>('.vl-app__viewbar');
    const search = document.querySelector<HTMLElement>('.vl-search');
    const list = document.querySelector<HTMLElement>('.vl-search__list');
    if (!main || !viewbar || !search) return null;
    const searchRect = search.getBoundingClientRect();
    const viewbarRect = viewbar.getBoundingClientRect();
    const items = Array.from(search.querySelectorAll<HTMLElement>('.vl-search__item'));
    const lastItem = items.length > 0 ? items[items.length - 1] : null;
    const listRect = list ? list.getBoundingClientRect() : searchRect;
    return {
      searchTop: searchRect.top,
      searchBottom: searchRect.bottom,
      searchHeight: searchRect.height,
      viewbarBottom: viewbarRect.bottom,
      insideMain: main.contains(search),
      appListAbsent: document.querySelector('.vl-app__list') === null,
      itemCount: items.length,
      lastItemBottom: lastItem ? lastItem.getBoundingClientRect().bottom : null,
      listBottom: listRect.bottom,
      listOverflowY: list ? getComputedStyle(list).overflowY : null,
      listScrollHeight: list ? list.scrollHeight : null,
      listClientHeight: list ? list.clientHeight : null,
      searchOverflow: getComputedStyle(search).overflow,
    };
  });
  expect(geometry, '.vl-app__main/.vl-app__viewbar/.vl-search должны существовать').not.toBeNull();
  const g = geometry as NonNullable<typeof geometry>;

  // Панель начинается под таб-баром и живёт внутри основной колонки.
  expect(g.searchTop).toBeGreaterThanOrEqual(g.viewbarBottom - 1);
  expect(g.insideMain).toBe(true);
  // При активном поиске список файлов/меток заменён панелью результатов.
  expect(g.appListAbsent).toBe(true);
  expect(g.searchHeight).toBeGreaterThan(120);
  expect(g.itemCount).toBeGreaterThan(0);
  // Последняя строка не обрезана нижней границей панели/таб-баром.
  expect(g.lastItemBottom).not.toBeNull();
  expect(g.lastItemBottom as number).toBeLessThanOrEqual(g.listBottom + 1);
  // Список скроллится внутри панели, а не выпирает из неё.
  expect(g.listOverflowY).toBe('auto');
  expect(g.listBottom).toBeLessThanOrEqual(g.searchBottom + 1);
  if ((g.listScrollHeight ?? 0) > (g.listClientHeight ?? 0) + 1) {
    expect(g.searchOverflow).toContain('hidden');
  }

  // Скриншот для docs (панель результатов под вкладками + переключатель режимов).
  await page.screenshot({ path: 'docs/screens/search-results.png', fullPage: false });

  // Вкладка «Файлы» закрывает поиск и возвращает список.
  await page.locator('.vl-app__viewbar').getByRole('tab', { name: 'Файлы', exact: true }).click();
  await expect(page.locator('.vl-app__list')).toBeVisible();
  await expect(page.locator('.vl-search')).toHaveCount(0);
  await expect(searchInput).toHaveValue('');

  // Кнопка «×» делает то же самое.
  await searchInput.fill(QUERY);
  await expect(page.locator('.vl-search')).toBeVisible({ timeout: 30_000 });
  await page.locator('.vl-search__close').click();
  await expect(page.locator('.vl-app__list')).toBeVisible();
  await expect(page.locator('.vl-search')).toHaveCount(0);
  await expect(searchInput).toHaveValue('');
});
