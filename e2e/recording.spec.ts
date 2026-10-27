/**
 * E2E записи экрана/окна (M11) с mocked-захватом: Playwright-браузер не умеет
 * `desktopCapturer`, поэтому в страницу внедряются:
 *  - `window.vl` (все методы VLApi, включая getCaptureSources с двумя источниками),
 *  - `navigator.mediaDevices.getUserMedia`/`enumerateDevices` (фейковые потоки/треки),
 *  - `MediaRecorder` (эмитит реальный WebM VP9+Opus из `.tmp/e2e-videos/recording-fixture.webm`).
 * Остальной конвейер — настоящий: backend принимает чанки, финализирует ffmpeg,
 * регистрирует видео в библиотеке; UI играет результат встроенным плеером.
 *
 * Контракт: plans/11-screen-recording.md §7.3.
 * Внимание: e2e/app.spec.ts ждёт ровно 4 сидированных видео, поэтому:
 *  - файл выполняется serial и не меняет ожидания app.spec.ts;
 *  - все проверки количества — относительные (baseline total, +1 / +0).
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { expect, request, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';

import { installRecordingMock, RECORDING_SOURCES } from './recording-mock';

const TOKEN = 'e2e-token';
const API = 'http://127.0.0.1:8899';
const ROOT = process.cwd();
const FIXTURE_PATH = join(ROOT, '.tmp', 'e2e-videos', 'recording-fixture.webm');
const DATA_DIR = join(ROOT, '.tmp', 'e2e-data');

interface StartRecordingResponse {
  recording_id: string;
  system_audio: { active: boolean; detail: string | null };
}

interface FinishRecordingResponse {
  video_id: number;
  title: string;
  duration_ms: number;
  size_bytes: number;
  path: string;
  playback_mode: string;
}

interface VideoRow {
  id: number;
  title: string | null;
  status: string;
  duration_ms: number | null;
}


test.describe.configure({ mode: 'serial' });

let api: APIRequestContext;
let fixtureB64 = '';
let baselineTotal = 0;
let savedVideoId = 0;
let savedTitle = '';

function readFixtureB64(): string {
  return readFileSync(FIXTURE_PATH).toString('base64');
}

async function getTotal(context: APIRequestContext): Promise<number> {
  const response = await context.get('/api/videos', { params: { limit: 1 } });
  expect(response.ok()).toBeTruthy();
  const body = (await response.json()) as { total: number };
  return body.total;
}

async function findVideo(context: APIRequestContext, videoId: number): Promise<VideoRow> {
  const response = await context.get('/api/videos', { params: { limit: 500 } });
  expect(response.ok()).toBeTruthy();
  const body = (await response.json()) as { items: VideoRow[] };
  const item = body.items.find((video) => video.id === videoId);
  if (!item) throw new Error(`видео ${videoId} не найдено в библиотеке`);
  return item;
}

function recordingFiles(subdir: 'recordings' | 'tmp/recordings'): string[] {
  try {
    return readdirSync(join(DATA_DIR, subdir)).sort();
  } catch {
    return [];
  }
}

function isPostTo(response: { url(): string; request(): { method(): string } }, pattern: RegExp): boolean {
  return response.request().method() === 'POST' && pattern.test(new URL(response.url()).pathname);
}

function dialogLocator(page: Page): Locator {
  return page.getByRole('dialog').filter({ hasText: 'Запись экрана' }).first();
}

async function openRecordingDialog(page: Page): Promise<Locator> {
  await page.goto('/');
  await expect(page.locator('.vl-toolbar')).toBeVisible();
  await expect(page.locator('.vl-table')).toBeVisible({ timeout: 60_000 });
  // В browser-режиме без Electron кнопка тоже есть (диалог объясняет недоступность),
  // но с внедрённым window.vl.getCaptureSources запись доступна.
  const button = page.getByRole('button', { name: 'Запись экрана', exact: true }).first();
  await expect(button).toBeVisible({ timeout: 30_000 });
  await expect(button).toBeEnabled({ timeout: 15_000 });
  await button.click();
  const dialog = dialogLocator(page);
  await expect(dialog).toBeVisible({ timeout: 20_000 });
  // Источники приходят асинхронно через getCaptureSources (один из двух, вкладка по умолчанию любая).
  await expect(
    dialog.getByText(new RegExp(`${RECORDING_SOURCES[0].name}|${RECORDING_SOURCES[1].name}`)).first(),
  ).toBeVisible({ timeout: 20_000 });
  return dialog;
}

async function selectFirstSource(dialog: Locator): Promise<void> {
  const screenTab = dialog.getByRole('tab', { name: 'Весь экран', exact: true });
  if ((await screenTab.count()) > 0) await screenTab.first().click();
  // Источники — карточки с role="radio" (RecordDialog.tsx).
  const card = dialog.getByRole('radio', { name: new RegExp(RECORDING_SOURCES[0].name) });
  await expect(card.first()).toBeVisible({ timeout: 15_000 });
  await card.first().click();
  await expect(card.first()).toHaveAttribute('aria-checked', 'true');
}

async function chooseNoAudio(dialog: Locator): Promise<void> {
  // Явно «Без звука»: результат не зависит от того, доступен ли на машине
  // системный звук (pactl/PulseAudio) и микрофон.
  const none = dialog.getByRole('radio', { name: 'Без звука', exact: true });
  await expect(none).toBeVisible({ timeout: 10_000 });
  await none.check();
  await expect(none).toBeChecked();
}

function startButton(dialog: Locator): Locator {
  return dialog.getByRole('button', { name: 'Начать запись', exact: true });
}

function recorderBar(page: Page): Locator {
  return page.locator('.vl-recorder');
}

async function confirmCancelRecording(bar: Locator): Promise<void> {
  // Подтверждение инлайн в панели записи (RecorderBar.tsx): «Отменить запись».
  const discard = bar.getByRole('button', { name: 'Отменить запись', exact: true });
  await expect(discard).toBeVisible({ timeout: 10_000 });
  await discard.click();
}

async function mockEvents(page: Page): Promise<string[]> {
  return page.evaluate(
    () => (window as unknown as { __vlRecordingMock?: { events: string[] } }).__vlRecordingMock?.events ?? [],
  );
}

test.beforeAll(async () => {
  api = await request.newContext({
    baseURL: API,
    extraHTTPHeaders: { 'X-VL-Token': TOKEN },
  });
  if (!existsSync(FIXTURE_PATH)) return;
  fixtureB64 = readFixtureB64();
  baselineTotal = await getTotal(api);
});

test.afterAll(async () => {
  await api.dispose();
});

test.beforeEach(() => {
  // Фикстура генерируется scripts/e2e-server.sh (ffmpeg); без ffmpeg — пропуск.
  if (!existsSync(FIXTURE_PATH)) {
    test.skip(true, `нет фикстуры ${FIXTURE_PATH} (нужен ffmpeg)`);
    return;
  }
  fixtureB64 = readFixtureB64();
});

test('запись экрана: старт → пауза/продолжение → сохранение → встроенный плеер', async ({ page }) => {
  await page.addInitScript(installRecordingMock, { fixtureB64, sources: RECORDING_SOURCES });

  const dialog = await openRecordingDialog(page);
  await selectFirstSource(dialog);
  await chooseNoAudio(dialog);

  const startResponse = page.waitForResponse(
    (response) => isPostTo(response, /^\/api\/recordings$/),
    { timeout: 30_000 },
  );
  await startButton(dialog).click();
  const started = await startResponse;
  expect(started.status()).toBe(201);
  const startBody = (await started.json()) as StartRecordingResponse;
  expect(startBody.recording_id).toMatch(/^[0-9a-f]{32}$/);

  await expect(dialog).toBeHidden({ timeout: 20_000 });

  // Панель записи: статус «Запись», таймер HH:MM:SS, кнопки.
  const bar = recorderBar(page);
  await expect(bar).toBeVisible({ timeout: 30_000 });
  await expect(bar.locator('.vl-recorder__state')).toHaveText('Запись', { timeout: 20_000 });
  await expect(bar.locator('.vl-recorder__timer')).toHaveText(/^\d{2}:\d{2}:\d{2}$/);
  await expect(bar.getByRole('button', { name: 'Сохранить', exact: true })).toBeVisible();
  await expect(bar.getByRole('button', { name: 'Отменить', exact: true })).toBeVisible();

  // Живой предпросмотр в основной панели видео: тот же захваченный поток,
  // что кодирует MediaRecorder (второй захват не создаётся).
  const preview = page.locator('.vl-rec-preview');
  await expect(preview).toBeVisible({ timeout: 20_000 });
  await expect(preview.locator('.vl-rec-preview__badge')).toContainText('Запись');
  await expect(preview.locator('.vl-rec-preview__timer')).toHaveText(/^\d{2}:\d{2}:\d{2}$/);
  await expect(preview.locator('video.vl-rec-preview__video')).toBeVisible();
  await expect
    .poll(
      () =>
        preview
          .locator('video.vl-rec-preview__video')
          .evaluate((element) => Boolean((element as HTMLVideoElement).srcObject)),
      { timeout: 15_000 },
    )
    .toBe(true);

  // Пауза / продолжение (время паузы не идёт в длительность — проверяет recordStore).
  await bar.getByRole('button', { name: 'Пауза', exact: true }).click();
  await expect(bar.locator('.vl-recorder__state')).toHaveText('Пауза');
  await expect(preview.locator('.vl-rec-preview__badge')).toContainText('Пауза');
  await expect(bar.getByRole('button', { name: 'Продолжить', exact: true })).toBeVisible();
  await bar.getByRole('button', { name: 'Продолжить', exact: true }).click();
  await expect(bar.locator('.vl-recorder__state')).toHaveText('Запись');
  await expect(preview.locator('.vl-rec-preview__badge')).toContainText('Запись');

  // Сохранение: finish-ответ backend содержит video_id, duration_ms и playback_mode.
  const finishResponse = page.waitForResponse(
    (response) => isPostTo(response, /^\/api\/recordings\/[0-9a-f]{32}\/finish$/),
    { timeout: 60_000 },
  );
  await recorderBar(page).getByRole('button', { name: 'Сохранить', exact: true }).click();
  const finished = await finishResponse;
  expect(finished.status()).toBe(201);
  const finishedBody = (await finished.json()) as FinishRecordingResponse;
  expect(finishedBody.video_id).toBeGreaterThan(0);
  expect(finishedBody.duration_ms).toBeGreaterThan(0);
  expect(finishedBody.playback_mode).toBe('direct');
  expect(finishedBody.title.length).toBeGreaterThan(0);
  savedVideoId = finishedBody.video_id;
  savedTitle = finishedBody.title;

  // Toast «Запись сохранена: …» с действием «Обработать».
  const toast = page.locator('.vl-toast').filter({ hasText: 'Запись сохранена' }).first();
  await expect(toast).toBeVisible({ timeout: 30_000 });
  await expect(toast).toContainText(savedTitle);
  await expect(toast.getByRole('button', { name: /Обработать/ })).toBeVisible();

  // После сохранения предпросмотр уступает место обычному плееру.
  await expect(page.locator('.vl-rec-preview')).toHaveCount(0, { timeout: 20_000 });

  // API: библиотека выросла ровно на 1, запись pending, длительность > 0.
  await expect.poll(() => getTotal(api), { timeout: 30_000 }).toBe(baselineTotal + 1);
  const video = await findVideo(api, savedVideoId);
  expect(video.status).toBe('pending');
  expect(video.duration_ms ?? 0).toBeGreaterThan(0);

  // Прямой режим встроенного плеера (WebM VP9+Opus не требует внешнего плеера).
  const playback = await api.get(`/api/videos/${savedVideoId}/playback`);
  expect(playback.ok()).toBeTruthy();
  expect(((await playback.json()) as { mode: string }).mode).toBe('direct');

  // Файл финализирован в $VL_DATA_DIR/recordings, временные чанки убраны.
  expect(recordingFiles('recordings').length).toBeGreaterThanOrEqual(1);
  expect(recordingFiles('tmp/recordings')).toHaveLength(0);

  // Mocked-слой действительно использовался, треки остановлены (cleanup).
  const events = await mockEvents(page);
  expect(events).toEqual(
    expect.arrayContaining(['getUserMedia', 'recorder:start', 'recorder:data', 'recorder:stop']),
  );
  expect(events.some((event) => event.startsWith('track.stop'))).toBe(true);

  // Запись видна в библиотеке и открывается встроенным <video> (direct stream).
  const row = page.locator('.vl-table tbody tr', { hasText: savedTitle });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.dblclick();
  await expect(page.locator('video')).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(async () => (await page.locator('video').getAttribute('src')) ?? '', { timeout: 20_000 })
    .toContain(`/api/videos/${savedVideoId}/stream`);
});

test('отмена записи: библиотека не меняется, временные файлы удалены', async ({ page }) => {
  await page.addInitScript(installRecordingMock, { fixtureB64, sources: RECORDING_SOURCES });

  const totalBefore = await getTotal(api);
  const recordingsBefore = recordingFiles('recordings').length;

  const dialog = await openRecordingDialog(page);
  await selectFirstSource(dialog);
  await chooseNoAudio(dialog);

  const startResponse = page.waitForResponse(
    (response) => isPostTo(response, /^\/api\/recordings$/),
    { timeout: 30_000 },
  );
  await startButton(dialog).click();
  const started = await startResponse;
  expect(started.status()).toBe(201);
  const startBody = (await started.json()) as StartRecordingResponse;

  await expect(dialog).toBeHidden({ timeout: 20_000 });
  const bar = recorderBar(page);
  await expect(bar.locator('.vl-recorder__state')).toHaveText('Запись', { timeout: 30_000 });
  await expect(page.locator('.vl-rec-preview')).toBeVisible({ timeout: 20_000 });

  const cancelResponse = page.waitForResponse(
    (response) => isPostTo(response, /^\/api\/recordings\/[0-9a-f]{32}\/cancel$/),
    { timeout: 30_000 },
  );
  await bar.getByRole('button', { name: 'Отменить', exact: true }).click();
  await confirmCancelRecording(bar);

  const cancelled = await cancelResponse;
  expect(cancelled.status()).toBe(204);

  // Панель записи и предпросмотр исчезли, библиотека не изменилась, файлы сессии удалены.
  await expect(recorderBar(page)).toHaveCount(0, { timeout: 20_000 });
  await expect(page.locator('.vl-rec-preview')).toHaveCount(0, { timeout: 20_000 });
  await page.waitForTimeout(1_500);
  expect(await getTotal(api)).toBe(totalBefore);
  expect(recordingFiles('recordings').length).toBe(recordingsBefore);
  await expect.poll(() => recordingFiles('tmp/recordings').length, { timeout: 15_000 }).toBe(0);

  // Сессия удалена на backend (диагностический GET → 404).
  const session = await api.get(`/api/recordings/${startBody.recording_id}`);
  expect(session.status()).toBe(404);
});
