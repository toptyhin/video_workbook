import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api/client', () => ({
  api: { search: vi.fn() },
}));

import { api } from '../api/client';
import type { SearchItem, SearchResponse } from '../api/types';
import { SEARCH_DEBOUNCE_MS } from '../lib/constants';
import { useSearchStore } from './searchStore';
import { useUIStore } from './uiStore';

const search = vi.mocked(api.search);

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

function makeResponse(items: SearchItem[], tookMs = 7): SearchResponse {
  return {
    query: {
      raw: 'урок',
      fts: 'урок',
      scope: 'all',
      prefixes: { tags: [], file: null },
      took_ms: tookMs,
    },
    total: items.length,
    items,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useSearchStore.setState({
    query: '',
    scope: 'all',
    results: [],
    total: 0,
    loading: false,
    error: null,
    tookMs: null,
  });
  useUIStore.setState({ selectedVideoId: null, toasts: [] });
  search.mockResolvedValue(makeResponse([]));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('searchStore', () => {
  it('setQuery выполняет поиск с debounce 300 мс', async () => {
    vi.useFakeTimers();
    search.mockResolvedValue(makeResponse([segmentItem], 12));

    useSearchStore.getState().setQuery('урок');
    expect(search).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS - 1);
    expect(search).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(search).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledWith(
      { q: 'урок', scope: 'all', limit: 50 },
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
      { q: 'урок', scope: 'segments', limit: 50 },
      expect.any(AbortSignal),
    );
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

  it('clear сбрасывает состояние поиска', () => {
    useSearchStore.setState({ query: 'урок', results: [fileItem], total: 1, loading: false });

    useSearchStore.getState().clear();

    const state = useSearchStore.getState();
    expect(state.query).toBe('');
    expect(state.results).toEqual([]);
    expect(state.total).toBe(0);
    expect(state.error).toBeNull();
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
