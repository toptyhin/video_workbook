import { create } from 'zustand';
import { api } from '../api/client';
import type { TagNode } from '../api/types';
import { STORAGE_KEYS } from '../lib/constants';
import { t } from '../lib/i18n';
import { readStorage, writeStorage } from '../lib/storage';
import { useLibraryStore } from './libraryStore';
import { useUIStore } from './uiStore';

export type TagFilterMode = 'union' | 'intersection';

export interface TagActivateOptions {
  /** Ctrl/Cmd+клик — добавить/убрать из набора. */
  additive?: boolean;
  /** Shift+клик — диапазон по видимому плоскому списку. */
  range?: boolean;
}

interface TagsState {
  tree: TagNode[];
  loading: boolean;
  error: string | null;
  loaded: boolean;
  expandedIds: number[];
  activeTagIds: number[];
  lastActiveId: number | null;
  mode: TagFilterMode;

  load: (force?: boolean) => Promise<void>;
  /** Перечитать дерево (например, после SSE `tags.changed`). */
  refresh: () => Promise<void>;
  create: (parentId: number | null, name: string, color?: string | null) => Promise<boolean>;
  rename: (id: number, name: string, color?: string | null) => Promise<boolean>;
  remove: (id: number) => Promise<boolean>;
  assignToVideo: (videoId: number, tagId: number) => Promise<void>;
  removeFromVideo: (videoId: number, tagId: number) => Promise<void>;
  toggleExpand: (id: number) => void;
  toggleActive: (id: number, options?: TagActivateOptions) => void;
  clearActive: () => void;
  setMode: (mode: TagFilterMode) => Promise<void>;
  /** Применить режим из уже загруженных настроек без PATCH. */
  syncMode: (mode: TagFilterMode) => void;
  exportTags: () => Promise<unknown | null>;
  importTags: (data: unknown) => Promise<void>;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toastError(error: unknown): void {
  useUIStore.getState().pushToast({ kind: 'error', message: t('toast.error', { message: errorText(error) }) });
}

/** Плоский список узлов дерева в порядке обхода (для Shift-диапазона и клавиатуры). */
export function flattenTagTree(nodes: TagNode[]): TagNode[] {
  const result: TagNode[] = [];
  const walk = (items: TagNode[]): void => {
    for (const node of items) {
      result.push(node);
      walk(node.children);
    }
  };
  walk(nodes);
  return result;
}

/** Полные пути тегов: {id → "Учёба/Математика"}. */
export function tagPathMap(nodes: TagNode[]): Map<number, string> {
  const result = new Map<number, string>();
  const walk = (items: TagNode[], prefix: string[]): void => {
    for (const node of items) {
      const path = [...prefix, node.name];
      result.set(node.id, path.join('/'));
      walk(node.children, path);
    }
  };
  walk(nodes, []);
  return result;
}

function initialExpanded(): number[] {
  const stored = readStorage<number[]>(STORAGE_KEYS.tagsExpanded, []);
  return Array.isArray(stored) ? stored.filter((value): value is number => typeof value === 'number') : [];
}

function toLibraryMode(mode: TagFilterMode): 'any' | 'all' {
  return mode === 'union' ? 'any' : 'all';
}

export const useTagsStore = create<TagsState>((set, get) => ({
  tree: [],
  loading: false,
  error: null,
  loaded: false,
  expandedIds: initialExpanded(),
  activeTagIds: [],
  lastActiveId: null,
  mode: 'union',

  load: async (force = false) => {
    if (!force && get().loaded && !get().error) return;
    set({ loading: true, error: null });
    try {
      const [response, settings] = await Promise.all([
        api.tags(),
        api.getSettings().catch(() => null),
      ]);
      set({ tree: response.items, loading: false, loaded: true });
      const modeValue = settings?.['tags.multi_select_mode'];
      if (modeValue === 'union' || modeValue === 'intersection') {
        set({ mode: modeValue });
        if (get().activeTagIds.length > 0) {
          useLibraryStore.getState().setActiveTags(get().activeTagIds, toLibraryMode(modeValue));
        }
      }
    } catch (error) {
      set({ loading: false, error: errorText(error) });
    }
  },

  refresh: async () => {
    await get().load(true);
  },

  create: async (parentId, name, color) => {
    try {
      await api.createTag({ parent_id: parentId, name, color: color ?? null });
      await get().load(true);
      return true;
    } catch (error) {
      toastError(error);
      return false;
    }
  },

  rename: async (id, name, color) => {
    try {
      const payload: { name?: string; color?: string | null } = { name };
      if (color !== undefined) payload.color = color;
      await api.patchTag(id, payload);
      await get().load(true);
      return true;
    } catch (error) {
      toastError(error);
      return false;
    }
  },

  remove: async (id) => {
    try {
      await api.deleteTag(id);
      const activeTagIds = get().activeTagIds.filter((tagId) => tagId !== id);
      set({ activeTagIds, lastActiveId: null });
      useLibraryStore.getState().setActiveTags(activeTagIds, toLibraryMode(get().mode));
      await get().load(true);
      return true;
    } catch (error) {
      toastError(error);
      return false;
    }
  },

  assignToVideo: async (videoId, tagId) => {
    try {
      await api.addVideoTag(videoId, tagId);
      await Promise.all([get().load(true), useLibraryStore.getState().refresh()]);
    } catch (error) {
      toastError(error);
    }
  },

  removeFromVideo: async (videoId, tagId) => {
    try {
      await api.removeVideoTag(videoId, tagId);
      await Promise.all([get().load(true), useLibraryStore.getState().refresh()]);
    } catch (error) {
      toastError(error);
    }
  },

  toggleExpand: (id) => {
    const { expandedIds } = get();
    const next = expandedIds.includes(id)
      ? expandedIds.filter((value) => value !== id)
      : [...expandedIds, id];
    set({ expandedIds: next });
    writeStorage(STORAGE_KEYS.tagsExpanded, next);
  },

  toggleActive: (id, options = {}) => {
    const { activeTagIds, tree, lastActiveId, mode } = get();
    let next: number[];
    if (options.range && lastActiveId !== null) {
      const flat = flattenTagTree(tree).map((node) => node.id);
      const from = flat.indexOf(lastActiveId);
      const to = flat.indexOf(id);
      if (from >= 0 && to >= 0) {
        const [start, end] = from < to ? [from, to] : [to, from];
        const range = flat.slice(start, end + 1);
        next = Array.from(new Set([...activeTagIds, ...range]));
      } else {
        next = [id];
      }
    } else if (options.additive) {
      next = activeTagIds.includes(id)
        ? activeTagIds.filter((tagId) => tagId !== id)
        : [...activeTagIds, id];
    } else {
      // Обычный клик — одиночный фильтр; повторный клик по единственному активному снимает фильтр.
      next = activeTagIds.length === 1 && activeTagIds[0] === id ? [] : [id];
    }
    set({ activeTagIds: next, lastActiveId: id });
    useLibraryStore.getState().setActiveTags(next, toLibraryMode(mode));
  },

  clearActive: () => {
    set({ activeTagIds: [], lastActiveId: null });
    useLibraryStore.getState().setActiveTags([], toLibraryMode(get().mode));
  },

  setMode: async (mode) => {
    const previous = get().mode;
    get().syncMode(mode);
    try {
      await api.patchSettings({ 'tags.multi_select_mode': mode });
    } catch (error) {
      toastError(error);
      get().syncMode(previous);
    }
  },

  syncMode: (mode) => {
    set({ mode });
    useLibraryStore.getState().setActiveTags(get().activeTagIds, toLibraryMode(mode));
  },

  exportTags: async () => {
    try {
      return await api.exportTags();
    } catch (error) {
      toastError(error);
      return null;
    }
  },

  importTags: async (data) => {
    try {
      const result = await api.importTags(data);
      await get().load(true);
      useUIStore.getState().pushToast({
        kind: 'success',
        message: t('annotations.imported', { imported: result.imported, skipped: result.skipped }),
      });
    } catch (error) {
      toastError(error);
    }
  },
}));
