import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api/client', () => ({
  api: {
    getSettings: vi.fn(),
    folders: vi.fn(),
    transferVideos: vi.fn(),
    listVideos: vi.fn(),
  },
}));

import { api } from '../api/client';
import type { Folder, TransferResponse } from '../api/types';
import { t } from '../lib/i18n';
import { destinationLabel, useFileBrowserStore } from './fileBrowserStore';
import { useLibraryStore } from './libraryStore';
import { useUIStore } from './uiStore';

const getSettings = vi.mocked(api.getSettings);
const folders = vi.mocked(api.folders);
const transferVideos = vi.mocked(api.transferVideos);
const listVideos = vi.mocked(api.listVideos);

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

function makeFolder(path: string, id = 1): Folder {
  return { id, path, added_at: '2024-01-01T00:00:00Z', total: 0, done: 0 };
}

function transferResponse(overrides: Partial<TransferResponse> = {}): TransferResponse {
  return {
    action: 'move',
    destination: '/videos/b',
    items: [
      {
        id: 1,
        ok: true,
        code: null,
        detail: null,
        path: '/videos/b/lesson-1.mp4',
        new_id: null,
      },
    ],
    moved: 1,
    copied: 0,
    failed: 0,
    recent_destinations: ['/videos/b'],
    ...overrides,
  };
}

function resetStore(): void {
  useFileBrowserStore.setState({
    viewMode: 'list',
    gridColumns: 6,
    recentDestinations: [],
    folders: [],
    transfer: null,
    transferring: false,
    initialized: false,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  installMemoryStorage();
  window.localStorage.clear();
  resetStore();
  useLibraryStore.setState({
    videos: [],
    total: 0,
    loading: false,
    error: null,
    folderPath: null,
    selectedIds: [],
    activeTagIds: [],
    tagMode: 'any',
    sort: 'added_at',
    dir: 'desc',
    lastClickedId: null,
  });
  useUIStore.setState({ selectedVideoId: null, toasts: [] });
  listVideos.mockResolvedValue({ items: [], total: 0 });
});

describe('fileBrowserStore', () => {
  it('по умолчанию — строчный вид и 6 блоков в ряд', () => {
    const state = useFileBrowserStore.getState();
    expect(state.viewMode).toBe('list');
    expect(state.gridColumns).toBe(6);
    expect(state.recentDestinations).toEqual([]);
    expect(state.transfer).toBeNull();
  });

  it('setViewMode сохраняет режим в localStorage', () => {
    useFileBrowserStore.getState().setViewMode('grid');

    expect(useFileBrowserStore.getState().viewMode).toBe('grid');
    const stored = JSON.parse(window.localStorage.getItem('vl.ui.viewMode') ?? '{}') as {
      value?: string;
    };
    expect(stored.value).toBe('grid');
  });

  it('setGridColumns ограничивает значение 2…12 и персистит его', () => {
    useFileBrowserStore.getState().setGridColumns(4);
    expect(useFileBrowserStore.getState().gridColumns).toBe(4);
    expect(
      (JSON.parse(window.localStorage.getItem('vl.ui.gridColumns') ?? '{}') as { value?: number })
        .value,
    ).toBe(4);

    useFileBrowserStore.getState().setGridColumns(1);
    expect(useFileBrowserStore.getState().gridColumns).toBe(2);

    useFileBrowserStore.getState().setGridColumns(64);
    expect(useFileBrowserStore.getState().gridColumns).toBe(12);

    useFileBrowserStore.getState().setGridColumns(Number.NaN);
    expect(useFileBrowserStore.getState().gridColumns).toBe(6);
  });

  it('initialize читает историю адресатов и watched roots ровно один раз', async () => {
    getSettings.mockResolvedValue({
      'files.recent_destinations': ['/videos/b', '/videos/a', '/videos/b'],
      whisper_model: 'small',
    });
    folders.mockResolvedValue({ items: [makeFolder('/videos')], total: 1 });

    await useFileBrowserStore.getState().initialize();

    const state = useFileBrowserStore.getState();
    expect(state.recentDestinations).toEqual(['/videos/b', '/videos/a']);
    expect(state.folders.map((folder) => folder.path)).toEqual(['/videos']);
    expect(state.initialized).toBe(true);

    await useFileBrowserStore.getState().initialize();
    expect(getSettings).toHaveBeenCalledTimes(1);
    expect(folders).toHaveBeenCalledTimes(1);
  });

  it('initialize не падает без настройки истории и с мусором в ней', async () => {
    getSettings.mockResolvedValueOnce({});
    folders.mockResolvedValueOnce({ items: [], total: 0 });
    await useFileBrowserStore.getState().initialize();
    expect(useFileBrowserStore.getState().recentDestinations).toEqual([]);

    resetStore();
    getSettings.mockResolvedValueOnce({ 'files.recent_destinations': 'не список' });
    folders.mockResolvedValueOnce({ items: [], total: 0 });
    await useFileBrowserStore.getState().initialize();
    expect(useFileBrowserStore.getState().recentDestinations).toEqual([]);
  });

  it('transferTo(move) обновляет историю, библиотеку и показывает успех', async () => {
    transferVideos.mockResolvedValue(transferResponse());
    useFileBrowserStore.setState({ transfer: { action: 'move', ids: [1] } });

    await useFileBrowserStore.getState().transferTo('move', [1], '/videos/b');

    expect(transferVideos).toHaveBeenCalledWith({ action: 'move', ids: [1], destination: '/videos/b' });
    expect(useFileBrowserStore.getState().recentDestinations).toEqual(['/videos/b']);
    expect(useFileBrowserStore.getState().transfer).toBeNull();
    expect(useFileBrowserStore.getState().transferring).toBe(false);
    expect(listVideos).toHaveBeenCalledTimes(1);

    const toasts = useUIStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.kind).toBe('success');
    expect(toasts[0]?.message).toBe(t('toast.moved', { count: 1 }));
  });

  it('transferTo(copy) сообщает о копиях и дубликатах', async () => {
    transferVideos.mockResolvedValue(
      transferResponse({
        action: 'copy',
        moved: 0,
        copied: 2,
        items: [
          { id: 1, ok: true, code: null, detail: null, path: '/videos/b/a.mp4', new_id: 5 },
          { id: 2, ok: true, code: null, detail: null, path: '/videos/b/b.mp4', new_id: 6 },
        ],
      }),
    );

    await useFileBrowserStore.getState().transferTo('copy', [1, 2], '/videos/b');

    const messages = useUIStore.getState().toasts.map((toast) => toast.message);
    expect(messages).toContain(t('toast.copied', { count: 2 }));
    expect(messages).toContain(t('toast.copiedDuplicates'));
  });

  it('transferTo при частичном успехе показывает warning и закрывает диалог', async () => {
    transferVideos.mockResolvedValue(
      transferResponse({
        items: [
          { id: 1, ok: true, code: null, detail: null, path: '/videos/b/a.mp4', new_id: null },
          {
            id: 2,
            ok: false,
            code: 'target_exists',
            detail: 'В папке назначения уже есть файл b.mp4',
            path: null,
            new_id: null,
          },
        ],
        moved: 1,
        failed: 1,
      }),
    );
    useFileBrowserStore.setState({ transfer: { action: 'move', ids: [1, 2] } });

    await useFileBrowserStore.getState().transferTo('move', [1, 2], '/videos/b');

    const toasts = useUIStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.kind).toBe('warn');
    expect(toasts[0]?.message).toBe(
      t('toast.transferPartial', {
        ok: 1,
        failed: 1,
        detail: 'В папке назначения уже есть файл b.mp4',
      }),
    );
    expect(useFileBrowserStore.getState().transfer).toBeNull();
  });

  it('transferTo при полной ошибке оставляет диалог открытым', async () => {
    transferVideos.mockResolvedValue(
      transferResponse({
        items: [
          {
            id: 1,
            ok: false,
            code: 'missing_file',
            detail: 'Файл не найден на диске',
            path: null,
            new_id: null,
          },
        ],
        moved: 0,
        failed: 1,
        recent_destinations: [],
      }),
    );
    useFileBrowserStore.setState({ transfer: { action: 'move', ids: [1] } });

    await useFileBrowserStore.getState().transferTo('move', [1], '/videos/b');

    expect(useFileBrowserStore.getState().transfer).not.toBeNull();
    const toasts = useUIStore.getState().toasts;
    expect(toasts[0]?.kind).toBe('error');
    expect(toasts[0]?.message).toBe(t('toast.error', { message: 'Файл не найден на диске' }));
    expect(useFileBrowserStore.getState().transferring).toBe(false);
  });

  it('transferTo ловит исключение и показывает ошибку', async () => {
    transferVideos.mockRejectedValue(new Error('Путь вне отслеживаемых папок'));
    useFileBrowserStore.setState({ transfer: { action: 'move', ids: [1] } });

    await useFileBrowserStore.getState().transferTo('move', [1], '/etc');

    const toasts = useUIStore.getState().toasts;
    expect(toasts[0]?.kind).toBe('error');
    expect(toasts[0]?.message).toBe(
      t('toast.error', { message: 'Путь вне отслеживаемых папок' }),
    );
    expect(useFileBrowserStore.getState().transfer).not.toBeNull();
    expect(listVideos).not.toHaveBeenCalled();
  });

  it('openTransfer/closeTransfer управляют состоянием диалога', () => {
    useFileBrowserStore.getState().openTransfer('copy', [3, 3, 4]);
    expect(useFileBrowserStore.getState().transfer).toEqual({ action: 'copy', ids: [3, 4] });

    useFileBrowserStore.getState().closeTransfer();
    expect(useFileBrowserStore.getState().transfer).toBeNull();
  });

  it('destinationLabel показывает путь относительно watched root', () => {
    const watched: Folder[] = [makeFolder('/videos'), makeFolder('/home/u/clips', 2)];

    expect(destinationLabel('/videos/Учёба/Математика', watched)).toBe('Учёба/Математика');
    expect(destinationLabel('/videos', watched)).toBe('videos');
    expect(destinationLabel('/home/u/clips', watched)).toBe('clips');
    expect(destinationLabel('/other/Математика', watched)).toBe('Математика');
  });

  it('читает режим и колонки из localStorage при создании стора', async () => {
    window.localStorage.setItem('vl.ui.viewMode', JSON.stringify({ v: 1, value: 'grid' }));
    window.localStorage.setItem('vl.ui.gridColumns', JSON.stringify({ v: 1, value: 4 }));
    vi.resetModules();

    const fresh = await import('./fileBrowserStore');

    expect(fresh.useFileBrowserStore.getState().viewMode).toBe('grid');
    expect(fresh.useFileBrowserStore.getState().gridColumns).toBe(4);
  });
});
