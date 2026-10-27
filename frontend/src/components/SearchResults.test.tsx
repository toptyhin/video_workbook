import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('../api/client', () => ({
  api: { search: vi.fn(), semanticStatus: vi.fn(), semanticReindex: vi.fn() },
}));

import { api } from '../api/client';
import type { SearchItem, SearchResponse, SemanticStatus } from '../api/types';
import { t } from '../lib/i18n';
import { useSearchStore } from '../state/searchStore';
import { useUIStore } from '../state/uiStore';
import { SearchResults } from './SearchResults';

const search = vi.mocked(api.search);
const semanticReindex = vi.mocked(api.semanticReindex);

const segmentItem: SearchItem = {
  kind: 'segment',
  video_id: 3,
  video_title: 'lesson-03.mp4',
  segment_id: 41,
  start_ms: 72_000,
  end_ms: 78_000,
  text: 'производные функции',
  snippet_html: 'производные <mark>функции</mark>',
  score: 2.1,
};

const semanticSegmentItem: SearchItem = { ...segmentItem, semantic: true };

const fileItem: SearchItem = {
  kind: 'file',
  video_id: 4,
  video_title: 'lesson-04.mp4',
  path: '/videos/lesson-04.mp4',
  duration_ms: 500_000,
  snippet_html: 'lesson-04.mp4',
  score: 1,
};

const annotationItem: SearchItem = {
  kind: 'annotation',
  video_id: 5,
  video_title: 'lesson-05.mp4',
  annotation_id: 7,
  start_ms: 30_000,
  end_ms: 75_000,
  label: 'важный пример',
  note: 'заметка',
  color: '#3b82f6',
  tag_ids: [],
  snippet_html: 'важный <mark>пример</mark>',
  score: 3.05,
};

const semanticAvailable: SemanticStatus = {
  available: true,
  model: 'multilingual-e5-small',
  dim: 384,
  indexed_segments: 10,
  total_segments: 10,
  indexing: false,
  autoindex: true,
  detail: null,
};

const semanticUnavailable: SemanticStatus = {
  ...semanticAvailable,
  available: false,
  indexed_segments: 0,
  detail: 'модель эмбеддингов не найдена',
};

// jsdom в этом окружении не даёт localStorage — подменяем in-memory Storage.
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
  Object.defineProperty(window, 'localStorage', {
    value: storage,
    configurable: true,
    writable: true,
  });
}

function makeResponse(items: SearchItem[]): SearchResponse {
  return {
    query: { raw: 'урок', fts: 'урок', scope: 'all', prefixes: { tags: [], file: null } },
    total: items.length,
    items,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  installMemoryStorage();
  window.localStorage.clear();
  useSearchStore.setState({
    query: 'урок',
    scope: 'all',
    mode: 'hybrid',
    modeUsed: null,
    results: [],
    total: 0,
    loading: false,
    error: null,
    tookMs: null,
    semantic: null,
    semanticLoading: false,
  });
  useUIStore.setState({ selectedVideoId: null, toasts: [] });
  search.mockResolvedValue(makeResponse([]));
  semanticReindex.mockResolvedValue({ ...semanticAvailable, indexing: true, state: 'indexing' });
});

describe('SearchResults', () => {
  it('не рендерится без запроса и результатов', () => {
    useSearchStore.setState({ query: '', results: [], total: 0 });

    const { container } = render(<SearchResults />);

    expect(container).toBeEmptyDOMElement();
  });

  it('рендерит результаты с таймкодами, видом и подсветкой <mark>', () => {
    useSearchStore.setState({ results: [fileItem, segmentItem], total: 2 });

    render(<SearchResults />);

    expect(screen.getByText(t('search.results'))).toBeInTheDocument();
    expect(screen.getByText('lesson-03.mp4')).toBeInTheDocument();
    expect(screen.getByText('функции')).toBeInTheDocument();
    expect(screen.getByText('01:12')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: t('search.file') })).toHaveAttribute('aria-pressed', 'true');
  });

  it('фильтрует результаты по kind-чипам', () => {
    useSearchStore.setState({ results: [fileItem, segmentItem], total: 2 });
    render(<SearchResults />);

    expect(screen.getAllByText('lesson-04.mp4').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: t('search.file') }));

    expect(screen.queryByText('lesson-04.mp4')).not.toBeInTheDocument();
    expect(screen.getByText('lesson-03.mp4')).toBeInTheDocument();
  });

  it('клик по сегменту открывает видео и публикует vl:open + vl:seek', () => {
    useSearchStore.setState({ results: [segmentItem], total: 1 });
    const openHandler = vi.fn();
    const seekHandler = vi.fn();
    window.addEventListener('vl:open', openHandler);
    window.addEventListener('vl:seek', seekHandler);

    render(<SearchResults />);
    fireEvent.click(screen.getByText('функции'));

    expect(useUIStore.getState().selectedVideoId).toBe(3);
    const openEvent = openHandler.mock.calls[0]?.[0] as CustomEvent<{ videoId: number; ms?: number }>;
    expect(openEvent.detail).toEqual({ videoId: 3, ms: 72_000 });
    const seekEvent = seekHandler.mock.calls[0]?.[0] as CustomEvent<{ videoId: number; ms: number }>;
    expect(seekEvent.detail).toEqual({ videoId: 3, ms: 72_000 });

    window.removeEventListener('vl:open', openHandler);
    window.removeEventListener('vl:seek', seekHandler);
  });

  it('клик по файлу открывает видео без seek', () => {
    useSearchStore.setState({ results: [fileItem], total: 1 });
    const seekHandler = vi.fn();
    window.addEventListener('vl:seek', seekHandler);

    render(<SearchResults />);
    fireEvent.click(screen.getAllByText('lesson-04.mp4')[0] as HTMLElement);

    expect(useUIStore.getState().selectedVideoId).toBe(4);
    expect(seekHandler).not.toHaveBeenCalled();
    window.removeEventListener('vl:seek', seekHandler);
  });

  it('показывает метку с цветовым маркером', () => {
    useSearchStore.setState({ results: [annotationItem], total: 1 });

    render(<SearchResults />);

    expect(screen.getByText('важный пример')).toBeInTheDocument();
    expect(screen.getByText('00:30')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: t('search.annotation') })).toBeInTheDocument();
  });

  it('показывает пустое состояние и ошибку', () => {
    useSearchStore.setState({ results: [], total: 0 });
    const { rerender } = render(<SearchResults />);
    expect(screen.getByText(t('search.empty'))).toBeInTheDocument();

    act(() => {
      useSearchStore.setState({ error: 'boom', results: [], total: 0 });
    });
    rerender(<SearchResults />);
    expect(screen.getByText(t('toast.error', { message: 'boom' }))).toBeInTheDocument();
  });

  it('кнопка закрытия очищает поиск', () => {
    useSearchStore.setState({ results: [fileItem], total: 1 });
    render(<SearchResults />);

    fireEvent.click(screen.getByRole('button', { name: t('common.close') }));

    expect(useSearchStore.getState().query).toBe('');
    expect(useSearchStore.getState().results).toEqual([]);
  });

  it('переключатель режимов: aria-pressed и повторный поиск с выбранным режимом', async () => {
    render(<SearchResults />);

    expect(screen.getByRole('button', { name: t('search.modeHybrid') })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: t('search.modeFts') })).toHaveAttribute(
      'aria-pressed',
      'false',
    );

    fireEvent.click(screen.getByRole('button', { name: t('search.modeFts') }));

    expect(useSearchStore.getState().mode).toBe('fts');
    expect(screen.getByRole('button', { name: t('search.modeFts') })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await waitFor(() =>
      expect(search).toHaveBeenCalledWith(
        expect.objectContaining({ q: 'урок', mode: 'fts' }),
        expect.any(AbortSignal),
      ),
    );
  });

  it('дизейблит «Семантика»/«Гибрид» и показывает причину недоступности', () => {
    useSearchStore.setState({ mode: 'fts', semantic: semanticUnavailable });
    const reason = t('search.semanticUnavailable', { detail: semanticUnavailable.detail as string });

    render(<SearchResults />);

    expect(screen.getByRole('button', { name: t('search.modeSemantic') })).toBeDisabled();
    expect(screen.getByRole('button', { name: t('search.modeHybrid') })).toBeDisabled();
    expect(screen.getByRole('button', { name: t('search.modeSemantic') })).toHaveAttribute(
      'title',
      reason,
    );
    expect(screen.getByRole('button', { name: t('search.modeFts') })).toBeEnabled();
    expect(screen.getByText(reason)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: t('search.reindex') })).not.toBeInTheDocument();
  });

  it('показывает «Индексируется: X/Y» и переиндексацию', async () => {
    useSearchStore.setState({ semantic: { ...semanticAvailable, indexing: true, indexed_segments: 3, total_segments: 8 } });
    const { rerender } = render(<SearchResults />);

    expect(
      screen.getByText(t('search.semanticIndexing', { indexed: 3, total: 8 })),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: t('search.reindex') })).toBeDisabled();

    act(() => {
      useSearchStore.setState({
        semantic: { ...semanticAvailable, indexing: false, indexed_segments: 8, total_segments: 8 },
      });
    });
    rerender(<SearchResults />);

    expect(screen.getByRole('button', { name: t('search.reindex') })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: t('search.reindex') }));

    await waitFor(() => expect(semanticReindex).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(useSearchStore.getState().semantic?.indexing).toBe(true),
    );
  });

  it('показывает чип «семантика» только для semantic=true', () => {
    useSearchStore.setState({ results: [semanticSegmentItem], total: 1 });
    const { unmount } = render(<SearchResults />);
    expect(screen.getByText(t('search.semanticBadge'))).toBeInTheDocument();
    unmount();

    useSearchStore.setState({ results: [segmentItem], total: 1 });
    render(<SearchResults />);
    expect(screen.queryByText(t('search.semanticBadge'))).not.toBeInTheDocument();
  });

  it('показывает подсказку о scope, где семантика работает только по сегментам', () => {
    useSearchStore.setState({ mode: 'semantic', scope: 'files', semantic: semanticAvailable });

    render(<SearchResults />);

    expect(screen.getByText(t('search.semanticScopeHint'))).toBeInTheDocument();
  });
});
