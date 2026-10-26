import { create } from 'zustand';

import { api } from '../api/client';
import type { Annotation, Segment } from '../api/types';
import { clampMs } from '../lib/timelineGeometry';
import { useExternalStore } from './externalStore';

/**
 * Состояние плеера и таймлайна текущего видео.
 *
 * Интеграция: `<VideoPlayer videoId={id} />` вызывает `load(videoId)`.
 * Таймлайн и панель таймингов читают `segments`, `annotations`, `positionMs`, `durationMs`.
 */

export interface PlayerState {
  videoId: number | null;
  segments: Segment[];
  annotations: Annotation[];
  positionMs: number;
  durationMs: number;
  playing: boolean;
  activeSegmentId: number | null;
  loading: boolean;
  error: string | null;

  load: (videoId: number, force?: boolean) => Promise<void>;
  reload: () => Promise<void>;
  reset: () => void;

  setVideoElement: (element: HTMLVideoElement | null) => void;
  getVideoElement: () => HTMLVideoElement | null;

  setPosition: (ms: number) => void;
  setDuration: (ms: number) => void;
  setPlaying: (playing: boolean) => void;
  seek: (ms: number) => void;
  step: (deltaMs: number) => void;
  play: () => void;
  pause: () => void;
  toggle: () => void;

  setAnnotations: (items: Annotation[]) => void;
  upsertAnnotation: (annotation: Annotation) => void;
  removeAnnotation: (id: number) => void;
}

/** Активный сегмент: последний начавшийся, внутри которого находится `ms`; иначе `null`. */
export function findActiveSegment(segments: readonly Segment[], ms: number): number | null {
  if (segments.length === 0 || !Number.isFinite(ms)) return null;
  let low = 0;
  let high = segments.length - 1;
  let candidate = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const segment = segments[middle];
    if (segment.start_ms <= ms) {
      candidate = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  if (candidate < 0) return null;
  const found = segments[candidate];
  return ms < found.end_ms ? found.id : null;
}

function sortSegments(segments: readonly Segment[]): Segment[] {
  return [...segments].sort((a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms || a.id - b.id);
}

function sortAnnotations(annotations: readonly Annotation[]): Annotation[] {
  return [...annotations].sort(
    (a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms || a.id - b.id,
  );
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

let videoElement: HTMLVideoElement | null = null;
let loadToken = 0;
let pendingSeek: { videoId: number; ms: number } | null = null;

function durationFromElement(): number {
  if (videoElement && Number.isFinite(videoElement.duration) && videoElement.duration > 0) {
    return Math.round(videoElement.duration * 1000);
  }
  return 0;
}

function effectiveDuration(): number {
  return Math.max(usePlayerStore.getState().durationMs, durationFromElement());
}

export const usePlayerStore = create<PlayerState>((set, get) => ({
  videoId: null,
  segments: [],
  annotations: [],
  positionMs: 0,
  durationMs: 0,
  playing: false,
  activeSegmentId: null,
  loading: false,
  error: null,

  load: async (videoId, force = false) => {
    const state = get();
    if (!force && state.videoId === videoId && !state.error) return;
    const token = ++loadToken;
    const isNewVideo = state.videoId !== videoId;
    set({
      videoId,
      loading: true,
      error: null,
      ...(isNewVideo
        ? {
            segments: [] as Segment[],
            annotations: [] as Annotation[],
            positionMs: 0,
            durationMs: durationFromElement(),
            activeSegmentId: null,
            playing: false,
          }
        : {}),
    });
    try {
      const response = await api.segments(videoId);
      if (token !== loadToken) return;
      const segments = sortSegments(response.segments);
      const annotations = sortAnnotations(response.annotations);
      const positionMs = get().positionMs;
      set({
        segments,
        annotations,
        loading: false,
        activeSegmentId: findActiveSegment(segments, positionMs),
      });
      if (pendingSeek && pendingSeek.videoId === videoId) {
        const target = pendingSeek.ms;
        pendingSeek = null;
        get().seek(target);
      }
    } catch (error) {
      if (token !== loadToken) return;
      set({ loading: false, error: errorMessage(error) });
    }
  },

  reload: async () => {
    const { videoId } = get();
    if (videoId === null) return;
    await get().load(videoId, true);
  },

  reset: () => {
    loadToken += 1;
    set({
      videoId: null,
      segments: [],
      annotations: [],
      positionMs: 0,
      durationMs: 0,
      playing: false,
      activeSegmentId: null,
      loading: false,
      error: null,
    });
  },

  setVideoElement: (element) => {
    videoElement = element;
    if (element) {
      const durationMs = durationFromElement();
      if (durationMs > 0) set({ durationMs });
    }
  },
  getVideoElement: () => videoElement,

  setPosition: (ms) => {
    const duration = effectiveDuration();
    const positionMs = clampMs(ms, duration);
    set((state) => {
      const activeSegmentId = findActiveSegment(state.segments, positionMs);
      if (state.positionMs === positionMs && state.activeSegmentId === activeSegmentId) return state;
      return { positionMs, activeSegmentId };
    });
  },

  setDuration: (ms) => {
    const durationMs = Math.max(0, Math.round(ms));
    set((state) => {
      const positionMs = durationMs > 0 ? Math.min(state.positionMs, durationMs) : state.positionMs;
      return {
        durationMs,
        positionMs,
        activeSegmentId: findActiveSegment(state.segments, positionMs),
      };
    });
  },

  setPlaying: (playing) => set({ playing }),

  seek: (ms) => {
    const duration = effectiveDuration();
    const target = clampMs(ms, duration > 0 ? duration : Math.max(0, ms));
    if (useExternalStore.getState().isActiveFor(get().videoId)) {
      void useExternalStore.getState().seek(target);
      set((state) => ({
        positionMs: target,
        activeSegmentId: findActiveSegment(state.segments, target),
      }));
      return;
    }
    if (videoElement) {
      try {
        videoElement.currentTime = target / 1000;
      } catch {
        /* элемент ещё не готов к перемотке — позицию всё равно обновим */
      }
    }
    set((state) => ({
      positionMs: target,
      activeSegmentId: findActiveSegment(state.segments, target),
    }));
  },

  step: (deltaMs) => {
    get().seek(get().positionMs + deltaMs);
  },

  play: () => {
    if (useExternalStore.getState().isActiveFor(get().videoId)) {
      void useExternalStore.getState().command('play');
      set({ playing: true });
      return;
    }
    const element = videoElement;
    if (!element) {
      set({ playing: true });
      return;
    }
    set({ playing: true });
    const result = element.play();
    if (result && typeof result.catch === 'function') {
      void result.catch(() => set({ playing: false }));
    }
  },

  pause: () => {
    if (useExternalStore.getState().isActiveFor(get().videoId)) {
      void useExternalStore.getState().command('pause');
      set({ playing: false });
      return;
    }
    videoElement?.pause();
    set({ playing: false });
  },

  toggle: () => {
    if (get().playing) get().pause();
    else get().play();
  },

  setAnnotations: (items) => {
    set({ annotations: sortAnnotations(items) });
  },

  upsertAnnotation: (annotation) => {
    set((state) => {
      const exists = state.annotations.some((item) => item.id === annotation.id);
      const annotations = exists
        ? state.annotations.map((item) => (item.id === annotation.id ? annotation : item))
        : [...state.annotations, annotation];
      return { annotations: sortAnnotations(annotations) };
    });
  },

  removeAnnotation: (id) => {
    set((state) => {
      if (!state.annotations.some((item) => item.id === id)) return state;
      return { annotations: state.annotations.filter((item) => item.id !== id) };
    });
  },
}));

/**
 * Интеграция с поиском M4/M7: событие `vl:seek` (detail: `{videoId, ms}`)
 * перематывает текущее видео. Если `videoId` не совпадает с открытым — событие игнорируется.
 */
if (typeof window !== 'undefined') {
  window.addEventListener('vl:seek', (event) => {
    const detail = (event as CustomEvent<{ videoId?: number; ms?: number }>).detail;
    if (!detail || typeof detail.ms !== 'number') return;
    const state = usePlayerStore.getState();
    if (detail.videoId !== undefined && detail.videoId !== null) {
      if (state.videoId === null || state.videoId !== detail.videoId) {
        // Видео ещё не загружено — применим перемотку после load(videoId).
        pendingSeek = { videoId: detail.videoId, ms: detail.ms };
        return;
      }
    }
    state.seek(detail.ms);
  });
}
