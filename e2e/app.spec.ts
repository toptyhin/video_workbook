import { expect, request, test, type APIRequestContext } from '@playwright/test';

const TOKEN = 'e2e-token';
const API = 'http://127.0.0.1:8899';

test.describe.configure({ mode: 'serial' });

let api: APIRequestContext;

test.beforeAll(async () => {
  api = await request.newContext({
    baseURL: API,
    extraHTTPHeaders: { 'X-VL-Token': TOKEN },
  });
});

test.afterAll(async () => {
  await api.dispose();
});

async function waitForVideos(expected: number, timeout = 60_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const response = await api.get('/api/videos');
    const body = (await response.json()) as { total: number };
    if (body.total >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`library did not reach ${expected} videos`);
}

async function waitForStatus(title: string, statuses: string[], timeout = 180_000): Promise<void> {
  const deadline = Date.now() + timeout;
  let last = '';
  while (Date.now() < deadline) {
    const response = await api.get('/api/videos', { params: { limit: 100 } });
    const body = (await response.json()) as { items: { title: string; status: string; error: string | null }[] };
    const video = body.items.find((item) => item.title === title);
    if (video) {
      last = `${video.status}${video.error ? ` (${video.error})` : ''}`;
      if (statuses.includes(video.status)) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`status of ${title} not reached (last: ${last})`);
}

test('библиотека загружается и показывает файлы', async ({ page }) => {
  await waitForVideos(4);
  await page.goto('/');
  await expect(page.locator('.vl-toolbar')).toBeVisible();
  await expect(page.locator('.vl-table')).toBeVisible();
  await expect(page.locator('.vl-table tbody tr')).toHaveCount(4, { timeout: 30_000 });
  await expect(page.locator('.vl-table__title', { hasText: 'lesson-01.webm' })).toBeVisible();
});

test('открытие видео и панель таймингов с транскрипцией', async ({ page }) => {
  await waitForStatus('lesson-03.webm', ['done']);
  await page.goto('/');
  const row = page.locator('.vl-table tbody tr', { hasText: 'lesson-03.webm' });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.dblclick();
  await expect(page.locator('video')).toBeVisible();
  await expect(page.locator('.vl-segment-row').first()).toBeVisible({ timeout: 20_000 });
});

test('несовместимый формат предлагает внешний плеер (CTA + диалог)', async ({ page }) => {
  await page.goto('/');
  const row = page.locator('.vl-table tbody tr', { hasText: 'lesson-04-unsupported.mkv' });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.dblclick();
  const cta = page.locator('.vl-player__overlay--external');
  await expect(cta).toBeVisible({ timeout: 20_000 });
  await expect(cta).toContainText('Браузер не декодирует');
  await cta.getByRole('button', { name: 'Смотреть во внешнем плеере' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('#vl-launch-player')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Отмена' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Отмена' }).click();
  await expect(dialog).toBeHidden();
});

test('высоту панели предпросмотра можно менять', async ({ page }) => {
  await page.goto('/');
  const row = page.locator('.vl-table tbody tr', { hasText: 'lesson-03.webm' });
  await row.dblclick();
  await expect(page.locator('.vl-segment-row').first()).toBeVisible({ timeout: 20_000 });
  const preview = page.locator('.vl-app__preview');
  const before = await preview.evaluate((element) => element.getBoundingClientRect().height);
  await page.locator('.vl-app__splitter').focus();
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  const after = await preview.evaluate((element) => element.getBoundingClientRect().height);
  expect(after).toBeGreaterThan(before);
  // значение переживает перезагрузку страницы
  const stored = await page.evaluate(() => window.localStorage.getItem('vl.ui.previewHeight'));
  expect(stored).toContain('v');
});

test('создание метки через диалог', async ({ page }) => {
  await page.goto('/');
  const row = page.locator('.vl-table tbody tr', { hasText: 'lesson-03.webm' });
  await row.dblclick();
  await expect(page.locator('.vl-segment-row').first()).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: '＋ метка' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Начало').fill('00:01.000');
  await dialog.getByLabel('Конец').fill('00:02.000');
  await dialog.getByLabel('Название').fill('важный пример');
  await dialog.getByRole('button', { name: 'Сохранить' }).click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });
  await expect(page.locator('.vl-marker').first()).toBeVisible({ timeout: 15_000 });
  const response = await api.get('/api/annotations', { params: { q: 'важный пример' } });
  const body = (await response.json()) as { total: number; items: { start_ms: number }[] };
  expect(body.total).toBeGreaterThanOrEqual(1);
  expect(body.items[0].start_ms).toBe(1000);
});

test('поиск по меткам с переходом на таймкод', async ({ page }) => {
  await page.goto('/');
  const row = page.locator('.vl-table tbody tr', { hasText: 'lesson-03.webm' });
  await row.dblclick();
  await expect(page.locator('.vl-segment-row').first()).toBeVisible({ timeout: 20_000 });
  await page.getByLabel('Область поиска').selectOption('annotations');
  await page.getByRole('searchbox', { name: 'Поиск' }).fill('важный');
  const search = page.locator('.vl-search');
  await expect(search).toBeVisible({ timeout: 15_000 });
  const result = search.locator('.vl-search__item', { hasText: 'важный пример' }).first();
  await expect(result).toBeVisible({ timeout: 15_000 });
  await result.click();
  await expect(page.locator('.vl-controls__time-current')).toHaveText('00:01', { timeout: 15_000 });
});

test('панель «Метки» показывает метку и делает скриншот', async ({ page }) => {
  await page.goto('/');
  const row = page.locator('.vl-table tbody tr', { hasText: 'lesson-03.webm' });
  await row.dblclick();
  await expect(page.locator('.vl-segment-row').first()).toBeVisible({ timeout: 20_000 });
  await page.getByRole('tab', { name: 'Метки' }).click();
  const list = page.locator('.vl-annotation-list');
  await expect(list).toBeVisible();
  await expect(list).toContainText('важный пример', { timeout: 20_000 });
  await page.waitForTimeout(600);
  await page.screenshot({ path: 'docs/screens/app.png', fullPage: false });
});
