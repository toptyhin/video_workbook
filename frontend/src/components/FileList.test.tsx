import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('../api/client', () => ({
  api: {
    listVideos: vi.fn(),
    scan: vi.fn(),
    enqueue: vi.fn(),
    deleteVideo: vi.fn(),
    reprocess: vi.fn(),
    tags: vi.fn(),
    createTag: vi.fn(),
    patchTag: vi.fn(),
    deleteTag: vi.fn(),
    addVideoTag: vi.fn(),
    removeVideoTag: vi.fn(),
    exportTags: vi.fn(),
    importTags: vi.fn(),
    patchSettings: vi.fn(),
    search: vi.fn(),
    folders: vi.fn(),
    fsList: vi.fn(),
    addFolder: vi.fn(),
    removeFolder: vi.fn(),
    getSettings: vi.fn(),
    health: vi.fn(),
  },
}));

import { api } from '../api/client';
import type { Video } from '../api/types';
import { t } from '../lib/i18n';
import { useLibraryStore } from '../state/libraryStore';
import { useSearchStore } from '../state/searchStore';
import { useTagsStore } from '../state/tagsStore';
import { useUIStore } from '../state/uiStore';
import { FileList } from './FileList';

const listVideos = vi.mocked(api.listVideos);

function makeVideo(id: number, overrides: Partial<Video> = {}): Video {
  return {
    id,
    path: `/videos/lesson-${id}.mp4`,
    title: `lesson-${id}.mp4`,
    duration_ms: 60_000,
    size_bytes: 2048,
    sha256: null,
    status: 'done',
    progress: 1,
    error: null,
    added_at: '2024-01-01T00:00:00Z',
    processed_at: null,
    lang: null,
    model: null,
    headline: null,
    mtime_ms: null,
    tags_count: 2,
    ...overrides,
  };
}

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

beforeEach(() => {
  vi.clearAllMocks();
  installMemoryStorage();
  window.localStorage.clear();
  listVideos.mockResolvedValue({ items: [], total: 0 });
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
  useTagsStore.setState({
    tree: [],
    loading: false,
    error: null,
    loaded: true,
    expandedIds: [],
    activeTagIds: [],
    lastActiveId: null,
    mode: 'union',
  });
  useSearchStore.setState({ query: '', results: [], total: 0, loading: false, error: null, tookMs: null });
  useUIStore.setState({ selectedVideoId: null, toasts: [] });
});

describe('FileList', () => {
  it('рендерит колонки и строки файлов', () => {
    useLibraryStore.setState({ videos: [makeVideo(1)], total: 1 });

    render(<FileList />);

    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByText('lesson-1.mp4')).toBeInTheDocument();
    expect(screen.getByText('01:00')).toBeInTheDocument();
    expect(screen.getByText(t('status.done'))).toBeInTheDocument();
    expect(screen.getByText(t('files.columnFile'))).toBeInTheDocument();
    expect(screen.getByText(t('files.columnDuration'))).toBeInTheDocument();
    expect(screen.getByText(t('files.columnStatus'))).toBeInTheDocument();
    expect(screen.getByText(t('files.columnTags'))).toBeInTheDocument();
    expect(screen.getByText(t('files.columnDate'))).toBeInTheDocument();
  });

  it('показывает прогресс обработки в статусе', () => {
    useLibraryStore.setState({
      videos: [makeVideo(1, { status: 'processing', progress: 0.42 })],
      total: 1,
    });

    render(<FileList />);

    expect(screen.getByText(t('status.processing', { percent: 42 }))).toBeInTheDocument();
  });

  it('сортирует по клику на заголовок колонки', async () => {
    useLibraryStore.setState({ videos: [makeVideo(1)], total: 1 });
    render(<FileList />);

    fireEvent.click(screen.getByRole('button', { name: t('files.columnDuration') }));

    await waitFor(() => expect(listVideos).toHaveBeenCalledTimes(1));
    expect(listVideos).toHaveBeenCalledWith(
      expect.objectContaining({ sort: 'duration_ms', dir: 'asc' }),
    );
  });

  it('двойной клик открывает видео через vl:open', () => {
    useLibraryStore.setState({ videos: [makeVideo(1)], total: 1 });
    const handler = vi.fn();
    window.addEventListener('vl:open', handler);

    render(<FileList />);
    fireEvent.doubleClick(screen.getByText('lesson-1.mp4'));

    expect(useUIStore.getState().selectedVideoId).toBe(1);
    expect(handler).toHaveBeenCalledTimes(1);
    const event = handler.mock.calls[0]?.[0] as CustomEvent<{ videoId: number }>;
    expect(event.detail.videoId).toBe(1);
    window.removeEventListener('vl:open', handler);
  });

  it('Ctrl+клик накапливает выделение строк', () => {
    useLibraryStore.setState({ videos: [makeVideo(1), makeVideo(2)], total: 2 });
    render(<FileList />);

    const firstRow = screen.getByText('lesson-1.mp4').closest('tr');
    const secondRow = screen.getByText('lesson-2.mp4').closest('tr');
    expect(firstRow).not.toBeNull();
    expect(secondRow).not.toBeNull();
    if (!firstRow || !secondRow) return;

    fireEvent.click(firstRow);
    expect(useLibraryStore.getState().selectedIds).toEqual([1]);

    fireEvent.click(secondRow, { ctrlKey: true });
    expect(useLibraryStore.getState().selectedIds).toEqual([1, 2]);
    expect(firstRow).toHaveAttribute('aria-selected', 'true');
    expect(secondRow).toHaveAttribute('aria-selected', 'true');
  });

  it('показывает пустое состояние при отсутствии файлов', () => {
    render(<FileList />);

    expect(screen.getByText(t('files.empty'))).toBeInTheDocument();
  });

  it('показывает строку «Найдено N…» при активном поиске', () => {
    useLibraryStore.setState({ videos: [makeVideo(1)], total: 1 });
    useSearchStore.setState({ query: 'урок', total: 3, results: [], loading: false });

    render(<FileList />);

    expect(screen.getByText(t('files.found', { count: 3, query: 'урок' }))).toBeInTheDocument();
  });

  it('по правому клику открывает контекстное меню', () => {
    useLibraryStore.setState({ videos: [makeVideo(1)], total: 1 });
    render(<FileList />);

    const row = screen.getByText('lesson-1.mp4').closest('tr');
    expect(row).not.toBeNull();
    if (!row) return;
    fireEvent.contextMenu(row);

    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: t('timings.reprocess') })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: t('player.showInFolder') })).toBeInTheDocument();
  });
});
