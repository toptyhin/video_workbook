import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../api/client', () => ({
  api: {
    annotations: vi.fn(),
    enqueue: vi.fn(),
    reprocess: vi.fn(),
    segments: vi.fn(),
  },
  mediaUrl: (videoId: number, kind: string) => `/api/videos/${videoId}/${kind}`,
}));

import { api } from '../../api/client';
import type { Annotation, AnnotationListResponse, Segment, Video } from '../../api/types';
import { useAnnotationsStore } from '../../state/annotationsStore';
import { usePlayerStore } from '../../state/playerStore';
import { TimingPanel } from './TimingPanel';

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

function setRows(): void {
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
}

beforeEach(() => {
  vi.clearAllMocks();
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
  vi.mocked(api.annotations).mockImplementation(
    () => new Promise<AnnotationListResponse>(() => undefined),
  );
  vi.mocked(api.enqueue).mockResolvedValue({ queued: [1], skipped: [] });
});

describe('TimingPanel', () => {
  it('показывает сегменты и метки, активный сегмент подсвечен', () => {
    setRows();
    const { container } = render(<TimingPanel videoId={1} video={VIDEO} />);

    const segmentRow = container.querySelector<HTMLElement>('[data-segment-id="1"]');
    expect(segmentRow).not.toBeNull();
    expect(segmentRow?.classList.contains('is-active')).toBe(true);

    const annotationRow = container.querySelector<HTMLElement>('[data-annotation-id="7"]');
    expect(annotationRow).not.toBeNull();
    expect(annotationRow?.textContent).toContain('Важный момент');
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
});
