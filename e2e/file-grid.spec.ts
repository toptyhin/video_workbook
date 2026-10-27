import { expect, request, test, type APIRequestContext, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

/**
 * V5: блочный вид панели файлов и операции «Переместить/Скопировать в папку»
 * с историей адресатов (plans/15). Тесты serial: каждый шаг опирается на историю,
 * накопленную предыдущим. afterAll возвращает библиотеку в исходное состояние,
 * чтобы не влиять на остальные e2e-спеки.
 */

const TOKEN = 'e2e-token';
const API = 'http://127.0.0.1:8899';
const LIB = path.resolve('.tmp/e2e-videos/library');
const ARCHIVE = path.join(LIB, 'archive');
const SOURCE = path.join(LIB, 'lesson-01.webm');

test.describe.configure({ mode: 'serial' });

let api: APIRequestContext;

interface VideoRow {
  id: number;
  path: string;
  status: string;
}

async function videos(): Promise<VideoRow[]> {
  const response = await api.get('/api/videos', { params: { limit: 500 } });
  return ((await response.json()) as { items: VideoRow[] }).items;
}

async function pathOf(title: string): Promise<string | null> {
  const items = await videos();
  return items.find((item) => path.basename(item.path) === title)?.path ?? null;
}

async function openGrid(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('.vl-table')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Блоками' }).click();
  await expect(page.locator('.vl-filegrid')).toBeVisible();
}

async function openSubmenu(page: Page, action: 'Переместить в папку' | 'Скопировать в папку'): Promise<void> {
  const card = page.locator('.vl-filecard', { hasText: 'lesson-01.webm' }).first();
  await expect(card).toBeVisible({ timeout: 30_000 });
  await card.click({ button: 'right' });
  await page.getByRole('menuitem', { name: action }).hover();
  await expect(page.getByRole('menuitem', { name: 'Выбрать другую папку…' })).toBeVisible();
}

test.beforeAll(async () => {
  api = await request.newContext({ baseURL: API, extraHTTPHeaders: { 'X-VL-Token': TOKEN } });
  fs.mkdirSync(ARCHIVE, { recursive: true });
});

test.afterAll(async () => {
  // Тесты оставляют оригинал в корне библиотеки; подчищаем только копии в archive.
  try {
    for (const item of await videos()) {
      if (!item.path.startsWith(`${ARCHIVE}${path.sep}`)) continue;
      if (item.status === 'duplicate') {
        const response = await api.delete(`/api/videos/${item.id}`);
        if (response.status() !== 204) continue;
      } else {
        await api.post('/api/videos/transfer', {
          data: { action: 'move', ids: [item.id], destination: LIB },
        });
      }
      fs.rmSync(item.path, { force: true });
    }
  } catch {
    /* cleanup best-effort: не должен маскировать результаты тестов */
  }
  fs.rmSync(ARCHIVE, { recursive: true, force: true });
  await api.dispose();
});

test('блочный вид: 6 блоков в ряд по умолчанию и настраиваемое количество', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.vl-table')).toBeVisible({ timeout: 30_000 });

  await page.getByRole('button', { name: 'Блоками' }).click();
  const grid = page.locator('.vl-filegrid');
  await expect(grid).toBeVisible();
  await expect(page.locator('.vl-filecard')).toHaveCount(4);

  const columns = (): Promise<number> =>
    grid.evaluate(
      (element) => getComputedStyle(element).gridTemplateColumns.split(' ').filter(Boolean).length,
    );
  expect(await columns()).toBe(6);

  const select = page.getByLabel('Блоков в ряд');
  await expect(select).toHaveValue('6');
  await select.selectOption('4');
  await expect.poll(columns).toBe(4);

  // Режим и число блоков переживают перезагрузку (localStorage).
  await page.reload();
  await expect(page.locator('.vl-filegrid')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByLabel('Блоков в ряд')).toHaveValue('4');
  expect(await columns()).toBe(4);
});

test('подменю move/copy не обрезается у правого/нижнего края окна', async ({ page }) => {
  await openGrid(page);
  const viewport = page.viewportSize();
  if (!viewport) throw new Error('viewport is not set');

  // Открываем меню у самого правого нижнего угла: раньше подменю уходило за экран/обрезалось.
  const card = page.locator('.vl-filecard', { hasText: 'lesson-01.webm' }).first();
  await card.evaluate((element) => {
    element.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        button: 2,
        clientX: window.innerWidth - 10,
        clientY: window.innerHeight - 10,
        screenX: window.innerWidth - 10,
        screenY: window.innerHeight - 10,
      }),
    );
  });
  await page.getByRole('menuitem', { name: 'Переместить в папку' }).hover();

  const submenu = page.locator('[data-submenu="true"]');
  await expect(submenu).toBeVisible();
  // Подменю — портал вне корневого меню (иначе его обрезает overflow-y).
  await expect(page.locator('.vl-context-menu [data-submenu="true"]')).toHaveCount(0);

  const box = await submenu.boundingBox();
  expect(box).not.toBeNull();
  if (!box) return;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);

  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
});

test('перемещение в папку через диалог и запись в историю', async ({ page }) => {
  await openGrid(page);
  await openSubmenu(page, 'Переместить в папку');
  await page.getByRole('menuitem', { name: 'Выбрать другую папку…' }).click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Переместить в папку');
  await dialog.getByRole('button', { name: 'archive', exact: true }).click();
  await dialog.getByRole('button', { name: 'Переместить сюда' }).click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });

  await expect.poll(() => pathOf('lesson-01.webm'), { timeout: 30_000 }).toBe(
    path.join(ARCHIVE, 'lesson-01.webm'),
  );
  const settings = (await (await api.get('/api/settings')).json()) as {
    'files.recent_destinations': string[];
  };
  expect(settings['files.recent_destinations'][0]).toBe(ARCHIVE);
});

test('диалог позволяет подняться в родительскую папку и вернуть файл', async ({ page }) => {
  await openGrid(page);
  await openSubmenu(page, 'Переместить в папку');
  await page.getByRole('menuitem', { name: 'Выбрать другую папку…' }).click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '↑ На уровень выше' }).click();
  await dialog.getByRole('button', { name: 'Переместить сюда' }).click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });

  await expect.poll(() => pathOf('lesson-01.webm'), { timeout: 30_000 }).toBe(SOURCE);
  const settings = (await (await api.get('/api/settings')).json()) as {
    'files.recent_destinations': string[];
  };
  expect(settings['files.recent_destinations'][0]).toBe(LIB);
});

test('история перемещений предлагает адресата и повторное перемещение работает', async ({ page }) => {
  await openGrid(page);
  await openSubmenu(page, 'Переместить в папку');
  // В подменю должны быть и история (archive), и выбор новой папки.
  await expect(page.getByRole('menuitem', { name: 'archive', exact: true })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Выбрать другую папку…' })).toBeVisible();
  await page.getByRole('menuitem', { name: 'archive', exact: true }).click();

  await expect.poll(() => pathOf('lesson-01.webm'), { timeout: 30_000 }).toBe(
    path.join(ARCHIVE, 'lesson-01.webm'),
  );

  // Возвращаем файл в корень библиотеки тем же механизмом истории — оригинал
  // должен оставаться в LIB, чтобы не влиять на остальные e2e-спеки.
  await page.goto('/');
  await page.getByRole('button', { name: 'Блоками' }).click();
  await openSubmenu(page, 'Переместить в папку');
  await expect(page.getByRole('menuitem', { name: 'library', exact: true })).toBeVisible();
  await page.getByRole('menuitem', { name: 'library', exact: true }).click();
  await expect.poll(() => pathOf('lesson-01.webm'), { timeout: 30_000 }).toBe(SOURCE);
});

test('копирование в папку создаёт помеченную копию и не трогает оригинал', async ({ page }) => {
  await openGrid(page);
  await openSubmenu(page, 'Скопировать в папку');
  // Оригинал лежит в корне библиотеки, поэтому копируем в archive из истории.
  await expect(page.getByRole('menuitem', { name: 'archive', exact: true })).toBeVisible();
  await page.getByRole('menuitem', { name: 'archive', exact: true }).click();

  const copyPath = path.join(ARCHIVE, 'lesson-01.webm');
  await expect
    .poll(
      async () => {
        const items = await videos();
        return items.some((item) => item.path === copyPath && item.status === 'duplicate');
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  // Оригинал остался на месте.
  expect((await videos()).some((item) => item.path === SOURCE && item.status !== 'duplicate')).toBe(true);
});
