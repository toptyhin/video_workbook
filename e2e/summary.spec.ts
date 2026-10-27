import { expect, request, test, type APIRequestContext } from '@playwright/test';

const TOKEN = 'e2e-token';
const API = 'http://127.0.0.1:8899';

test.describe.configure({ mode: 'serial' });

let api: APIRequestContext;
let videoId = 0;

test.beforeAll(async () => {
  api = await request.newContext({ baseURL: API, extraHTTPHeaders: { 'X-VL-Token': TOKEN } });
});

test.afterAll(async () => {
  await api.dispose();
});

interface SummaryBody {
  state: string;
  max_level: number;
  levels: Record<string, { level: number; label: string; blocks: unknown[] }>;
  root_summary: string | null;
}

async function waitForStatus(title: string, timeout = 180_000): Promise<number> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const response = await api.get('/api/videos', { params: { limit: 100 } });
    const body = (await response.json()) as {
      items: { id: number; title: string; status: string }[];
    };
    const video = body.items.find((item) => item.title === title);
    if (video && video.status === 'done') return video.id;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`status of ${title} not reached`);
}

async function summaryBody(videoId: number): Promise<SummaryBody> {
  const response = await api.get(`/api/videos/${videoId}/summary`);
  return (await response.json()) as SummaryBody;
}

async function waitIdle(videoId: number, timeout = 120_000): Promise<SummaryBody> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const body = await summaryBody(videoId);
    if (!['outlining', 'splitting', 'summarizing'].includes(body.state)) return body;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error('summary manager did not become idle');
}

async function waitReady(videoId: number, timeout = 180_000): Promise<SummaryBody> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const body = await summaryBody(videoId);
    if (body.state === 'ready' && body.max_level > 0) return body;
    if (body.state === 'error') throw new Error(`summary error: ${JSON.stringify(body)}`);
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error('summary tree not ready');
}

test('динамическая шкала: число уровней = фактической глубине дерева', async ({ page }) => {
  videoId = await waitForStatus('lesson-03.webm');
  await waitIdle(videoId);
  await api.post(`/api/videos/${videoId}/summary`, { data: { level: 1, force: true } });
  const summary = await waitReady(videoId);
  const maxLevel = summary.max_level;
  expect(maxLevel).toBeGreaterThan(0);
  const rootLevel = summary.levels[String(maxLevel)];
  expect(rootLevel).toBeTruthy();
  expect(rootLevel.blocks.length).toBeGreaterThan(0);

  await page.goto('/');
  const row = page.locator('.vl-table tbody tr', { hasText: 'lesson-03.webm' });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.dblclick();
  await expect(page.locator('.vl-segment-row').first()).toBeVisible({ timeout: 20_000 });

  const scale = page.locator('[data-testid="detail-scale"]');
  const slider = scale.locator('[data-level]');
  await expect(scale).toBeVisible();
  // Уровень 0 = дословная транскрибация; шкала знает фактическое число уровней.
  await expect(slider).toHaveAttribute('data-level', '0');
  await expect(slider).toHaveAttribute('data-max-level', String(maxLevel));

  // Вниз по шкале (End) — минимальная детализация: корневое саммари.
  await slider.focus();
  await page.keyboard.press('End');
  await expect(slider).toHaveAttribute('data-level', String(maxLevel));
  const block = page.locator('[data-summary-block]').first();
  await expect(block).toBeVisible({ timeout: 20_000 });

  // Вверх (Home) — снова дословные сегменты.
  await slider.focus();
  await page.keyboard.press('Home');
  await expect(slider).toHaveAttribute('data-level', '0');
  await expect(page.locator('.vl-segment-row').first()).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('[data-summary-block]')).toHaveCount(0);
});


test('без готового дерева шкала позволяет открыть CTA и сгенерировать саммари', async ({ page }) => {
  // Имитируем ситуацию пользователя: summary.auto=false / дерева ещё нет.
  // Удаляем дерево через API и перезагружаем UI: maxLevel=0, но шкала должна
  // дать провизорную позицию «Саммари» и CTA «Сгенерировать».
  const response = await api.delete(`/api/videos/${videoId}/summary`);
  expect([204, 409]).toContain(response.status());
  await page.goto('/');
  const row = page.locator('.vl-table tbody tr', { hasText: 'lesson-03.webm' });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.dblclick();
  await expect(page.locator('.vl-segment-row').first()).toBeVisible({ timeout: 20_000 });

  const slider = page.locator('[data-testid="detail-scale"] [data-level]');
  await slider.focus();
  await page.keyboard.press('Home');
  await expect(slider).toHaveAttribute('data-level', '0');
  await page.keyboard.press('End');
  await expect(slider).toHaveAttribute('data-level', '1');
  // Провизорный уровень «Саммари» либо сразу запускает генерацию, либо показывает CTA.
  const generate = page.getByRole('button', { name: 'Сгенерировать' });
  if (await generate.isVisible().catch(() => false)) {
    await generate.click();
  }
  await expect(page.locator('[data-summary-block]').first()).toBeVisible({ timeout: 90_000 });
});
