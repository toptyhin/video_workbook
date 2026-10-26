import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Annotation, Segment } from '../../api/types';
import { useAnnotationsStore } from '../../state/annotationsStore';
import { usePlayerStore } from '../../state/playerStore';
import { Timeline } from './Timeline';

const DURATION = 100_000;

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
  start_ms: 30_000,
  end_ms: 60_000,
  label: 'Важное',
  color: '#22c55e',
  note: null,
  tag_ids: [],
  created_at: '2026-01-01T00:00:00Z',
  updated_at: null,
};

beforeEach(() => {
  useAnnotationsStore.getState().reset();
  usePlayerStore.setState({
    videoId: 1,
    segments: [SEGMENT],
    annotations: [ANNOTATION],
    durationMs: DURATION,
    positionMs: 25_000,
    activeSegmentId: SEGMENT.id,
    loading: false,
    error: null,
  });
});

afterEach(() => cleanup());

describe('Timeline', () => {
  it('раскладывает блоки сегментов и маркеры по процентам дорожки', () => {
    const { container } = render(<Timeline videoId={1} durationMs={DURATION} />);

    const segment = container.querySelector<HTMLElement>('[data-segment-id="1"]');
    expect(segment).not.toBeNull();
    expect(segment?.style.left).toBe('10%');
    expect(segment?.style.width).toBe('30%');

    const marker = container.querySelector<HTMLElement>('[data-annotation-id="7"]');
    expect(marker).not.toBeNull();
    expect(marker?.style.left).toBe('30%');
    expect(marker?.style.width).toBe('30%');
    expect(marker?.style.backgroundColor).toBe('rgb(34, 197, 94)');
    expect(marker?.getAttribute('role')).toBe('button');
    expect(marker?.getAttribute('aria-label')).toContain('Важное');
  });

  it('клик по маркеру перематывает на его начало и выделяет метку', () => {
    const { container } = render(<Timeline videoId={1} durationMs={DURATION} />);

    const marker = container.querySelector<HTMLElement>('[data-annotation-id="7"]');
    if (!marker) throw new Error('marker not found');
    fireEvent.click(marker);

    expect(usePlayerStore.getState().positionMs).toBe(30_000);
    expect(useAnnotationsStore.getState().selectedId).toBe(7);
  });

  it('дорожка сегментов имеет роль slider и управляется клавиатурой', () => {
    render(<Timeline videoId={1} durationMs={DURATION} />);

    const slider = screen.getByRole('slider');
    expect(slider.getAttribute('aria-valuenow')).toBe('25000');
    expect(slider.getAttribute('aria-valuemax')).toBe(String(DURATION));

    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    expect(usePlayerStore.getState().positionMs).toBe(30_000);
    expect(screen.getByRole('slider').getAttribute('aria-valuenow')).toBe('30000');

    fireEvent.keyDown(screen.getByRole('slider'), { key: 'End' });
    expect(usePlayerStore.getState().positionMs).toBe(DURATION);
  });
});
