import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

vi.mock('../api/client', () => ({
  api: {
    folders: vi.fn(),
    fsList: vi.fn(),
    transferVideos: vi.fn(),
    listVideos: vi.fn(),
  },
}));

import { api } from '../api/client';
import type { Folder, FsListResponse, TransferResponse, Video } from '../api/types';
import { t } from '../lib/i18n';
import { useFileBrowserStore } from '../state/fileBrowserStore';
import { useLibraryStore } from '../state/libraryStore';
import { useUIStore } from '../state/uiStore';
import { FolderPickerDialog } from './FolderPickerDialog';

const folders = vi.mocked(api.folders);
const fsList = vi.mocked(api.fsList);
const transferVideos = vi.mocked(api.transferVideos);

function makeFolder(path: string, id = 1): Folder {
  return { id, path, added_at: '2024-01-01T00:00:00Z', total: 0, done: 0 };
}

function makeVideo(id: number, path: string): Video {
  return {
    id,
    path,
    title: null,
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
  };
}

function transferResponse(overrides: Partial<TransferResponse> = {}): TransferResponse {
  return {
    action: 'move',
    destination: '/videos/sub',
    items: [
      {
        id: 1,
        ok: true,
        code: null,
        detail: null,
        path: '/videos/sub/lesson.mp4',
        new_id: null,
      },
    ],
    moved: 1,
    copied: 0,
    failed: 0,
    recent_destinations: ['/videos/sub'],
    ...overrides,
  };
}

/** Дерево: /videos (root) → sub; /videos/sub — лист. */
function fsListResponse(path: string): FsListResponse {
  if (path === '/videos') {
    return {
      path: '/videos',
      parent: null,
      entries: [{ name: 'sub', path: '/videos/sub', mtime_ms: 0, watched: false }],
    };
  }
  return { path, parent: path === '/videos/sub' ? '/videos' : null, entries: [] };
}

beforeEach(() => {
  vi.clearAllMocks();
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
  useUIStore.setState({ selectedVideoId: null, toasts: [] });
  folders.mockResolvedValue({ items: [makeFolder('/videos')], total: 1 });
  fsList.mockImplementation(async (path: string) => fsListResponse(path));
  transferVideos.mockResolvedValue(transferResponse());
  vi.mocked(api.listVideos).mockResolvedValue({ items: [], total: 0 });
});

describe('FolderPickerDialog', () => {
  it('ничего не рендерит без открытого transfer', () => {
    render(<FolderPickerDialog />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('стартует с родителя первого выбранного файла и перемещает туда', async () => {
    useFileBrowserStore.setState({ folders: [makeFolder('/videos')] });
    useLibraryStore.setState({ videos: [makeVideo(1, '/videos/sub/lesson.mp4')], total: 1 });
    useFileBrowserStore.getState().openTransfer('move', [1]);

    render(<FolderPickerDialog />);

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    await waitFor(() => expect(fsList).toHaveBeenCalledWith('/videos/sub'));
    expect(within(dialog).getByText('/videos/sub')).toBeInTheDocument();
    expect(within(dialog).getByText(t('files.selectedCount', { count: 1 }))).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: t('files.moveHere') }));

    await waitFor(() =>
      expect(transferVideos).toHaveBeenCalledWith({
        action: 'move',
        ids: [1],
        destination: '/videos/sub',
      }),
    );
    await waitFor(() => expect(useFileBrowserStore.getState().transfer).toBeNull());
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('навигируется по fsList: корни → подпапка → «↑ На уровень выше»', async () => {
    useFileBrowserStore.getState().openTransfer('copy', [1]);
    render(<FolderPickerDialog />);

    const dialog = await screen.findByRole('dialog');
    // Стартовой папки нет (видео не выбрано) — показываем watched roots.
    await waitFor(() => expect(folders).toHaveBeenCalledTimes(1));
    const rootButton = await within(dialog).findByRole('button', { name: 'videos' });
    fireEvent.click(rootButton);
    await waitFor(() => expect(fsList).toHaveBeenCalledWith('/videos'));

    const subButton = await within(dialog).findByRole('button', { name: 'sub' });
    fireEvent.click(subButton);
    await waitFor(() => expect(fsList).toHaveBeenCalledWith('/videos/sub'));

    const up = within(dialog).getByRole('button', { name: t('files.up') });
    expect(up).toBeEnabled();
    fireEvent.click(up);
    await waitFor(() => expect(fsList).toHaveBeenCalledWith('/videos'));
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: t('files.up') })).toBeDisabled(),
    );
  });

  it('подтверждение блокируется, пока не выбран каталог', async () => {
    useFileBrowserStore.getState().openTransfer('move', [1]);
    render(<FolderPickerDialog />);

    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(folders).toHaveBeenCalled());
    expect(within(dialog).getByRole('button', { name: t('files.moveHere') })).toBeDisabled();
  });

  it('Escape и «Отмена» закрывают диалог', async () => {
    useFileBrowserStore.getState().openTransfer('move', [1]);
    render(<FolderPickerDialog />);
    const firstDialog = await screen.findByRole('dialog');
    // Дожидаемся окончания загрузки корней, чтобы не обновлять состояние после Escape.
    await within(firstDialog).findByRole('button', { name: 'videos' });

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(useFileBrowserStore.getState().transfer).toBeNull());

    act(() => {
      useFileBrowserStore.getState().openTransfer('move', [1]);
    });
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: t('files.cancel') }));
    await waitFor(() => expect(useFileBrowserStore.getState().transfer).toBeNull());
  });

  it('busy-состояние блокирует кнопки и показывает заглушку', async () => {
    useFileBrowserStore.setState({ folders: [makeFolder('/videos')] });
    useFileBrowserStore.getState().openTransfer('move', [1, 2]);
    useFileBrowserStore.setState({ transferring: true });

    render(<FolderPickerDialog />);

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAttribute('aria-busy', 'true');
    expect(within(dialog).getByRole('button', { name: t('files.cancel') })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: t('files.transferring') })).toBeDisabled();
  });

  it('ошибка transfer оставляет диалог открытым и показывает toast', async () => {
    transferVideos.mockRejectedValueOnce(new Error('Путь вне отслеживаемых папок'));
    useFileBrowserStore.setState({ folders: [makeFolder('/videos')] });
    useLibraryStore.setState({ videos: [makeVideo(1, '/videos/sub/lesson.mp4')], total: 1 });
    useFileBrowserStore.getState().openTransfer('move', [1]);
    render(<FolderPickerDialog />);

    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(fsList).toHaveBeenCalledWith('/videos/sub'));
    fireEvent.click(within(dialog).getByRole('button', { name: t('files.moveHere') }));

    await waitFor(() => expect(useUIStore.getState().toasts).toHaveLength(1));
    expect(useUIStore.getState().toasts[0]?.kind).toBe('error');
    expect(useFileBrowserStore.getState().transfer).not.toBeNull();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(useFileBrowserStore.getState().transferring).toBe(false);
  });
});
