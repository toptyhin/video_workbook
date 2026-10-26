import { create } from 'zustand';
import { api } from '../api/client';
import type { Video, VideoQuery } from '../api/types';
import { STORAGE_KEYS } from '../lib/constants';
import { t } from '../lib/i18n';
import { readStorage, writeStorage } from '../lib/storage';
import { useUIStore } from './uiStore';

/** Поля сортировки, поддерживаемые `GET /api/videos` (backend `SORT_COLUMNS`). */
export type LibrarySortField =
  | 'title'
  | 'duration_ms'
  | 'size_bytes'
  | 'status'
  | 'added_at'
  | 'mtime_ms'
  | 'progress';

export type LibraryTagMode = 'any' | 'all';
export type SortDirection = 'asc' | 'desc';

export interface SelectOptions {
  /** Ctrl/Cmd+клик — добавить/убрать из набора. */
  additive?: boolean;
  /** Shift+клик — диапазон от последнего клика. */
  range?: boolean;
}

interface LibraryState {
  videos: Video[];
  total: number;
  loading: boolean;
  error: string | null;
  /** Активная папка фильтра (абсолютный путь) или `null` — вся библиотека. */
  folderPath: string | null;
  selectedIds: number[];
  activeTagIds: number[];
  tagMode: LibraryTagMode;
  sort: LibrarySortField;
  dir: SortDirection;
  lastClickedId: number | null;

  loadVideos: () => Promise<void>;
  refresh: () => Promise<void>;
  setFolder: (path: string | null) => void;
  selectVideo: (id: number | null, startMs?: number) => void;
  setSelection: (ids: number[]) => void;
  toggleSelect: (id: number, options?: SelectOptions) => void;
  scanPaths: (paths: string[]) => Promise<void>;
  enqueueSelected: () => Promise<void>;
  removeSelected: () => Promise<void>;
  reprocessSelected: () => Promise<void>;
  setSort: (field: LibrarySortField) => void;
  setActiveTags: (ids: number[], mode?: LibraryTagMode) => void;
}

/** `GET /api/videos` отдаёт максимум 500 записей — берём максимум одним запросом. */
const PAGE_LIMIT = 500;
const SORT_FIELDS: LibrarySortField[] = [
  'title',
  'duration_ms',
  'size_bytes',
  'status',
  'added_at',
  'mtime_ms',
  'progress',
];

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readInitialSort(): { sort: LibrarySortField; dir: SortDirection } {
  const raw = readStorage<string>(STORAGE_KEYS.sort, 'added_at:desc');
  const [field, direction] = raw.split(':');
  if (SORT_FIELDS.includes(field as LibrarySortField) && (direction === 'asc' || direction === 'desc')) {
    return { sort: field as LibrarySortField, dir: direction };
  }
  return { sort: 'added_at', dir: 'desc' };
}

const initialSort = readInitialSort();

/** Монотонный счётчик запросов: ответы устаревших запросов игнорируются. */
let loadSeq = 0;

function dispatchOpen(videoId: number, ms?: number): void {
  // Контракт интеграции с плеером (Lead связывает в App.tsx / playerStore):
  // {videoId} — открыть файл, {videoId, ms} — открыть и перейти на таймкод.
  window.dispatchEvent(
    new CustomEvent('vl:open', { detail: ms === undefined ? { videoId } : { videoId, ms } }),
  );
}

function toastError(error: unknown): void {
  useUIStore.getState().pushToast({ kind: 'error', message: t('toast.error', { message: errorText(error) }) });
}

export const useLibraryStore = create<LibraryState>((set, get) => ({
  videos: [],
  total: 0,
  loading: false,
  error: null,
  folderPath: null,
  selectedIds: [],
  activeTagIds: [],
  tagMode: 'any',
  sort: initialSort.sort,
  dir: initialSort.dir,
  lastClickedId: null,

  loadVideos: async () => {
    const seq = ++loadSeq;
    set({ loading: true, error: null });
    const { folderPath, activeTagIds, tagMode, sort, dir } = get();
    const query: VideoQuery = { sort, dir, limit: PAGE_LIMIT, offset: 0 };
    if (folderPath) query.folder = folderPath;
    if (activeTagIds.length > 0) {
      query.tag_ids = activeTagIds;
      query.tag_mode = tagMode;
      query.include_children = true;
    }
    try {
      const response = await api.listVideos(query);
      if (seq !== loadSeq) return;
      set({ videos: response.items, total: response.total, loading: false });
    } catch (error) {
      if (seq !== loadSeq) return;
      set({ loading: false, error: errorText(error) });
    }
  },

  refresh: async () => {
    await get().loadVideos();
  },

  setFolder: (path) => {
    // Смена папки сбрасывает фильтр по тегам (plans/06 T-06.5 п.5).
    set({ folderPath: path, activeTagIds: [], selectedIds: [], lastClickedId: null });
    void get().loadVideos();
  },

  selectVideo: (id, startMs) => {
    useUIStore.getState().selectVideo(id);
    if (id !== null) dispatchOpen(id, startMs);
  },

  setSelection: (ids) => {
    const unique = Array.from(new Set(ids));
    set({ selectedIds: unique, lastClickedId: unique.length > 0 ? unique[unique.length - 1] : null });
  },

  toggleSelect: (id, options = {}) => {
    const { videos, selectedIds, lastClickedId } = get();
    if (options.range && lastClickedId !== null) {
      const from = videos.findIndex((video) => video.id === lastClickedId);
      const to = videos.findIndex((video) => video.id === id);
      if (from >= 0 && to >= 0) {
        const [start, end] = from < to ? [from, to] : [to, from];
        const range = videos.slice(start, end + 1).map((video) => video.id);
        set({ selectedIds: options.additive ? Array.from(new Set([...selectedIds, ...range])) : range });
        return;
      }
    }
    if (options.additive) {
      const next = selectedIds.includes(id)
        ? selectedIds.filter((selected) => selected !== id)
        : [...selectedIds, id];
      set({ selectedIds: next, lastClickedId: id });
      return;
    }
    set({ selectedIds: [id], lastClickedId: id });
  },

  scanPaths: async (paths) => {
    const unique = Array.from(new Set(paths.filter((path) => path.trim().length > 0)));
    if (unique.length === 0) return;
    for (const path of unique) {
      try {
        await api.scan(path);
      } catch (error) {
        toastError(error);
      }
    }
    await get().refresh();
  },

  enqueueSelected: async () => {
    const ids = get().selectedIds;
    if (ids.length === 0) return;
    try {
      const response = await api.enqueue(ids);
      const queued = response.queued.length;
      if (queued > 0) {
        useUIStore.getState().pushToast({ kind: 'success', message: t('toast.enqueued', { count: queued }) });
      }
      await get().refresh();
    } catch (error) {
      toastError(error);
    }
  },

  removeSelected: async () => {
    const ids = [...get().selectedIds];
    if (ids.length === 0) return;
    let removed = 0;
    for (const id of ids) {
      try {
        await api.deleteVideo(id);
        removed += 1;
      } catch (error) {
        toastError(error);
      }
    }
    if (removed > 0) {
      const selectedVideoId = useUIStore.getState().selectedVideoId;
      if (selectedVideoId !== null && ids.includes(selectedVideoId)) {
        useUIStore.getState().selectVideo(null);
      }
      set({ selectedIds: [], lastClickedId: null });
      useUIStore.getState().pushToast({ kind: 'success', message: t('toast.videoRemoved') });
    }
    await get().refresh();
  },

  reprocessSelected: async () => {
    const ids = [...get().selectedIds];
    if (ids.length === 0) return;
    let queued = 0;
    for (const id of ids) {
      try {
        await api.reprocess(id);
        queued += 1;
      } catch (error) {
        toastError(error);
      }
    }
    if (queued > 0) {
      useUIStore.getState().pushToast({ kind: 'success', message: t('toast.enqueued', { count: queued }) });
    }
    await get().refresh();
  },

  setSort: (field) => {
    const { sort, dir } = get();
    const nextDir: SortDirection = sort === field ? (dir === 'asc' ? 'desc' : 'asc') : 'asc';
    set({ sort: field, dir: nextDir });
    writeStorage(STORAGE_KEYS.sort, `${field}:${nextDir}`);
    void get().loadVideos();
  },

  setActiveTags: (ids, mode) => {
    set({ activeTagIds: Array.from(new Set(ids)), tagMode: mode ?? get().tagMode });
    void get().loadVideos();
  },
}));
