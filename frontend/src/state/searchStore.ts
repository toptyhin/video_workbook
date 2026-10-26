import { create } from 'zustand';
import { api } from '../api/client';
import type { SearchItem, SearchScope } from '../api/types';
import { SEARCH_DEBOUNCE_MS } from '../lib/constants';
import { useUIStore } from './uiStore';

export type { SearchScope };

interface SearchState {
  query: string;
  scope: SearchScope;
  results: SearchItem[];
  total: number;
  loading: boolean;
  error: string | null;
  tookMs: number | null;

  setQuery: (query: string) => void;
  setScope: (scope: SearchScope) => void;
  runSearch: () => Promise<void>;
  /** Перезапустить поиск (например, после SSE `annotations.changed`). */
  refresh: () => Promise<void>;
  clear: () => void;
  /** Открыть видео результата и перейти на таймкод. */
  openResult: (item: SearchItem) => void;
}

const RESULTS_LIMIT = 50;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: string }).name === 'AbortError';
}

let debounceTimer: number | undefined;
let controller: AbortController | null = null;
/** Монотонный счётчик: результат устаревшего запроса не применяется. */
let searchSeq = 0;

function cancelDebounce(): void {
  if (debounceTimer !== undefined) {
    window.clearTimeout(debounceTimer);
    debounceTimer = undefined;
  }
}

export const useSearchStore = create<SearchState>((set, get) => ({
  query: '',
  scope: 'all',
  results: [],
  total: 0,
  loading: false,
  error: null,
  tookMs: null,

  setQuery: (query) => {
    set({ query });
    cancelDebounce();
    controller?.abort();
    controller = null;
    searchSeq += 1;
    if (query.trim().length === 0) {
      set({ results: [], total: 0, loading: false, error: null, tookMs: null });
      return;
    }
    debounceTimer = window.setTimeout(() => {
      debounceTimer = undefined;
      void get().runSearch();
    }, SEARCH_DEBOUNCE_MS);
  },

  setScope: (scope) => {
    set({ scope });
    if (get().query.trim().length > 0) void get().runSearch();
  },

  runSearch: async () => {
    const { query, scope } = get();
    if (query.trim().length === 0) return;
    cancelDebounce();
    controller?.abort();
    const currentController = new AbortController();
    controller = currentController;
    const currentSeq = ++searchSeq;
    set({ loading: true, error: null });
    try {
      const response = await api.search({ q: query, scope, limit: RESULTS_LIMIT }, currentController.signal);
      if (currentSeq !== searchSeq) return;
      set({
        results: response.items,
        total: response.total,
        loading: false,
        tookMs: response.query.took_ms ?? null,
      });
    } catch (error) {
      if (currentSeq !== searchSeq || isAbortError(error)) return;
      set({ loading: false, error: errorText(error), results: [], total: 0 });
    }
  },

  refresh: async () => {
    if (get().query.trim().length === 0) return;
    await get().runSearch();
  },

  clear: () => {
    cancelDebounce();
    controller?.abort();
    controller = null;
    searchSeq += 1;
    set({ query: '', results: [], total: 0, loading: false, error: null, tookMs: null });
  },

  openResult: (item) => {
    const videoId = item.video_id;
    useUIStore.getState().selectVideo(videoId);
    const startMs = item.kind === 'file' ? undefined : item.start_ms;
    // Контракт интеграции: 'vl:open' открывает видео, 'vl:seek' переводит playhead.
    window.dispatchEvent(
      new CustomEvent('vl:open', { detail: startMs === undefined ? { videoId } : { videoId, ms: startMs } }),
    );
    if (startMs !== undefined) {
      window.dispatchEvent(new CustomEvent('vl:seek', { detail: { videoId, ms: startMs } }));
    }
  },
}));
