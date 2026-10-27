import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api/client', () => ({
  api: { search: vi.fn(), semanticStatus: vi.fn(), semanticReindex: vi.fn() },
}));

import { api } from '../api/client';
import type { SearchItem, SearchMode, SearchResponse, SemanticStatus } from '../api/types';
import { SEARCH_DEBOUNCE_MS, STORAGE_KEYS } from '../lib/constants';
import { t } from '../lib/i18n';
import { useSearchStore } from './searchStore';
import { useUIStore } from './uiStore';

const search = vi.mocked(api.search);
const semanticStatus = vi.mocked(api.semanticStatus);
const semanticReindex = vi.mocked(api.semanticReindex);

const segmentItem: SearchItem = {
  kind: 'segment',
  video_id: 3,
  video_title: 'lesson-03.mp4',
  segment_id: 41,
  start_ms: 72_000,
  end_ms: 78_000,
  text: 'производные функции',
  snippet_html: 'производные <mark>функции</mark>',
  score: 2.1,
};

const fileItem: SearchItem = {
  kind: 'file',
  video_id: 4,
  video_title: 'lesson-04.mp4',
  path: '/videos/lesson-04.mp4',
  duration_ms: 500_000,
  snippet_html: 'lesson-04.mp4',
  score: 1,
};

const semanticAvailable: SemanticStatus = {
  available: true,
  model: 'multilingual-e5-small',
  dim: 384,
  indexed_segments: 10,
  total_segments: 10,
  indexing: false,
  autoindex: true,
  detail: null,
};

const semanticUnavailable: SemanticStatus = {
  ...semanticAvailable,
  available: false,
  indexed_segments: 0,
  detail: 'модель эмбеддингов не найдена',
};

// jsdom в этом окружении не даёт localStorage — подменяем in-memory Storage.
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
  Object.defineProperty(window, 'localStorage', {
    value: storage,
    configurable: true,
    writable: true,
  });
}

function makeResponse(
  items: SearchItem[],
  options: {
    tookMs?: number;
    semantic?: SemanticStatus;
    mode?: SearchMode;
    modeUsed?: SearchMode;
  } = {},
): SearchResponse {
  return {
    query: {
      raw: 'урок',
      fts: 'урок',
      scope: 'all',
      prefixes: { tags: [], file: null },
      ...(options.mode ? { mode: options.mode } : {}),
      ...(options.modeUsed ? { mode_used: options.modeUsed } : {}),
      ...(options.semantic ? { semantic: options.semantic } : {}),
      ...(options.tookMs !== undefined ? { took_ms: options.tookMs } : {}),
    },
    total: items.length,
    items,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  installMemoryStorage();
  window.localStorage.clear();
  useSearchStore.setState({
    query: '',
    scope: 'all',
    mode: 'hybrid',
    modeUsed: null,
    results: [],
    total: 0,
    loading: false,
    error: null,
    tookMs: null,
    semantic: null,
    semanticLoading: false,
  });
  useUIStore.setState({ selectedVideoId: null, toasts: [] });
  search.mockResolvedValue(makeResponse([]));
  semanticStatus.mockResolvedValue({ ...semanticAvailable });
  semanticReindex.mockResolvedValue({ ...semanticAvailable, indexing: true, state: 'indexing' });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('searchStore', () => {
  it('setQuery выполняет поиск с debounce 300 мс и передаёт режим', async () => {
    vi.useFakeTimers();
    search.mockResolvedValue(makeResponse([segmentItem], { tookMs: 12 }));

    useSearchStore.getState().setQuery('урок');
    expect(search).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS - 1);
    expect(search).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(search).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledWith(
      { q: 'урок', scope: 'all', mode: 'hybrid', limit: 50 },
      expect.any(AbortSignal),
    );
    expect(useSearchStore.getState().results).toHaveLength(1);
    expect(useSearchStore.getState().tookMs).toBe(12);
  });

  it('пустой запрос очищает результаты и не вызывает API', async () => {
    vi.useFakeTimers();
    useSearchStore.setState({ results: [segmentItem], total: 1 });

    useSearchStore.getState().setQuery('   ');
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);

    expect(search).not.toHaveBeenCalled();
    expect(useSearchStore.getState().results).toEqual([]);
    expect(useSearchStore.getState().total).toBe(0);
  });

  it('setScope перезапускает поиск сразу при непустом запросе', async () => {
    useSearchStore.setState({ query: 'урок' });

    useSearchStore.getState().setScope('segments');
    await vi.waitFor(() => expect(search).toHaveBeenCalledTimes(1));

    expect(search).toHaveBeenCalledWith(
      { q: 'урок', scope: 'segments', mode: 'hybrid', limit: 50 },
      expect.any(AbortSignal),
    );
  });

  it('setMode сохраняет режим в localStorage и повторяет активный поиск', async () => {
    useSearchStore.setState({ query: 'урок' });

    useSearchStore.getState().setMode('semantic');
    await vi.waitFor(() => expect(search).toHaveBeenCalledTimes(1));

    expect(useSearchStore.getState().mode).toBe('semantic');
    expect(search).toHaveBeenCalledWith(
      { q: 'урок', scope: 'all', mode: 'semantic', limit: 50 },
      expect.any(AbortSignal),
    );
    expect(window.localStorage.getItem(STORAGE_KEYS.searchMode)).toContain('semantic');
  });

  it('setMode без активного запроса не запускает поиск', () => {
    useSearchStore.getState().setMode('fts');

    expect(search).not.toHaveBeenCalled();
    expect(useSearchStore.getState().mode).toBe('fts');
  });

  it('runSearch сохраняет semantic и mode_used из ответа', async () => {
    search.mockResolvedValue(
      makeResponse([segmentItem], {
        semantic: semanticAvailable,
        mode: 'hybrid',
        modeUsed: 'hybrid',
      }),
    );
    useSearchStore.setState({ query: 'урок', mode: 'hybrid' });

    await useSearchStore.getState().runSearch();

    const state = useSearchStore.getState();
    expect(state.semantic).toEqual(semanticAvailable);
    expect(state.modeUsed).toBe('hybrid');
    expect(state.mode).toBe('hybrid');
  });

  it('нормализует режим в fts, если семантика недоступна', async () => {
    search.mockResolvedValue(
      makeResponse([], {
        semantic: semanticUnavailable,
        mode: 'hybrid',
        modeUsed: 'fts',
      }),
    );
    useSearchStore.setState({ query: 'урок', mode: 'hybrid' });

    await useSearchStore.getState().runSearch();

    const state = useSearchStore.getState();
    expect(state.semantic).toEqual(semanticUnavailable);
    expect(state.mode).toBe('fts');
    expect(state.modeUsed).toBe('fts');
  });

  it('не нормализует режим, если mode_used=fts из-за scope, а семантика доступна', async () => {
    search.mockResolvedValue(
      makeResponse([fileItem], {
        semantic: semanticAvailable,
        mode: 'semantic',
        modeUsed: 'fts',
      }),
    );
    useSearchStore.setState({ query: 'урок', mode: 'semantic', scope: 'files' });

    await useSearchStore.getState().runSearch();

    expect(useSearchStore.getState().mode).toBe('semantic');
    expect(useSearchStore.getState().modeUsed).toBe('fts');
  });

  it('loadSemanticStatus загружает статус и нормализует недоступный режим', async () => {
    semanticStatus.mockResolvedValue(semanticUnavailable);
    useSearchStore.setState({ mode: 'hybrid' });

    await useSearchStore.getState().loadSemanticStatus();

    const state = useSearchStore.getState();
    expect(semanticStatus).toHaveBeenCalledTimes(1);
    expect(state.semantic).toEqual(semanticUnavailable);
    expect(state.mode).toBe('fts');
    expect(state.semanticLoading).toBe(false);
  });

  it('loadSemanticStatus сохраняет режим, если семантика доступна', async () => {
    useSearchStore.setState({ mode: 'hybrid' });

    await useSearchStore.getState().loadSemanticStatus();

    expect(useSearchStore.getState().semantic).toEqual(semanticAvailable);
    expect(useSearchStore.getState().mode).toBe('hybrid');
  });

  it('ошибка loadSemanticStatus не ломает поиск и не затирает результаты', async () => {
    semanticStatus.mockRejectedValue(new Error('offline'));
    useSearchStore.setState({ query: 'урок', results: [fileItem], total: 1 });

    await useSearchStore.getState().loadSemanticStatus();

    const state = useSearchStore.getState();
    expect(state.semanticLoading).toBe(false);
    expect(state.semantic).toBeNull();
    expect(state.results).toEqual([fileItem]);
  });

  it('reindexSemantic запускает переиндексацию, обновляет статус и показывает toast', async () => {
    useSearchStore.setState({ semantic: { ...semanticAvailable, indexing: false } });

    await useSearchStore.getState().reindexSemantic(true);

    expect(semanticReindex).toHaveBeenCalledWith(true);
    expect(useSearchStore.getState().semantic?.indexing).toBe(true);
    const toast = useUIStore.getState().toasts[0];
    expect(toast?.kind).toBe('info');
    expect(toast?.message).toBe(t('search.reindexStarted'));
  });

  it('ошибка reindexSemantic показывает toast и снимает загрузку', async () => {
    semanticReindex.mockRejectedValue(new Error('boom'));

    await useSearchStore.getState().reindexSemantic();

    const toast = useUIStore.getState().toasts[0];
    expect(toast?.kind).toBe('error');
    expect(toast?.message).toContain('boom');
    expect(useSearchStore.getState().semanticLoading).toBe(false);
  });

  it('applySemanticProgress обновляет счётчики и флаг индексации', () => {
    useSearchStore.setState({ semantic: { ...semanticAvailable, indexed_segments: 1 } });

    useSearchStore.getState().applySemanticProgress({ indexed: 7, total: 10, percent: 70 });

    const semantic = useSearchStore.getState().semantic;
    expect(semantic?.indexed_segments).toBe(7);
    expect(semantic?.total_segments).toBe(10);
    expect(semantic?.indexing).toBe(true);
  });

  it('applySemanticProgress без статуса запрашивает его', async () => {
    useSearchStore.getState().applySemanticProgress({ indexed: 1, total: 2, percent: 50 });

    await vi.waitFor(() => expect(semanticStatus).toHaveBeenCalledTimes(1));
  });

  it('applySemanticState( idle ) обновляет статус после завершения индексации', async () => {
    useSearchStore.setState({ semantic: { ...semanticAvailable, indexing: true } });

    useSearchStore.getState().applySemanticState(false);
    await vi.waitFor(() => expect(semanticStatus).toHaveBeenCalledTimes(1));

    expect(useSearchStore.getState().semantic?.indexing).toBe(false);
  });

  it('игнорирует ответ устаревшего запроса (seq-guard)', async () => {
    let resolveFirst: (value: SearchResponse) => void = () => undefined;
    const first = new Promise<SearchResponse>((resolve) => {
      resolveFirst = resolve;
    });
    search.mockReturnValueOnce(first).mockResolvedValueOnce(makeResponse([fileItem]));
    useSearchStore.setState({ query: 'урок' });

    const firstRun = useSearchStore.getState().runSearch();
    const secondRun = useSearchStore.getState().runSearch();
    await secondRun;
    resolveFirst(makeResponse([segmentItem]));
    await firstRun;

    expect(useSearchStore.getState().results).toEqual([fileItem]);
  });

  it('openResult для сегмента открывает видео и публикует vl:open + vl:seek', () => {
    const openHandler = vi.fn();
    const seekHandler = vi.fn();
    window.addEventListener('vl:open', openHandler);
    window.addEventListener('vl:seek', seekHandler);

    useSearchStore.getState().openResult(segmentItem);

    expect(useUIStore.getState().selectedVideoId).toBe(3);
    const openEvent = openHandler.mock.calls[0]?.[0] as CustomEvent<{ videoId: number; ms?: number }>;
    expect(openEvent.detail).toEqual({ videoId: 3, ms: 72_000 });
    const seekEvent = seekHandler.mock.calls[0]?.[0] as CustomEvent<{ videoId: number; ms: number }>;
    expect(seekEvent.detail).toEqual({ videoId: 3, ms: 72_000 });

    window.removeEventListener('vl:open', openHandler);
    window.removeEventListener('vl:seek', seekHandler);
  });

  it('openResult для файла не публикует seek', () => {
    const seekHandler = vi.fn();
    window.addEventListener('vl:seek', seekHandler);

    useSearchStore.getState().openResult(fileItem);

    expect(useUIStore.getState().selectedVideoId).toBe(4);
    expect(seekHandler).not.toHaveBeenCalled();
    window.removeEventListener('vl:seek', seekHandler);
  });

  it('clear сбрасывает результаты, но сохраняет выбранный режим', () => {
    useSearchStore.setState({
      query: 'урок',
      results: [fileItem],
      total: 1,
      mode: 'semantic',
      modeUsed: 'semantic',
    });

    useSearchStore.getState().clear();

    const state = useSearchStore.getState();
    expect(state.query).toBe('');
    expect(state.results).toEqual([]);
    expect(state.total).toBe(0);
    expect(state.error).toBeNull();
    expect(state.mode).toBe('semantic');
    expect(state.modeUsed).toBeNull();
  });

  it('сохраняет текст ошибки при неуспешном запросе', async () => {
    search.mockRejectedValue(new Error('boom'));
    useSearchStore.setState({ query: 'урок' });

    await useSearchStore.getState().runSearch();

    expect(search).toHaveBeenCalledTimes(1);
    expect(useSearchStore.getState().error).toBe('boom');
    expect(useSearchStore.getState().loading).toBe(false);
  });
});
