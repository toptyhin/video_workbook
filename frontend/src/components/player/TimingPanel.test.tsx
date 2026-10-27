import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../api/client', () => ({
  api: {
    annotations: vi.fn(),
    enqueue: vi.fn(),
    reprocess: vi.fn(),
    segments: vi.fn(),
    summary: vi.fn(),
    generateSummary: vi.fn(),
    getSettings: vi.fn(),
  },
  mediaUrl: (videoId: number, kind: string) => `/api/videos/${videoId}/${kind}`,
}));

import { api } from '../../api/client';
import type { Annotation, AnnotationListResponse, Segment, SummaryResponse, Video } from '../../api/types';
import { useAnnotationsStore } from '../../state/annotationsStore';
import { usePlayerStore } from '../../state/playerStore';
import { useSummaryStore } from '../../state/summaryStore';
import { useUIStore } from '../../state/uiStore';
import { TimingPanel } from './TimingPanel';

// jsdom в этом окружении не даёт localStorage (Node experimental) — подменяем in-memory Storage.
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

const SEGMENT: Segment = {
  id: 1,
  video_id: 1,
  start_ms: 10_000,
  end_ms: 40_000,
  text: 'Введение в тему',
  tag_ids: [],
};

const ANNOTATION: Annotation = {
  id: 7,
  video_id: 1,
  start_ms: 20_000,
  end_ms: 25_000,
  label: 'Важный момент',
  color: '#22c55e',
  note: null,
  tag_ids: [],
  created_at: '2026-01-01T00:00:00Z',
  updated_at: null,
};

const VIDEO: Pick<Video, 'id' | 'path' | 'title' | 'duration_ms' | 'status' | 'progress' | 'error'> = {
  id: 1,
  path: '/tmp/lesson.mp4',
  title: 'lesson.mp4',
  duration_ms: 100_000,
  status: 'done',
  progress: 1,
  error: null,
};

/** rev2: динамическое дерево глубины 2 (уровень 1 — подробные блоки, 2 — корень). */
function summaryResponse(overrides: Partial<SummaryResponse> = {}): SummaryResponse {
  return {
    video_id: 1,
    state: 'ready',
    max_level: 2,
    levels: {
      '1': {
        level: 1,
        label: 'Подробно',
        blocks: [
          { node_id: '0.1', start_ms: 0, end_ms: 30_000, title: 'Введение', text: 'Первый блок' },
          {
            node_id: '0.2',
            start_ms: 40_000,
            end_ms: 80_000,
            title: null,
            text: 'Второй блок',
            keywords: ['термин'],
          },
        ],
      },
      '2': {
        level: 2,
        label: 'Обзор',
        blocks: [{ node_id: '0', start_ms: 0, end_ms: 80_000, title: null, text: 'Корневое саммари видео' }],
      },
    },
    root_summary: 'Корневое саммари видео',
    model: { id: 'summary-lfm2.5-350m', label: 'KoarAI LFM2.5-350M-Thinking', installed: true },
    progress: null,
    detail: null,
    error_code: null,
    ...overrides,
  };
}

function setRows(positionMs = 20_000): void {
  usePlayerStore.setState({
    videoId: 1,
    segments: [SEGMENT],
    annotations: [ANNOTATION],
    durationMs: 100_000,
    positionMs,
    activeSegmentId: SEGMENT.id,
    loading: false,
    error: null,
  });
}

function resetSummary(level = 0): void {
  useSummaryStore.setState({
    videoId: null,
    response: null,
    level,
    maxLevel: 0,
    loading: false,
    generating: false,
    error: null,
    errorCode: null,
    modelMissing: false,
    enabled: true,
    settingsLoaded: true,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  installMemoryStorage();
  window.localStorage.clear();
  useAnnotationsStore.getState().reset();
  usePlayerStore.setState({
    videoId: null,
    segments: [],
    annotations: [],
    durationMs: 0,
    positionMs: 0,
    activeSegmentId: null,
    loading: false,
    error: null,
  });
  resetSummary(0);
  useUIStore.setState({ settingsOpen: false });
  vi.mocked(api.annotations).mockImplementation(
    () => new Promise<AnnotationListResponse>(() => undefined),
  );
  vi.mocked(api.enqueue).mockResolvedValue({ queued: [1], skipped: [] });
  // По умолчанию загрузка саммари «висит» — тесты про саммари явно задают ответ,
  // а тестам уровня 0 не нужен фоновый setState после завершения теста.
  vi.mocked(api.summary).mockImplementation(
    () => new Promise<SummaryResponse>(() => undefined),
  );
  vi.mocked(api.generateSummary).mockResolvedValue({ video_id: 1, state: 'summarizing', level: 2 });
  vi.mocked(api.getSettings).mockResolvedValue({ 'summary.enabled': true });
});

describe('TimingPanel (M14 rev2)', () => {
  it('показывает сегменты и метки, активный сегмент подсвечен; шкала видна', () => {
    setRows();
    const { container } = render(<TimingPanel videoId={1} video={VIDEO} />);

    const segmentRow = container.querySelector<HTMLElement>('[data-segment-id="1"]');
    expect(segmentRow).not.toBeNull();
    expect(segmentRow?.classList.contains('is-active')).toBe(true);

    const annotationRow = container.querySelector<HTMLElement>('[data-annotation-id="7"]');
    expect(annotationRow).not.toBeNull();
    expect(annotationRow?.textContent).toContain('Важный момент');

    expect(screen.getByRole('slider')).toHaveAttribute('aria-valuenow', '0');
  });

  it('клик по строке сегмента перематывает плеер', () => {
    setRows();
    const { container } = render(<TimingPanel videoId={1} video={VIDEO} />);
    const segmentRow = container.querySelector<HTMLElement>('[data-segment-id="1"]');
    if (!segmentRow) throw new Error('segment row not found');

    fireEvent.click(segmentRow);
    expect(usePlayerStore.getState().positionMs).toBe(10_000);
  });

  it('для необработанного видео показывает «Обработать сейчас» и вызывает enqueue', async () => {
    usePlayerStore.setState({ videoId: 1, segments: [], annotations: [], durationMs: 0 });
    render(<TimingPanel videoId={1} video={{ ...VIDEO, status: 'pending', progress: 0 }} />);

    const button = screen.getByRole('button', { name: 'Обработать сейчас' });
    fireEvent.click(button);

    await waitFor(() => {
      expect(api.enqueue).toHaveBeenCalledWith([1]);
    });
  });

  it('шкала строится по фактической глубине дерева (max_level=2 → 3 позиции)', async () => {
    setRows();
    vi.mocked(api.summary).mockResolvedValue(summaryResponse());
    const { container } = render(<TimingPanel videoId={1} video={VIDEO} />);

    await waitFor(() => {
      expect(screen.getByRole('slider')).toHaveAttribute('aria-valuemax', '2');
    });
    expect(screen.getByRole('slider')).toHaveAttribute('data-max-level', '2');
    expect(container.querySelectorAll('[data-detent]')).toHaveLength(3);
  });

  it('клампит сохранённый уровень по глубине дерева при загрузке', async () => {
    setRows();
    resetSummary(4);
    vi.mocked(api.summary).mockResolvedValue(summaryResponse());
    render(<TimingPanel videoId={1} video={VIDEO} />);

    await waitFor(() => {
      expect(useSummaryStore.getState().level).toBe(2);
    });
    expect(screen.getByRole('slider')).toHaveAttribute('aria-valuenow', '2');
    expect(await screen.findByText('Корневое саммари видео')).toBeInTheDocument();
    const raw = window.localStorage.getItem('vl.ui.detailLevel');
    expect(raw ? (JSON.parse(raw) as { value: number }).value : null).toBe(2);
  });

  it('уровень 1 рендерит блоки дерева: title, таймкоды, термины, node_id', async () => {
    setRows();
    resetSummary(1);
    vi.mocked(api.summary).mockResolvedValue(summaryResponse());
    const { container } = render(<TimingPanel videoId={1} video={VIDEO} />);

    await waitFor(() => {
      expect(container.querySelectorAll('[data-summary-block]')).toHaveLength(2);
    });
    const blocks = container.querySelectorAll<HTMLElement>('[data-summary-block]');
    expect(blocks[0]).toHaveAttribute('data-node-id', '0.1');
    expect(blocks[0].textContent).toContain('Введение');
    expect(blocks[0].textContent).toContain('[00:00–00:30]');
    expect(blocks[0].textContent).toContain('Первый блок');
    expect(blocks[1]).toHaveAttribute('data-node-id', '0.2');
    expect(blocks[1].textContent).toContain('термин');
    // Сегменты уровня 0 в режиме саммари не рендерятся.
    expect(container.querySelector('[data-segment-id="1"]')).toBeNull();
    expect(screen.getByRole('slider')).toHaveAttribute('aria-valuenow', '1');
  });

  it('корневой уровень (max_level) показывает корневой блок с заголовком «Кратко о видео»', async () => {
    setRows();
    resetSummary(2);
    vi.mocked(api.summary).mockResolvedValue(summaryResponse());
    const { container } = render(<TimingPanel videoId={1} video={VIDEO} />);

    await waitFor(() => {
      expect(container.querySelectorAll('[data-summary-block]')).toHaveLength(1);
    });
    const root = container.querySelector<HTMLElement>('[data-summary-block]');
    expect(root?.textContent).toContain('Кратко о видео');
    expect(root?.textContent).toContain('Корневое саммари видео');
  });

  it('клик по блоку саммари перематывает плеер', async () => {
    setRows();
    resetSummary(1);
    vi.mocked(api.summary).mockResolvedValue(summaryResponse());
    const { container } = render(<TimingPanel videoId={1} video={VIDEO} />);

    await waitFor(() => {
      expect(container.querySelectorAll('[data-summary-block]')).toHaveLength(2);
    });
    const blocks = container.querySelectorAll<HTMLElement>('[data-summary-block]');
    fireEvent.click(blocks[1]);
    expect(usePlayerStore.getState().positionMs).toBe(40_000);
  });

  it('активный блок подсвечивается по позиции плеера', async () => {
    setRows(50_000);
    resetSummary(1);
    vi.mocked(api.summary).mockResolvedValue(summaryResponse());
    const { container } = render(<TimingPanel videoId={1} video={VIDEO} />);

    await waitFor(() => {
      expect(container.querySelectorAll('[data-summary-block]')).toHaveLength(2);
    });
    const active = container.querySelector('[data-summary-block].is-active');
    expect(active?.textContent).toContain('Второй блок');
  });

  it('при отсутствии саммари показывает CTA «Сгенерировать» и вызывает POST', async () => {
    setRows();
    resetSummary(1);
    vi.mocked(api.summary).mockResolvedValue(summaryResponse({ state: 'absent', max_level: 0, levels: {} }));
    render(<TimingPanel videoId={1} video={VIDEO} />);

    const button = await screen.findByRole('button', { name: 'Сгенерировать' });
    fireEvent.click(button);
    await waitFor(() => {
      // Дерева ещё нет (maxLevel=0) — просим сгенерировать саммари целиком.
      expect(api.generateSummary).toHaveBeenCalledWith(1, undefined, false);
    });
  });

  it('model_missing показывает «Скачать модель» и открывает настройки', async () => {
    setRows();
    resetSummary(1);
    vi.mocked(api.summary).mockResolvedValue(
      summaryResponse({
        state: 'error',
        error_code: 'model_missing',
        max_level: 0,
        detail: 'Модель не установлена',
        model: { id: 'summary-lfm2.5-350m', label: 'KoarAI', installed: false },
        levels: {},
      }),
    );
    render(<TimingPanel videoId={1} video={VIDEO} />);

    const button = await screen.findByRole('button', { name: 'Скачать модель' });
    expect(screen.getByText('Модель саммари не установлена')).toBeInTheDocument();
    fireEvent.click(button);
    expect(useUIStore.getState().settingsOpen).toBe(true);
  });

  it('stale предлагает перегенерировать принудительно', async () => {
    setRows();
    resetSummary(1);
    vi.mocked(api.summary).mockResolvedValue(
      summaryResponse({ state: 'stale', max_level: 0, levels: {} }),
    );
    render(<TimingPanel videoId={1} video={VIDEO} />);

    const button = await screen.findByRole('button', { name: 'Перегенерировать' });
    fireEvent.click(button);
    await waitFor(() => {
      expect(api.generateSummary).toHaveBeenCalledWith(1, undefined, true);
    });
  });

  it('во время outline показывает «Анализ всего текста…»', async () => {
    setRows();
    resetSummary(1);
    vi.mocked(api.summary).mockResolvedValue(
      summaryResponse({
        state: 'outlining',
        max_level: 0,
        levels: {},
        progress: { stage: 'outline', done: 0, total: 0, percent: 5 },
      }),
    );
    render(<TimingPanel videoId={1} video={VIDEO} />);

    expect(await screen.findByText('Анализ всего текста…')).toBeInTheDocument();
  });

  it('во время splitting/summarizing показывает прогресс по блокам', async () => {
    setRows();
    resetSummary(1);
    vi.mocked(api.summary).mockResolvedValue(
      summaryResponse({
        state: 'splitting',
        max_level: 0,
        levels: {},
        progress: { stage: 'splitting', done: 3, total: 7, percent: 42 },
      }),
    );
    const { unmount } = render(<TimingPanel videoId={1} video={VIDEO} />);
    expect(await screen.findByText('Разбиение на смысловые блоки: 3/7')).toBeInTheDocument();
    unmount();

    resetSummary(1);
    usePlayerStore.setState({
      videoId: 1,
      segments: [SEGMENT],
      annotations: [ANNOTATION],
      durationMs: 100_000,
      positionMs: 20_000,
      activeSegmentId: SEGMENT.id,
      loading: false,
      error: null,
    });
    vi.mocked(api.summary).mockResolvedValue(
      summaryResponse({
        state: 'summarizing',
        max_level: 0,
        levels: {},
        progress: { stage: 'summarizing', done: 2, total: 5, percent: 40 },
      }),
    );
    render(<TimingPanel videoId={1} video={VIDEO} />);
    expect(await screen.findByText('Подготовка саммари: 2/5')).toBeInTheDocument();
  });

  it('саммари отключено в настройках — показывает заглушку', async () => {
    setRows();
    resetSummary(1);
    useSummaryStore.setState({ enabled: false });
    render(<TimingPanel videoId={1} video={VIDEO} />);

    expect(await screen.findByText('Саммари отключено в настройках')).toBeInTheDocument();
  });

  it('в режиме саммари показывает метки между блоками (read-only)', async () => {
    setRows();
    resetSummary(1);
    vi.mocked(api.summary).mockResolvedValue(summaryResponse());
    const { container } = render(<TimingPanel videoId={1} video={VIDEO} />);

    await waitFor(() => {
      expect(container.querySelectorAll('[data-summary-block]')).toHaveLength(2);
    });
    expect(container.querySelector('[data-annotation-id="7"]')).not.toBeNull();
  });

  it('переключение шкалы Home на уровень 0 возвращает сегменты и персистит выбор', async () => {
    setRows();
    resetSummary(1);
    vi.mocked(api.summary).mockResolvedValue(summaryResponse());
    const { container } = render(<TimingPanel videoId={1} video={VIDEO} />);

    await waitFor(() => {
      expect(container.querySelectorAll('[data-summary-block]')).toHaveLength(2);
    });
    fireEvent.keyDown(screen.getByRole('slider'), { key: 'Home' });

    await waitFor(() => {
      expect(container.querySelector('[data-segment-id="1"]')).not.toBeNull();
    });
    expect(useSummaryStore.getState().level).toBe(0);
    const raw = window.localStorage.getItem('vl.ui.detailLevel');
    expect(raw ? (JSON.parse(raw) as { value: number }).value : null).toBe(0);
  });

  it('переключение шкалы End ведёт к корневому уровню дерева', async () => {
    setRows();
    vi.mocked(api.summary).mockResolvedValue(summaryResponse());
    render(<TimingPanel videoId={1} video={VIDEO} />);

    await waitFor(() => {
      expect(screen.getByRole('slider')).toHaveAttribute('aria-valuemax', '2');
    });
    fireEvent.keyDown(screen.getByRole('slider'), { key: 'End' });
    await waitFor(() => {
      expect(useSummaryStore.getState().level).toBe(2);
    });
    expect(await screen.findByText('Корневое саммари видео')).toBeInTheDocument();
  });

  it('шкала disabled, пока нет транскрипции', () => {
    usePlayerStore.setState({ videoId: 1, segments: [], annotations: [], durationMs: 0 });
    render(<TimingPanel videoId={1} video={{ ...VIDEO, status: 'processing', progress: 0.3 }} />);
    expect(screen.getByRole('slider')).toHaveAttribute('aria-disabled', 'true');
  });
});
