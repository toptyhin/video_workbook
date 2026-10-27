import { create } from 'zustand';
import { api } from '../api/client';
import type { Folder, SettingsValues, TransferAction } from '../api/types';
import { STORAGE_KEYS } from '../lib/constants';
import { fileBaseName } from '../lib/format';
import { t } from '../lib/i18n';
import { readStorage, writeStorage } from '../lib/storage';
import { useLibraryStore } from './libraryStore';
import { useUIStore } from './uiStore';

export type { TransferAction } from '../api/types';

export type FileViewMode = 'list' | 'grid';

export const MIN_GRID_COLUMNS = 2;
export const MAX_GRID_COLUMNS = 12;
export const DEFAULT_GRID_COLUMNS = 6;
/** Backend хранит историю адресатов максимум из 5 записей (plans/15 §3.2). */
export const MAX_RECENT_DESTINATIONS = 5;

export interface TransferState {
  action: TransferAction;
  ids: number[];
}

interface FileBrowserState {
  viewMode: FileViewMode;
  gridColumns: number;
  recentDestinations: string[];
  folders: Folder[];
  transfer: TransferState | null;
  transferring: boolean;
  /** `initialize()` отработал (или уже запущен) — второй раз настройки не читаем. */
  initialized: boolean;

  initialize: () => Promise<void>;
  setViewMode: (mode: FileViewMode) => void;
  setGridColumns: (count: number) => void;
  openTransfer: (action: TransferAction, ids: number[]) => void;
  closeTransfer: () => void;
  transferTo: (action: TransferAction, ids: number[], destination: string) => Promise<void>;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function clampGridColumns(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_GRID_COLUMNS;
  return Math.min(MAX_GRID_COLUMNS, Math.max(MIN_GRID_COLUMNS, Math.round(value)));
}

function readInitialViewMode(): FileViewMode {
  return readStorage<string>(STORAGE_KEYS.viewMode, 'list') === 'grid' ? 'grid' : 'list';
}

function readInitialGridColumns(): number {
  return clampGridColumns(readStorage<number>(STORAGE_KEYS.gridColumns, DEFAULT_GRID_COLUMNS));
}

/** `files.recent_destinations` — список абсолютных путей (plans/15 §3.2). */
function readRecentDestinations(settings: SettingsValues): string[] {
  const raw = settings['files.recent_destinations'];
  if (!Array.isArray(raw)) return [];
  return Array.from(new Set(raw.filter((value): value is string => typeof value === 'string' && value.length > 0))).slice(
    0,
    MAX_RECENT_DESTINATIONS,
  );
}

/**
 * Подпись адресата для подменю: путь относительно watched root (plans/15 §4.2),
 * полный путь показывается в тултипе пункта.
 */
export function destinationLabel(destination: string, folders: Folder[]): string {
  const normalized = destination.replace(/\/+$/, '') || destination;
  for (const folder of folders) {
    const root = folder.path.replace(/\/+$/, '');
    if (!root) continue;
    if (normalized === root) return fileBaseName(root);
    if (normalized.startsWith(`${root}/`)) {
      const relative = normalized.slice(root.length + 1);
      return relative.length > 0 ? relative : fileBaseName(root);
    }
  }
  return fileBaseName(normalized);
}

const initialViewMode = readInitialViewMode();
const initialGridColumns = readInitialGridColumns();

/**
 * UI-предпочтения панели «Файлы» (режим/колонки — localStorage) и операции
 * перемещения/копирования в папку с историей адресатов (plans/15 §4.1).
 */
export const useFileBrowserStore = create<FileBrowserState>((set, get) => ({
  viewMode: initialViewMode,
  gridColumns: initialGridColumns,
  recentDestinations: [],
  folders: [],
  transfer: null,
  transferring: false,
  initialized: false,

  initialize: async () => {
    if (get().initialized) return;
    // Ставим флаг до запросов: параллельный вызов не должен дублировать загрузку.
    set({ initialized: true });
    try {
      const [settings, folderResponse] = await Promise.all([api.getSettings(), api.folders()]);
      set({
        recentDestinations: readRecentDestinations(settings),
        folders: folderResponse.items,
      });
    } catch (error) {
      useUIStore.getState().pushToast({ kind: 'error', message: t('toast.error', { message: errorText(error) }) });
    }
  },

  setViewMode: (viewMode) => {
    writeStorage(STORAGE_KEYS.viewMode, viewMode);
    set({ viewMode });
  },

  setGridColumns: (count) => {
    const gridColumns = clampGridColumns(count);
    writeStorage(STORAGE_KEYS.gridColumns, gridColumns);
    set({ gridColumns });
  },

  openTransfer: (action, ids) => {
    set({ transfer: { action, ids: Array.from(new Set(ids)) }, transferring: false });
  },

  closeTransfer: () => {
    set({ transfer: null, transferring: false });
  },

  transferTo: async (action, ids, destination) => {
    const uniqueIds = Array.from(new Set(ids)).filter((id) => Number.isFinite(id));
    if (uniqueIds.length === 0 || destination.trim().length === 0) return;
    set({ transferring: true });
    try {
      const response = await api.transferVideos({ action, ids: uniqueIds, destination });
      if (Array.isArray(response.recent_destinations)) {
        set({ recentDestinations: response.recent_destinations.slice(0, MAX_RECENT_DESTINATIONS) });
      }
      const failedItems = response.items.filter((item) => !item.ok);
      const okCount = response.moved + response.copied;
      const failedCount = response.failed ?? failedItems.length;
      const ui = useUIStore.getState();
      if (okCount > 0 && failedCount === 0) {
        if (action === 'move') {
          ui.pushToast({ kind: 'success', message: t('toast.moved', { count: response.moved }) });
        } else {
          ui.pushToast({ kind: 'success', message: t('toast.copied', { count: response.copied }) });
          // Копия того же контента помечается backend'ом как дубликат (plans/15 D5).
          ui.pushToast({ kind: 'info', message: t('toast.copiedDuplicates') });
        }
        set({ transfer: null, transferring: false });
      } else if (okCount > 0) {
        ui.pushToast({
          kind: 'warn',
          message: t('toast.transferPartial', {
            ok: okCount,
            failed: failedCount,
            detail: failedItems[0]?.detail ?? '',
          }),
        });
        set({ transfer: null, transferring: false });
      } else {
        const first = failedItems[0];
        ui.pushToast({
          kind: 'error',
          message: t('toast.error', { message: first?.detail ?? first?.code ?? t('toast.transferFailed') }),
        });
        set({ transferring: false });
      }
      await useLibraryStore.getState().refresh();
    } catch (error) {
      useUIStore.getState().pushToast({ kind: 'error', message: t('toast.error', { message: errorText(error) }) });
      set({ transferring: false });
    }
  },
}));
