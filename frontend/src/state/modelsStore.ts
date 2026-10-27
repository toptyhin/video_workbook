import { create } from 'zustand';

import { api } from '../api/client';
import type {
  ModelInfo,
  ModelProgressPayload,
  ModelStatePayload,
  ModelStatus,
} from '../api/types';

/**
 * Минимальный контракт SSE-события, который принимает стор.
 * Структурно совместим с `SSEEvent` из `api/sse.ts`, поэтому Lead может
 * передавать событие напрямую: `useModelsStore.getState().applyEvent(event)`.
 */
export interface ModelsEvent {
  type: string;
  payload?: unknown;
}

/** Статусы, при которых модель считается «в процессе» (прогресс + «Отмена»). */
export const ACTIVE_MODEL_STATUSES: readonly ModelStatus[] = ['queued', 'downloading', 'verifying'];

export interface ModelsStoreState {
  items: ModelInfo[];
  totalInstalledBytes: number;
  totalAvailableBytes: number;
  modelsDir: string;
  /** `models.offline` (plans/13 D-13.7): в офлайн-режиме скачивание запрещено. */
  offline: boolean;
  loading: boolean;
  error: string | null;

  /** GET /api/models — список моделей, размеры, каталог, офлайн-флаг. */
  load: () => Promise<void>;
  /** POST /api/models/{id}/download, затем refresh списка. */
  download: (id: string) => Promise<void>;
  /** POST /api/models/{id}/cancel, затем refresh списка (идемпотентно). */
  cancel: (id: string) => Promise<void>;
  /** DELETE /api/models/{id}, затем refresh списка. */
  remove: (id: string) => Promise<void>;
  /** POST /api/models/{id}/import {path}; `true` — импорт принят. */
  importModel: (id: string, path: string) => Promise<boolean>;
  /** SSE `model.progress` / `model.state` (в остальных случаях — no-op). */
  applyEvent: (event: ModelsEvent) => void;
  /** PATCH settings {models.offline} + локальное состояние. */
  setOffline: (offline: boolean) => Promise<void>;
  /** PATCH settings {models.endpoint} (пусто = huggingface.co). */
  setEndpoint: (endpoint: string) => Promise<void>;
  /** Сброс в исходное состояние (тесты/закрытие приложения). */
  reset: () => void;
}

const initialState = {
  items: [] as ModelInfo[],
  totalInstalledBytes: 0,
  totalAvailableBytes: 0,
  modelsDir: '',
  offline: false,
  loading: false,
  error: null as string | null,
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

function replaceItem(items: ModelInfo[], id: string, patch: Partial<ModelInfo>): ModelInfo[] {
  return items.map((item) => (item.id === id ? { ...item, ...patch } : item));
}

function clampPercent(value: unknown): number {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  return Math.min(100, Math.max(0, Math.round(numeric)));
}

interface EventMeta {
  id: string;
  status: ModelStatus;
}

function eventMeta(payload: unknown): EventMeta | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const { model_id: modelId, status } = payload as { model_id?: unknown; status?: unknown };
  if (typeof modelId !== 'string' || modelId.length === 0) return null;
  if (typeof status !== 'string') return null;
  return { id: modelId, status: status as ModelStatus };
}

/** Статусы, после которых нужно перечитать список (ready/bundled/absent). */
const REFRESH_STATUSES: readonly ModelStatus[] = ['ready', 'bundled', 'absent'];

export const useModelsStore = create<ModelsStoreState>((set, get) => {
  /** Скачивание/повтор завершились ошибкой: бэкенд переводит модель в `error`. */
  const failItem = (id: string, error: unknown): void => {
    const message = errorText(error);
    set((state) => ({
      error: message,
      items: replaceItem(state.items, id, {
        status: 'error',
        error: message,
        error_code: errorCode(error),
        progress: null,
      }),
    }));
  };

  /**
   * Действие отклонено бэкендом (например, `model_in_use`): статус модели не
   * меняется, показываем текст ошибки в строке (`modelsStore` → ModelsSection).
   */
  const setItemError = (id: string, error: unknown): void => {
    const message = errorText(error);
    set((state) => ({
      error: message,
      items: replaceItem(state.items, id, {
        error: message,
        error_code: errorCode(error),
      }),
    }));
  };

  return {
    ...initialState,

    load: async () => {
      if (get().loading) return;
      set({ loading: true, error: null });
      try {
        const response = await api.models();
        set({
          items: response.items,
          totalInstalledBytes: response.total_installed_bytes,
          totalAvailableBytes: response.total_available_bytes,
          modelsDir: response.models_dir,
          offline: Boolean(response.offline),
          loading: false,
          error: null,
        });
      } catch (error) {
        set({ loading: false, error: errorText(error) });
      }
    },

    download: async (id) => {
      set({ error: null });
      try {
        await api.downloadModel(id);
        await get().load();
      } catch (error) {
        failItem(id, error);
      }
    },

    cancel: async (id) => {
      try {
        await api.cancelModel(id);
        await get().load();
      } catch (error) {
        set({ error: errorText(error) });
      }
    },

    remove: async (id) => {
      try {
        await api.deleteModel(id);
        await get().load();
      } catch (error) {
        // `model_in_use`/`model_bundled` — модель остаётся в списке, показываем ошибку строки.
        setItemError(id, error);
      }
    },

    importModel: async (id, path) => {
      set({ error: null });
      try {
        await api.importModel(id, path);
        await get().load();
        return true;
      } catch (error) {
        // Импорт отклонён: модель остаётся `absent`, ошибка — в строке.
        setItemError(id, error);
        return false;
      }
    },

    applyEvent: (event) => {
      if (event.type === 'model.progress') {
        const payload = event.payload as Partial<ModelProgressPayload> | null;
        const meta = eventMeta(payload);
        if (!meta) return;
        const current = get().items.find((item) => item.id === meta.id);
        if (!current) {
          void get().load();
          return;
        }
        const bytesReceived =
          typeof payload?.bytes_received === 'number' ? payload.bytes_received : 0;
        const totalBytes =
          typeof payload?.total_bytes === 'number' && payload.total_bytes > 0
            ? payload.total_bytes
            : current.progress?.total_bytes ?? current.size_bytes;
        set((state) => ({
          items: replaceItem(state.items, meta.id, {
            status: meta.status,
            progress: {
              bytes_received: bytesReceived,
              total_bytes: totalBytes,
              percent: clampPercent(payload?.percent),
            },
            error: null,
            error_code: null,
          }),
        }));
        return;
      }

      if (event.type === 'model.state') {
        const payload = event.payload as Partial<ModelStatePayload> | null;
        const meta = eventMeta(payload);
        if (!meta) return;
        const current = get().items.find((item) => item.id === meta.id);
        if (!current) {
          void get().load();
          return;
        }
        const error = typeof payload?.error === 'string' ? payload.error : null;
        const errorCodeValue =
          typeof payload?.error_code === 'string' ? payload.error_code : null;
        const finished = REFRESH_STATUSES.includes(meta.status);
        set((state) => ({
          items: replaceItem(state.items, meta.id, {
            status: meta.status,
            error,
            error_code: errorCodeValue,
            progress: finished || meta.status === 'error' ? null : current.progress,
          }),
        }));
        // Установка/удаление/обновление завершены — перечитываем точные размеры и флаги.
        if (finished) void get().load();
      }
    },

    setOffline: async (offline) => {
      const previous = get().offline;
      set({ offline, error: null });
      try {
        await api.patchSettings({ 'models.offline': offline });
      } catch (error) {
        set({ offline: previous, error: errorText(error) });
      }
    },

    setEndpoint: async (endpoint) => {
      set({ error: null });
      try {
        await api.patchSettings({ 'models.endpoint': endpoint });
      } catch (error) {
        set({ error: errorText(error) });
      }
    },

    reset: () => set({ ...initialState }),
  };
});
