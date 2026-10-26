import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api/client', () => ({
  api: {
    listVideos: vi.fn(),
    scan: vi.fn(),
    enqueue: vi.fn(),
    deleteVideo: vi.fn(),
    reprocess: vi.fn(),
  },
}));

import { api } from '../api/client';
import type { Video, VideoListResponse } from '../api/types';
import { useLibraryStore } from './libraryStore';
import { useUIStore } from './uiStore';

const listVideos = vi.mocked(api.listVideos);
const scan = vi.mocked(api.scan);
const enqueue = vi.mocked(api.enqueue);
const deleteVideo = vi.mocked(api.deleteVideo);
const reprocess = vi.mocked(api.reprocess);

function makeVideo(id: number, overrides: Partial<Video> = {}): Video {
  return {
    id,
    path: `/videos/lesson-${id}.mp4`,
    title: `lesson-${id}.mp4`,
    duration_ms: 60_000,
    size_bytes: 1024,
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
    tags_count: 0,
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
  scan.mockResolvedValue({ scan_id: 'scan-1', state: 'running', root: '/videos' });
  enqueue.mockResolvedValue({ queued: [], skipped: [] });
  deleteVideo.mockResolvedValue(undefined);
  reprocess.mockResolvedValue({ id: 1, status: 'queued' });
});

describe('libraryStore', () => {
  it('loadVideos передаёт папку, теги, сортировку и сохраняет результат', async () => {
    listVideos.mockResolvedValue({ items: [makeVideo(1)], total: 1 });
    useLibraryStore.setState({
      folderPath: '/videos',
      activeTagIds: [2, 3],
      tagMode: 'all',
      sort: 'duration_ms',
      dir: 'asc',
    });

    await useLibraryStore.getState().loadVideos();

    expect(listVideos).toHaveBeenCalledWith({
      sort: 'duration_ms',
      dir: 'asc',
      limit: 500,
      offset: 0,
      folder: '/videos',
      tag_ids: [2, 3],
      tag_mode: 'all',
      include_children: true,
    });
    expect(useLibraryStore.getState().videos.map((video) => video.id)).toEqual([1]);
    expect(useLibraryStore.getState().total).toBe(1);
    expect(useLibraryStore.getState().loading).toBe(false);
  });

  it('игнорирует ответ устаревшего запроса (seq-guard)', async () => {
    let resolveFirst: (value: VideoListResponse) => void = () => undefined;
    const first = new Promise<VideoListResponse>((resolve) => {
      resolveFirst = resolve;
    });
    listVideos.mockReturnValueOnce(first).mockResolvedValueOnce({ items: [makeVideo(2)], total: 1 });

    const firstLoad = useLibraryStore.getState().loadVideos();
    const secondLoad = useLibraryStore.getState().loadVideos();
    await secondLoad;
    resolveFirst({ items: [makeVideo(1)], total: 1 });
    await firstLoad;

    expect(useLibraryStore.getState().videos.map((video) => video.id)).toEqual([2]);
  });

  it('setFolder сбрасывает фильтр по тегам и перезагружает список', async () => {
    useLibraryStore.setState({ activeTagIds: [5], selectedIds: [1] });
    useLibraryStore.getState().setFolder('/library');

    expect(useLibraryStore.getState().folderPath).toBe('/library');
    expect(useLibraryStore.getState().activeTagIds).toEqual([]);
    expect(useLibraryStore.getState().selectedIds).toEqual([]);
    expect(listVideos).toHaveBeenCalledTimes(1);
  });

  it('toggleSelect поддерживает Ctrl- и Shift-выбор', () => {
    const store = useLibraryStore.getState();
    store.setSelection([]);
    useLibraryStore.setState({
      videos: [makeVideo(1), makeVideo(2), makeVideo(3), makeVideo(4)],
      selectedIds: [],
      lastClickedId: null,
    });

    useLibraryStore.getState().toggleSelect(2);
    expect(useLibraryStore.getState().selectedIds).toEqual([2]);

    useLibraryStore.getState().toggleSelect(4, { range: true });
    expect(useLibraryStore.getState().selectedIds).toEqual([2, 3, 4]);

    useLibraryStore.getState().toggleSelect(1, { additive: true });
    expect(useLibraryStore.getState().selectedIds).toEqual([2, 3, 4, 1]);

    useLibraryStore.getState().toggleSelect(1, { additive: true });
    expect(useLibraryStore.getState().selectedIds).toEqual([2, 3, 4]);
  });

  it('setSort переключает направление и сохраняет ключ в localStorage', () => {
    useLibraryStore.setState({ sort: 'added_at', dir: 'desc' });

    useLibraryStore.getState().setSort('added_at');
    expect(useLibraryStore.getState().dir).toBe('asc');

    useLibraryStore.getState().setSort('title');
    expect(useLibraryStore.getState().sort).toBe('title');
    expect(useLibraryStore.getState().dir).toBe('asc');
    expect(window.localStorage.getItem('vl.ui.sort')).toContain('title:asc');
  });

  it('selectVideo пишет в uiStore и публикует vl:open', () => {
    const handler = vi.fn();
    window.addEventListener('vl:open', handler);

    useLibraryStore.getState().selectVideo(7, 1500);

    expect(useUIStore.getState().selectedVideoId).toBe(7);
    expect(handler).toHaveBeenCalledTimes(1);
    const event = handler.mock.calls[0]?.[0] as CustomEvent<{ videoId: number; ms?: number }>;
    expect(event.detail).toEqual({ videoId: 7, ms: 1500 });
    window.removeEventListener('vl:open', handler);
  });

  it('scanPaths сканирует каждый путь и обновляет список', async () => {
    await useLibraryStore.getState().scanPaths(['/a.mp4', '/b.mp4', '/a.mp4']);

    expect(scan).toHaveBeenCalledTimes(2);
    expect(scan).toHaveBeenNthCalledWith(1, '/a.mp4');
    expect(scan).toHaveBeenNthCalledWith(2, '/b.mp4');
    expect(listVideos).toHaveBeenCalledTimes(1);
  });

  it('removeSelected удаляет выбранные файлы, очищает выбор и делает refresh', async () => {
    useLibraryStore.setState({ selectedIds: [1, 2], videos: [makeVideo(1), makeVideo(2)] });
    useUIStore.setState({ selectedVideoId: 1 });

    await useLibraryStore.getState().removeSelected();

    expect(deleteVideo).toHaveBeenCalledTimes(2);
    expect(useLibraryStore.getState().selectedIds).toEqual([]);
    expect(useUIStore.getState().selectedVideoId).toBeNull();
    expect(listVideos).toHaveBeenCalledTimes(1);
  });

  it('enqueueSelected ставит выбранные файлы в очередь и сообщает количество', async () => {
    useLibraryStore.setState({ selectedIds: [1, 2] });
    enqueue.mockResolvedValue({ queued: [1, 2], skipped: [] });

    await useLibraryStore.getState().enqueueSelected();

    expect(enqueue).toHaveBeenCalledWith([1, 2]);
    const toasts = useUIStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.kind).toBe('success');
    expect(reprocess).not.toHaveBeenCalled();
  });

  it('reprocessSelected переобрабатывает выбранные файлы', async () => {
    useLibraryStore.setState({ selectedIds: [1] });

    await useLibraryStore.getState().reprocessSelected();

    expect(reprocess).toHaveBeenCalledWith(1);
    expect(listVideos).toHaveBeenCalledTimes(1);
  });

  it('setActiveTags применяет фильтр и режим intersection', () => {
    useLibraryStore.getState().setActiveTags([3], 'all');

    expect(useLibraryStore.getState().activeTagIds).toEqual([3]);
    expect(useLibraryStore.getState().tagMode).toBe('all');
    expect(listVideos).toHaveBeenCalledTimes(1);
  });
});
