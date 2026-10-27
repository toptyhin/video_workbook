import { create } from 'zustand';
import { api } from '../api/client';
import type {
  EmbeddingProgressPayload,
  SearchItem,
  SearchMode,
  SearchScope,
  SemanticStatus,
} from '../api/types';
import { SEARCH_DEBOUNCE_MS, STORAGE_KEYS } from '../lib/constants';
import { t } from '../lib/i18n';
import { readStorage, writeStorage } from '../lib/storage';
import { useUIStore } from './uiStore';

export type { SearchMode, SearchScope };

/** Порядок режимов в переключателе «Обычный / Семантика / Гибрид». */
export const SEARCH_MODES: readonly SearchMode[] = ['fts', 'semantic', 'hybrid'];

const RESULTS_LIMIT = 50;
/** UI default — hybrid (API default остаётся fts, plans/12 §1). */
const DEFAULT_MODE: SearchMode = 'hybrid';

function readMode(): SearchMode {
  const stored = readStorage<SearchMode>(STORAGE_KEYS.searchMode, DEFAULT_MODE);
  return SEARCH_MODES.includes(stored) ? stored : DEFAULT_MODE;
}

interface SearchState {
  query: string;
  scope: SearchScope;
  /** Выбранный пользователем режим; переживает перезагрузку (localStorage). */
  mode: SearchMode;
  /** Фактический режим последнего ответа (`query.mode_used`). */
  modeUsed: SearchMode | null;
  results: SearchItem[];
  total: number;
  loading: boolean;
  error: string | null;
  tookMs: number | null;
  /** Статус семантического индекса (GET /api/search/semantic/status). */
  semantic: SemanticStatus | null;
  semanticLoading: boolean;

  setQuery: (query: string) => void;
  setScope: (scope: SearchScope) => void;
  setMode: (mode: SearchMode) => void;
  runSearch: () => Promise<void>;
  /** Перезапустить поиск (например, после SSE `annotations.changed`). */
  refresh: () => Promise<void>;
  clear: () => void;
  /** Открыть видео результата и перейти на таймкод. */
  openResult: (item: SearchItem) => void;
  loadSemanticStatus: () => Promise<void>;
  reindexSemantic: (force?: boolean) => Promise<void>;
  /** SSE `embedding.progress`: обновить счётчики без сетевого запроса. */
  applySemanticProgress: (payload: EmbeddingProgressPayload) => void;
  /** SSE `embedding.state`: флаг индексации; при `idle` — обновить статус. */
  applySemanticState: (indexing: boolean) => void;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: string }).name === 'AbortError';
}

/** Активен ли поиск: панель результатов показывается вместо списка файлов. */
export function selectSearchActive(state: Pick<SearchState, 'query' | 'results'>): boolean {
  return state.query.trim().length > 0 || state.results.length > 0;
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
  mode: readMode(),
  modeUsed: null,
  results: [],
  total: 0,
  loading: false,
  error: null,
  tookMs: null,
  semantic: null,
  semanticLoading: false,

  setQuery: (query) => {
    set({ query });
    cancelDebounce();
    controller?.abort();
    controller = null;
    searchSeq += 1;
    if (query.trim().length === 0) {
      set({ results: [], total: 0, loading: false, error: null, tookMs: null, modeUsed: null });
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

  setMode: (mode) => {
    const changed = get().mode !== mode;
    writeStorage(STORAGE_KEYS.searchMode, mode);
    set({ mode });
    if (changed && get().query.trim().length > 0) void get().runSearch();
  },

  runSearch: async () => {
    const { query, scope, mode } = get();
    if (query.trim().length === 0) return;
    cancelDebounce();
    controller?.abort();
    const currentController = new AbortController();
    controller = currentController;
    const currentSeq = ++searchSeq;
    set({ loading: true, error: null });
    try {
      const response = await api.search(
        { q: query, scope, mode, limit: RESULTS_LIMIT },
        currentController.signal,
      );
      if (currentSeq !== searchSeq) return;
      const echo = response.query;
      const echoSemantic = echo.semantic ?? null;
      // Если бэкенд не прислал эхо семантики (старая версия) — не затираем
      // статус, загруженный через /api/search/semantic/status.
      const semantic = echoSemantic ?? get().semantic;
      const modeUsed = echo.mode_used ?? mode;
      // Семантика недоступна (нет модели/onnxruntime) → нормализуем в fts,
      // чтобы выбранный режим соответствовал фактическому (plans/12 §4.1).
      const normalizedMode =
        echoSemantic && !echoSemantic.available && get().mode !== 'fts' ? 'fts' : get().mode;
      set({
        results: response.items,
        total: response.total,
        loading: false,
        tookMs: echo.took_ms ?? null,
        semantic,
        modeUsed,
        mode: normalizedMode,
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
    set({
      query: '',
      results: [],
      total: 0,
      loading: false,
      error: null,
      tookMs: null,
      modeUsed: null,
    });
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

  loadSemanticStatus: async () => {
    if (get().semanticLoading) return;
    set({ semanticLoading: true });
    try {
      const semantic = await api.semanticStatus();
      const normalizedMode = !semantic.available && get().mode !== 'fts' ? 'fts' : get().mode;
      set({ semantic, semanticLoading: false, mode: normalizedMode });
    } catch {
      // Семантика — опциональная подсистема: её недоступность не ломает поиск.
      set({ semanticLoading: false });
    }
  },

  reindexSemantic: async (force = false) => {
    if (get().semanticLoading) return;
    set({ semanticLoading: true });
    try {
      const status = await api.semanticReindex(force);
      set({ semantic: status, semanticLoading: false });
      useUIStore.getState().pushToast({ kind: 'info', message: t('search.reindexStarted') });
    } catch (error) {
      set({ semanticLoading: false });
      useUIStore.getState().pushToast({
        kind: 'error',
        message: t('search.reindexFailed', { message: errorText(error) }),
      });
    }
  },

  applySemanticProgress: (payload) => {
    const current = get().semantic;
    if (!current) {
      void get().loadSemanticStatus();
      return;
    }
    set({
      semantic: {
        ...current,
        indexing: true,
        indexed_segments:
          typeof payload.indexed === 'number' ? payload.indexed : current.indexed_segments,
        total_segments:
          typeof payload.total === 'number' ? payload.total : current.total_segments,
      },
    });
  },

  applySemanticState: (indexing) => {
    const current = get().semantic;
    if (current) set({ semantic: { ...current, indexing } });
    // Индексация завершилась (или только началась) — подтягиваем точные счётчики.
    void get().loadSemanticStatus();
  },
}));
