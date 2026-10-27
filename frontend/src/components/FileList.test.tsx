import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

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
    transferVideos: vi.fn(),
  },
  mediaUrl: vi.fn((videoId: number, kind: string) => `/media/${videoId}/${kind}`),
}));

import { api } from '../api/client';
import type { Folder, TransferResponse, Video } from '../api/types';
import { t } from '../lib/i18n';
import { useFileBrowserStore } from '../state/fileBrowserStore';
import { useLibraryStore } from '../state/libraryStore';
import { useSearchStore } from '../state/searchStore';
import { useTagsStore } from '../state/tagsStore';
import { useUIStore } from '../state/uiStore';
import { FileList } from './FileList';
import { FolderPickerDialog } from './FolderPickerDialog';

const listVideos = vi.mocked(api.listVideos);
const transferVideos = vi.mocked(api.transferVideos);
const folders = vi.mocked(api.folders);
const fsList = vi.mocked(api.fsList);

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

function makeFolder(path: string, id = 1): Folder {
  return { id, path, added_at: '2024-01-01T00:00:00Z', total: 0, done: 0 };
}

function transferResponse(overrides: Partial<TransferResponse> = {}): TransferResponse {
  return {
    action: 'move',
    destination: '/videos/Учёба',
    items: [
      {
        id: 1,
        ok: true,
        code: null,
        detail: null,
        path: '/videos/Учёба/lesson-1.mp4',
        new_id: null,
      },
    ],
    moved: 1,
    copied: 0,
    failed: 0,
    recent_destinations: ['/videos/Учёба'],
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

function switchToGrid(): HTMLElement {
  fireEvent.click(screen.getByRole('button', { name: t('files.viewGrid') }));
  return screen.getByRole('listbox');
}

beforeEach(() => {
  vi.clearAllMocks();
  installMemoryStorage();
  window.localStorage.clear();
  listVideos.mockResolvedValue({ items: [], total: 0 });
  transferVideos.mockResolvedValue(transferResponse());
  folders.mockResolvedValue({ items: [makeFolder('/videos')], total: 1 });
  fsList.mockResolvedValue({ path: '/videos', parent: null, entries: [] });
  useFileBrowserStore.setState({
    viewMode: 'list',
    gridColumns: 6,
    recentDestinations: [],
    folders: [],
    transfer: null,
    transferring: false,
    initialized: true,
  });
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
    expect(listVideos).toHaveBeenCalledWith(expect.objectContaining({ sort: 'duration_ms', dir: 'asc' }));
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

  // --- V5 (plans/15 §5): блочный вид и операции с папкой ---

  it('по умолчанию показывает таблицу, «Блоками» включает сетку и сохраняет режим', () => {
    const videos = Array.from({ length: 6 }, (_, index) => makeVideo(index + 1));
    useLibraryStore.setState({ videos, total: videos.length });
    const { unmount } = render(<FileList />);

    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.queryByRole('listbox')).toBeNull();

    const grid = switchToGrid();

    expect(screen.queryByRole('table')).toBeNull();
    expect(within(grid).getAllByRole('option')).toHaveLength(6);
    expect(grid.style.getPropertyValue('--vl-grid-columns')).toBe('6');
    const stored = JSON.parse(window.localStorage.getItem('vl.ui.viewMode') ?? '{}') as {
      value?: string;
    };
    expect(stored.value).toBe('grid');

    // «Перезагрузка» панели: режим берётся из стора/локалстораджа.
    unmount();
    render(<FileList />);
    const restored = screen.getByRole('listbox');
    expect(within(restored).getAllByRole('option')).toHaveLength(6);

    fireEvent.click(screen.getByRole('button', { name: t('files.viewList') }));
    expect(screen.getByRole('table')).toBeInTheDocument();
  });

  it('select «Блоков в ряд» (2…12) меняет CSS-колонки и localStorage', () => {
    useLibraryStore.setState({ videos: [makeVideo(1)], total: 1 });
    render(<FileList />);
    const grid = switchToGrid();

    const select = screen.getByRole('combobox', { name: t('files.gridColumns') });
    expect(select).toHaveValue('6');
    const optionValues = Array.from(select.querySelectorAll('option')).map((option) => option.value);
    expect(optionValues).toEqual(['2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12']);

    fireEvent.change(select, { target: { value: '4' } });

    expect(grid.style.getPropertyValue('--vl-grid-columns')).toBe('4');
    const stored = JSON.parse(window.localStorage.getItem('vl.ui.gridColumns') ?? '{}') as {
      value?: number;
    };
    expect(stored.value).toBe(4);
  });

  it('в строчном режиме контекстное меню содержит перемещение и копирование в папку', () => {
    useLibraryStore.setState({ videos: [makeVideo(1)], total: 1 });
    render(<FileList />);

    const row = screen.getByText('lesson-1.mp4').closest('tr');
    expect(row).not.toBeNull();
    if (!row) return;
    fireEvent.contextMenu(row);

    expect(screen.getByRole('menuitem', { name: t('files.moveTo') })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: t('files.copyTo') })).toBeInTheDocument();
  });

  it('блочный вид: контекстное меню с историей адресатов перемещает файл', async () => {
    useFileBrowserStore.setState({
      // Backend отдаёт не больше 5 адресатов (plans/15 §3.2); проверим, что UI режет так же.
      recentDestinations: [
        '/videos/Учёба',
        '/videos/Разное',
        '/videos/Прочее',
        '/videos/Ещё',
        '/videos/Пятое',
        '/videos/Шестое',
      ],
      folders: [makeFolder('/videos')],
    });
    useLibraryStore.setState({ videos: [makeVideo(1)], total: 1 });
    render(<FileList />);
    const grid = switchToGrid();

    const card = within(grid).getByRole('option');
    fireEvent.contextMenu(card);

    const moveItem = screen.getByRole('menuitem', { name: t('files.moveTo') });
    expect(screen.getByRole('menuitem', { name: t('files.copyTo') })).toBeInTheDocument();
    fireEvent.mouseEnter(moveItem);

    const historyItem = screen.getByRole('menuitem', { name: 'Учёба' });
    expect(historyItem).toHaveAttribute('title', '/videos/Учёба');
    expect(screen.getByRole('menuitem', { name: t('files.chooseFolder') })).toBeInTheDocument();
    // В истории максимум 5 адресатов (plans/15 §3.2), шестой отбрасывается.
    expect(screen.getAllByRole('menuitem', { name: /Учёба|Разное|Прочее|Ещё|Пятое/ })).toHaveLength(5);
    expect(screen.queryByRole('menuitem', { name: 'Шестое' })).toBeNull();

    fireEvent.click(historyItem);

    await waitFor(() =>
      expect(transferVideos).toHaveBeenCalledWith({
        action: 'move',
        ids: [1],
        destination: '/videos/Учёба',
      }),
    );
    await waitFor(() => expect(listVideos).toHaveBeenCalledTimes(1));
    expect(useFileBrowserStore.getState().recentDestinations).toEqual(['/videos/Учёба']);
  });

  it('«Выбрать другую папку…» открывает диалог выбора папки', async () => {
    useLibraryStore.setState({ videos: [makeVideo(1)], total: 1 });
    render(
      <>
        <FileList />
        <FolderPickerDialog />
      </>,
    );

    const row = screen.getByText('lesson-1.mp4').closest('tr');
    if (!row) throw new Error('row not found');
    fireEvent.contextMenu(row);
    fireEvent.mouseEnter(screen.getByRole('menuitem', { name: t('files.moveTo') }));
    fireEvent.click(screen.getByRole('menuitem', { name: t('files.chooseFolder') }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(t('files.folderPickTitleMove'))).toBeInTheDocument();
    expect(useFileBrowserStore.getState().transfer).toEqual({ action: 'move', ids: [1] });

    fireEvent.click(within(dialog).getByRole('button', { name: t('files.cancel') }));
    await waitFor(() => expect(useFileBrowserStore.getState().transfer).toBeNull());
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('в сетке показывает превью и при ошибке — заглушку 🎬', () => {
    useLibraryStore.setState({ videos: [makeVideo(1)], total: 1 });
    render(<FileList />);
    const grid = switchToGrid();

    const card = within(grid).getByRole('option');
    const image = card.querySelector('img');
    expect(image).not.toBeNull();
    expect(image?.getAttribute('src')).toContain('/media/1/thumb');

    if (!image) return;
    fireEvent.error(image);

    expect(card.querySelector('img')).toBeNull();
    expect(within(card).getByText('🎬')).toBeInTheDocument();
  });

  it('в сетке стрелки ↑↓ двигают фокус на строку, ←→ — на карточку', () => {
    const videos = Array.from({ length: 8 }, (_, index) => makeVideo(index + 1));
    useLibraryStore.setState({ videos, total: videos.length });
    render(<FileList />);
    const grid = switchToGrid();

    const cards = within(grid).getAllByRole('option');
    fireEvent.keyDown(cards[0]!, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(cards[1]);

    fireEvent.keyDown(cards[1]!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(cards[7]);

    fireEvent.keyDown(cards[7]!, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(cards[1]);

    fireEvent.keyDown(cards[1]!, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(cards[0]);
  });
});
