import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, RefObject } from 'react';

import type { Annotation, Segment } from '../api/types';
import { MIN_ANNOTATION_MS } from '../lib/constants';
import { clampMs, pxToMs, snapMs, type TimeRange } from '../lib/timelineGeometry';

/**
 * Перетаскивание по таймлайну.
 *
 * `mode: 'scrub'` — скраббинг дорожки сегментов: seek через requestAnimationFrame
 * (не больше одного seek на кадр), на отпускании — финальный seek.
 *
 * `mode: 'create'` — создание метки перетаскиванием по дорожке меток:
 * порог 4 px (меньше — клик/seek), превью-диапазон, snap к 1 с и границам сегментов,
 * `Alt` отключает привязку. Коммит — на pointerup, если диапазон ≥ `MIN_ANNOTATION_MS`.
 */

const THRESHOLD_PX = 4;

export type TimelinePointerMode = 'scrub' | 'create';

export interface UseTimelineDragOptions {
  mode: TimelinePointerMode;
  durationMs: number;
  segments?: readonly Segment[];
  snapEnabled?: boolean;
  onSeek: (ms: number) => void;
  onCreateRange?: (range: TimeRange) => void;
}

export interface UseTimelineDragResult {
  dragging: boolean;
  creating: boolean;
  preview: TimeRange | null;
  snapLineMs: number | null;
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
}

export function useTimelineDrag(options: UseTimelineDragOptions): UseTimelineDragResult {
  const { mode, durationMs, segments = [], snapEnabled = true, onSeek, onCreateRange } = options;
  const [dragging, setDragging] = useState(false);
  const [preview, setPreview] = useState<TimeRange | null>(null);
  const [snapLineMs, setSnapLineMs] = useState<number | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(
    () => () => {
      cleanupRef.current?.();
      cleanupRef.current = null;
    },
    [],
  );

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      const track = event.currentTarget;
      const rect = track.getBoundingClientRect();
      if (!Number.isFinite(rect.width) || rect.width <= 0 || durationMs <= 0) return;
      event.preventDefault();
      track.focus({ preventScroll: true });
      try {
        track.setPointerCapture(event.pointerId);
      } catch {
        /* jsdom/старые браузеры — работаем через window-слушатели */
      }
      cleanupRef.current?.();

      const startX = event.clientX;
      const positionToMs = (clientX: number): number =>
        pxToMs(clientX - rect.left, durationMs, rect.width);
      const startMs = clampMs(positionToMs(startX), durationMs);

      let moved = false;
      let altPressed = event.altKey;
      let previewRange: TimeRange | null = null;
      let currentSnap: number | null = null;
      let pendingClientX = startX;
      let rafId = 0;

      onSeek(startMs);
      setDragging(true);

      const flush = (): void => {
        rafId = 0;
        if (!moved) return;
        const raw = positionToMs(pendingClientX);
        if (mode === 'scrub') {
          onSeek(clampMs(raw, durationMs));
          return;
        }
        const snapStartRaw = clampMs(positionToMs(startX), durationMs);
        const snapEnd = snapEnabled && !altPressed
          ? snapMs(raw, { durationMs, width: rect.width, segments })
          : clampMs(raw, durationMs);
        const snapStart = snapEnabled && !altPressed
          ? snapMs(snapStartRaw, { durationMs, width: rect.width, segments })
          : snapStartRaw;
        const start = Math.min(snapStart, snapEnd);
        const end = Math.max(snapStart, snapEnd);
        previewRange = { start_ms: start, end_ms: end };
        currentSnap = snapEnd !== raw ? snapEnd : snapStart !== snapStartRaw ? snapStart : null;
        setPreview(previewRange);
        setSnapLineMs(currentSnap);
      };

      const onMove = (moveEvent: PointerEvent): void => {
        if (Math.abs(moveEvent.clientX - startX) >= THRESHOLD_PX) moved = true;
        altPressed = moveEvent.altKey;
        pendingClientX = moveEvent.clientX;
        if (rafId === 0) {
          if (typeof requestAnimationFrame === 'function') rafId = requestAnimationFrame(flush);
          else flush();
        }
      };

      const cleanup = (): void => {
        if (rafId !== 0 && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafId);
        try {
          track.releasePointerCapture(event.pointerId);
        } catch {
          /* ignore */
        }
        rafId = 0;
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onCancel);
        window.removeEventListener('keydown', onKeyDown);
        cleanupRef.current = null;
      };

      const onKeyDown = (keyEvent: KeyboardEvent): void => {
        if (keyEvent.key !== 'Escape') return;
        keyEvent.preventDefault();
        cleanup();
        setPreview(null);
        setSnapLineMs(null);
        setDragging(false);
      };

      const onUp = (): void => {
        cleanup();
        setDragging(false);
        if (mode === 'scrub') {
          onSeek(clampMs(positionToMs(pendingClientX), durationMs));
          return;
        }
        if (moved && previewRange && previewRange.end_ms - previewRange.start_ms >= MIN_ANNOTATION_MS) {
          onCreateRange?.(previewRange);
        } else {
          onSeek(clampMs(positionToMs(pendingClientX), durationMs));
        }
        setPreview(null);
        setSnapLineMs(null);
      };

      const onCancel = (): void => {
        cleanup();
        setPreview(null);
        setSnapLineMs(null);
        setDragging(false);
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onCancel);
      window.addEventListener('keydown', onKeyDown);
      cleanupRef.current = cleanup;
    },
    [mode, durationMs, segments, snapEnabled, onSeek, onCreateRange],
  );

  return {
    dragging,
    creating: preview !== null,
    preview,
    snapLineMs,
    onPointerDown,
  };
}

/** Ресайз границ существующей метки ручками (зона 8 px, сохранение на pointerup). */
export interface UseMarkerResizeOptions {
  durationMs: number;
  segments?: readonly Segment[];
  snapEnabled?: boolean;
  trackRef: RefObject<HTMLDivElement>;
  onCommit: (annotationId: number, range: TimeRange) => void;
}

export interface UseMarkerResizeResult {
  resizingId: number | null;
  preview: TimeRange | null;
  onPointerDown: (
    event: ReactPointerEvent<HTMLElement>,
    annotation: Annotation,
    edge: 'start' | 'end',
  ) => void;
}

export function useMarkerResize(options: UseMarkerResizeOptions): UseMarkerResizeResult {
  const { durationMs, segments = [], snapEnabled = true, trackRef, onCommit } = options;
  const [resizingId, setResizingId] = useState<number | null>(null);
  const [preview, setPreview] = useState<TimeRange | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(
    () => () => {
      cleanupRef.current?.();
      cleanupRef.current = null;
    },
    [],
  );

  const onPointerDown = useCallback(
    (
      event: ReactPointerEvent<HTMLElement>,
      annotation: Annotation,
      edge: 'start' | 'end',
    ) => {
      if (event.button !== 0) return;
      const track = trackRef.current;
      if (!track) return;
      const rect = track.getBoundingClientRect();
      if (!Number.isFinite(rect.width) || rect.width <= 0 || durationMs <= 0) return;
      event.preventDefault();
      event.stopPropagation();
      cleanupRef.current?.();

      const positionToMs = (clientX: number): number => pxToMs(clientX - rect.left, durationMs, rect.width);
      const initial: TimeRange = { start_ms: annotation.start_ms, end_ms: annotation.end_ms };
      let current: TimeRange = initial;
      let altPressed = event.altKey;

      const apply = (clientX: number): void => {
        const raw = clampMs(positionToMs(clientX), durationMs);
        const snapped = snapEnabled && !altPressed
          ? snapMs(raw, { durationMs, width: rect.width, segments })
          : raw;
        if (edge === 'start') {
          const start = Math.min(snapped, initial.end_ms - MIN_ANNOTATION_MS);
          current = { start_ms: Math.max(0, start), end_ms: initial.end_ms };
        } else {
          const end = Math.max(snapped, initial.start_ms + MIN_ANNOTATION_MS);
          current = { start_ms: initial.start_ms, end_ms: Math.min(durationMs, end) };
        }
        setPreview(current);
      };

      const onMove = (moveEvent: PointerEvent): void => {
        altPressed = moveEvent.altKey;
        apply(moveEvent.clientX);
      };

      const cleanup = (): void => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onCancel);
        window.removeEventListener('keydown', onKeyDown);
        cleanupRef.current = null;
      };

      const onKeyDown = (keyEvent: KeyboardEvent): void => {
        if (keyEvent.key !== 'Escape') return;
        keyEvent.preventDefault();
        cleanup();
        setPreview(null);
        setResizingId(null);
      };

      const onUp = (): void => {
        cleanup();
        setResizingId(null);
        setPreview(null);
        if (
          current.start_ms !== initial.start_ms ||
          current.end_ms !== initial.end_ms
        ) {
          onCommit(annotation.id, current);
        }
      };

      const onCancel = (): void => {
        cleanup();
        setResizingId(null);
        setPreview(null);
      };

      setResizingId(annotation.id);
      setPreview(initial);
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onCancel);
      window.addEventListener('keydown', onKeyDown);
      cleanupRef.current = cleanup;
    },
    [durationMs, segments, snapEnabled, trackRef, onCommit],
  );

  return { resizingId, preview, onPointerDown };
}
