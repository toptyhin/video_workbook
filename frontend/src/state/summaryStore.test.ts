import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api/client', () => ({
  api: {
    summary: vi.fn(),
    generateSummary: vi.fn(),
    getSettings: vi.fn(),
  },
}));

import { api } from '../api/client';
import type { SummaryBlock, SummaryResponse } from '../api/types';
import {
  DETAIL_LEVEL_STORAGE_KEY,
  findActiveSummaryBlock,
  isSummaryLevelReady,
  maxSummaryLevel,
  readDetailLevel,
  summaryLevelBlocks,
  summaryLevelInfo,
  summaryLevelLabel,
  summaryLevelLabels,
  useSummaryStore,
} from './summaryStore';

// jsdom в этом окружении не даёт localStorage (Node experimental) — подменяем in-memory Storage.
function installMemoryStorage(): void {
  const data = new Map<string, string>();
  const storage: Storage = {
    get length(): number {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key: string) => data.get(key) ?? null,
    key: (index: number) => Array.from(data.keys())[index] ?? null,
    removeItem: (key: string) => {
      data.delete(key);
    },
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
  Object.defineProperty(window, 'localStorage', { value: storage, configurable: true, writable: true });
}

function block(
  nodeId: string,
  startMs: number,
  endMs: number,
  text: string,
  options: { title?: string | null; keywords?: string[] } = {},
): SummaryBlock {
  return {
    node_id: nodeId,
    start_ms: startMs,
    end_ms: endMs,
    title: options.title ?? null,
    text,
    ...(options.keywords ? { keywords: options.keywords } : {}),
  };
}

const READY_SUMMARY: SummaryResponse = {
  video_id: 1,
  state: 'ready',
  max_level: 3,
  levels: {
    '1': {
      level: 1,
      label: 'Подробно',
      blocks: [
        block('1', 60_000, 120_000, 'Второй блок', { title: 'Вторая тема', keywords: ['итог'] }),
        block('0', 0, 60_000, 'Первый блок', { title: 'Введение' }),
      ],
    },
    '2': {
      level: 2,
      label: 'Средне',
      blocks: [block('0', 0, 120_000, 'Сжато', { title: 'Обзор' })],
    },
    '3': {
      level: 3,
      label: 'Кратко',
      blocks: [block('0', 0, 120_000, 'Корневое саммари видео')],
    },
  },
  root_summary: 'Корневое саммари видео',
  model: { id: 'summary-lfm2.5-350m', label: 'KoarAI LFM2.5-350M-Thinking', installed: true },
  progress: null,
  detail: null,
  error_code: null,
};

function absentSummary(overrides: Partial<SummaryResponse> = {}): SummaryResponse {
  return {
    video_id: 1,
    state: 'absent',
    max_level: 0,
    levels: {},
    root_summary: null,
    model: { id: 'summary-lfm2.5-350m', label: 'KoarAI', installed: true },
    progress: null,
    detail: null,
    error_code: null,
    ...overrides,
  };
}

function resetStore(): void {
  useSummaryStore.setState({
    videoId: null,
    response: null,
    level: 0,
    maxLevel: 0,
    loading: false,
    generating: false,
    error: null,
    errorCode: null,
    modelMissing: false,
    enabled: true,
    settingsLoaded: false,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  installMemoryStorage();
  window.localStorage.clear();
  vi.mocked(api.summary).mockResolvedValue(READY_SUMMARY);
  vi.mocked(api.generateSummary).mockResolvedValue({ video_id: 1, state: 'summarizing', level: 2 });
  vi.mocked(api.getSettings).mockResolvedValue({ 'summary.enabled': true });
  resetStore();
});

describe('summaryStore (rev2, динамическая глубина)', () => {
  it('load читает max_level/levels/root_summary', async () => {
    await useSummaryStore.getState().load(1);

    expect(api.summary).toHaveBeenCalledWith(1);
    const state = useSummaryStore.getState();
    expect(state.videoId).toBe(1);
    expect(state.maxLevel).toBe(3);
    expect(state.response?.root_summary).toBe('Корневое саммари видео');
    expect(state.response?.levels['2']?.label).toBe('Средне');
    expect(state.loading).toBe(false);
    expect(state.generating).toBe(false);
    expect(state.modelMissing).toBe(false);
  });

  it('load клампит сохранённый уровень по фактической глубине дерева', async () => {
    useSummaryStore.setState({ level: 5 });
    await useSummaryStore.getState().load(1);
    expect(useSummaryStore.getState().level).toBe(3);
    expect(readDetailLevel()).toBe(3);
  });

  it('load не затирает сохранённый уровень, пока глубина дерева 0 (нет саммари)', async () => {
    useSummaryStore.setState({ level: 2 });
    vi.mocked(api.summary).mockResolvedValue(absentSummary());
    await useSummaryStore.getState().load(1);
    const state = useSummaryStore.getState();
    expect(state.maxLevel).toBe(0);
    expect(state.level).toBe(2);
  });

  it('load вычисляет глубину по ключам levels, если max_level не пришёл (совместимость)', async () => {
    vi.mocked(api.summary).mockResolvedValue({
      ...READY_SUMMARY,
      max_level: undefined as unknown as number,
    });
    await useSummaryStore.getState().load(1);
    expect(useSummaryStore.getState().maxLevel).toBe(3);
  });

  it('load определяет неустановленную модель (modelMissing)', async () => {
    vi.mocked(api.summary).mockResolvedValue(
      absentSummary({ model: { id: 'summary-qwen2.5-0.5b', label: 'Qwen', installed: false } }),
    );
    await useSummaryStore.getState().load(1);
    expect(useSummaryStore.getState().modelMissing).toBe(true);
  });

  it('load обрабатывает ошибку model_missing', async () => {
    vi.mocked(api.summary).mockRejectedValue(
      Object.assign(new Error('модель не установлена'), { status: 409, code: 'model_missing' }),
    );
    await useSummaryStore.getState().load(1);
    const state = useSummaryStore.getState();
    expect(state.loading).toBe(false);
    expect(state.modelMissing).toBe(true);
    expect(state.errorCode).toBe('model_missing');
    expect(state.error).toContain('модель не установлена');
  });

  it('generate(level) клампит уровень по max_level и перечитывает состояние', async () => {
    await useSummaryStore.getState().load(1);
    const ok = await useSummaryStore.getState().generate(9);
    expect(ok).toBe(true);
    expect(api.generateSummary).toHaveBeenCalledWith(1, 3, false);
    expect(api.summary).toHaveBeenCalledWith(1);
  });

  it('generate без уровня при level=0 не передаёт level', async () => {
    await useSummaryStore.getState().load(1);
    await useSummaryStore.getState().generate();
    expect(api.generateSummary).toHaveBeenCalledWith(1, undefined, false);
  });

  it('generate(force) передаёт force на бэкенд', async () => {
    await useSummaryStore.getState().load(1);
    await useSummaryStore.getState().generate(2, true);
    expect(api.generateSummary).toHaveBeenCalledWith(1, 2, true);
  });

  it('generate фиксирует ошибку model_missing', async () => {
    vi.mocked(api.generateSummary).mockRejectedValue(
      Object.assign(new Error('Сначала скачайте модель'), { status: 409, code: 'model_missing' }),
    );
    await useSummaryStore.getState().load(1);
    const ok = await useSummaryStore.getState().generate(2);
    expect(ok).toBe(false);
    const state = useSummaryStore.getState();
    expect(state.modelMissing).toBe(true);
    expect(state.errorCode).toBe('model_missing');
    expect(state.generating).toBe(false);
  });

  it('generate фиксирует summary_disabled и выключает саммари', async () => {
    vi.mocked(api.generateSummary).mockRejectedValue(
      Object.assign(new Error('саммари отключено'), { status: 409, code: 'summary_disabled' }),
    );
    await useSummaryStore.getState().load(1);
    await useSummaryStore.getState().generate(2);
    const state = useSummaryStore.getState();
    expect(state.enabled).toBe(false);
    expect(state.errorCode).toBe('summary_disabled');
  });

  it('setLevel персистит уровень и клампится по max_level', async () => {
    await useSummaryStore.getState().load(1);
    useSummaryStore.getState().setLevel(9);
    expect(useSummaryStore.getState().level).toBe(3);
    expect(readDetailLevel()).toBe(3);
    const raw = window.localStorage.getItem(DETAIL_LEVEL_STORAGE_KEY);
    expect(raw ? (JSON.parse(raw) as { value: number }).value : null).toBe(3);
  });

  it('setLevel(0) не запрашивает генерацию', async () => {
    await useSummaryStore.getState().load(1);
    useSummaryStore.getState().setLevel(0);
    expect(api.generateSummary).not.toHaveBeenCalled();
  });

  it('setLevel готового уровня не запрашивает генерацию', async () => {
    await useSummaryStore.getState().load(1);
    useSummaryStore.getState().setLevel(2);
    expect(api.generateSummary).not.toHaveBeenCalled();
  });

  it('setLevel недостающего уровня достраивает саммари, если дерево готово', async () => {
    await useSummaryStore.getState().load(1);
    useSummaryStore.setState({
      response: {
        ...READY_SUMMARY,
        levels: { '1': READY_SUMMARY.levels['1'], '2': READY_SUMMARY.levels['2'] },
      },
      maxLevel: 3,
    });
    useSummaryStore.getState().setLevel(3);
    await vi.waitFor(() => {
      expect(api.generateSummary).toHaveBeenCalledWith(1, 3, false);
    });
  });

  it('setLevel(1) при maxLevel=0 открывает провизорный «Саммари» и запускает генерацию', async () => {
    vi.mocked(api.summary).mockResolvedValue(absentSummary());
    await useSummaryStore.getState().load(1);
    expect(useSummaryStore.getState().maxLevel).toBe(0);
    useSummaryStore.getState().setLevel(1);
    expect(useSummaryStore.getState().level).toBe(1);
    await vi.waitFor(() => {
      expect(api.generateSummary).toHaveBeenCalledWith(1, 1, false);
    });
  });

  it('setLevel на неготовое саммари (absent) запускает генерацию уровня', async () => {
    vi.mocked(api.summary).mockResolvedValue(absentSummary());
    await useSummaryStore.getState().load(1);
    useSummaryStore.setState({ maxLevel: 2 });
    useSummaryStore.getState().setLevel(2);
    await vi.waitFor(() => {
      expect(api.generateSummary).toHaveBeenCalledWith(1, 2, false);
    });
  });

  it('setLevel при stale не запускает генерацию (CTA)', async () => {
    vi.mocked(api.summary).mockResolvedValue({ ...absentSummary({ state: 'stale' }), max_level: 2 });
    await useSummaryStore.getState().load(1);
    useSummaryStore.getState().setLevel(2);
    expect(api.generateSummary).not.toHaveBeenCalled();
  });

  it('generate не вызывается при выключенном саммари', async () => {
    useSummaryStore.setState({ enabled: false });
    const ok = await useSummaryStore.getState().generate(2);
    expect(ok).toBe(false);
    expect(api.generateSummary).not.toHaveBeenCalled();
  });

  it('loadSettings читает summary.enabled', async () => {
    vi.mocked(api.getSettings).mockResolvedValue({ 'summary.enabled': false });
    await useSummaryStore.getState().loadSettings(true);
    expect(useSummaryStore.getState().enabled).toBe(false);
    expect(useSummaryStore.getState().settingsLoaded).toBe(true);
  });

  it('applyEvent(summary.progress) обновляет прогресс и состояние по stage', async () => {
    await useSummaryStore.getState().load(1);
    useSummaryStore.getState().applyEvent({
      type: 'summary.progress',
      payload: { video_id: 1, stage: 'outline', done: 1, total: 3, percent: 15 },
    });
    let state = useSummaryStore.getState();
    expect(state.generating).toBe(true);
    expect(state.response?.state).toBe('outlining');
    expect(state.response?.progress).toEqual({ stage: 'outline', done: 1, total: 3, percent: 15 });

    useSummaryStore.getState().applyEvent({
      type: 'summary.progress',
      payload: { video_id: 1, stage: 'splitting', done: 2, total: 7, percent: 40 },
    });
    state = useSummaryStore.getState();
    expect(state.response?.state).toBe('splitting');
    expect(state.response?.progress?.done).toBe(2);

    useSummaryStore.getState().applyEvent({
      type: 'summary.progress',
      payload: { video_id: 1, stage: 'summarizing', done: 5, total: 9, percent: 80 },
    });
    expect(useSummaryStore.getState().response?.state).toBe('summarizing');
  });

  it('applyEvent(summary.progress) игнорирует чужое видео', async () => {
    await useSummaryStore.getState().load(1);
    useSummaryStore.getState().applyEvent({
      type: 'summary.progress',
      payload: { video_id: 99, stage: 'outline', done: 1, total: 2, percent: 50 },
    });
    expect(useSummaryStore.getState().response?.progress).toBeNull();
    expect(useSummaryStore.getState().generating).toBe(false);
  });

  it('applyEvent(summary.state) для generating-состояний включает генерацию', async () => {
    await useSummaryStore.getState().load(1);
    useSummaryStore.getState().applyEvent({
      type: 'summary.state',
      payload: { video_id: 1, state: 'splitting' },
    });
    expect(useSummaryStore.getState().generating).toBe(true);
    expect(useSummaryStore.getState().response?.state).toBe('splitting');
  });

  it('applyEvent(summary.state=ready) перечитывает состояние с сервера', async () => {
    await useSummaryStore.getState().load(1);
    vi.mocked(api.summary).mockClear();
    useSummaryStore.getState().applyEvent({
      type: 'summary.state',
      payload: { video_id: 1, state: 'ready' },
    });
    await vi.waitFor(() => {
      expect(api.summary).toHaveBeenCalledWith(1);
    });
  });

  it('reset очищает видео/ответ, но сохраняет персистентный уровень', async () => {
    await useSummaryStore.getState().load(1);
    useSummaryStore.getState().setLevel(2);
    useSummaryStore.getState().reset();
    const state = useSummaryStore.getState();
    expect(state.videoId).toBeNull();
    expect(state.response).toBeNull();
    expect(state.maxLevel).toBe(0);
    expect(state.level).toBe(2);
    expect(state.generating).toBe(false);
    expect(state.modelMissing).toBe(false);
  });
});

describe('summaryStore helpers (rev2)', () => {
  it('summaryLevelBlocks сортирует блоки по start_ms', () => {
    expect(summaryLevelBlocks(READY_SUMMARY, 1).map((item) => item.node_id)).toEqual(['0', '1']);
  });

  it('summaryLevelInfo/isSummaryLevelReady работают по уровням дерева', () => {
    expect(summaryLevelInfo(READY_SUMMARY, 2)?.label).toBe('Средне');
    expect(isSummaryLevelReady(READY_SUMMARY, 2)).toBe(true);
    expect(isSummaryLevelReady(READY_SUMMARY, 9)).toBe(false);
    expect(summaryLevelBlocks(READY_SUMMARY, 9)).toEqual([]);
  });

  it('summaryLevelLabel: метка из дерева, для 0 — «Дословно», fallback — динамический', () => {
    expect(summaryLevelLabel(READY_SUMMARY, 0, 3)).toBe('Дословно');
    expect(summaryLevelLabel(READY_SUMMARY, 2, 3)).toBe('Средне');
    expect(summaryLevelLabel(absentSummary(), 2, 5)).toBe('Уровень 2 из 5');
  });

  it('summaryLevelLabels строит метки для всех уровней шкалы', () => {
    const labels = summaryLevelLabels(READY_SUMMARY, 3);
    expect(labels[0]).toBe('Дословно');
    expect(labels[1]).toBe('Подробно');
    expect(labels[3]).toBe('Кратко');
    expect(summaryLevelLabels(absentSummary(), 2)[1]).toBe('Уровень 1 из 2');
  });

  it('maxSummaryLevel: max_level из ответа и fallback по levels', () => {
    expect(maxSummaryLevel(READY_SUMMARY)).toBe(3);
    expect(maxSummaryLevel({ ...READY_SUMMARY, max_level: 0 })).toBe(3);
    expect(maxSummaryLevel(absentSummary())).toBe(0);
    expect(maxSummaryLevel(null)).toBe(0);
  });

  it('findActiveSummaryBlock находит последний начавшийся блок', () => {
    const blocks = summaryLevelBlocks(READY_SUMMARY, 1);
    expect(findActiveSummaryBlock(blocks, 0)).toBe(0);
    expect(findActiveSummaryBlock(blocks, 59_999)).toBe(0);
    expect(findActiveSummaryBlock(blocks, 60_000)).toBe(1);
    expect(findActiveSummaryBlock(blocks, 10_000_000)).toBe(1);
    expect(findActiveSummaryBlock([], 10_000)).toBe(-1);
  });
});
