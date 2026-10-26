import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';

import type { Annotation } from '../../api/types';
import { useMarkerResize, useTimelineDrag } from '../../hooks/useTimelineDrag';
import { ANNOTATION_COLORS } from '../../lib/constants';
import { t } from '../../lib/i18n';
import { formatTimecode, formatTimecodeWithMs } from '../../lib/time';
import {
  clampMs,
  rangeToPercent,
  type TimeRange,
} from '../../lib/timelineGeometry';
import { useAnnotationsStore } from '../../state/annotationsStore';
import { usePlayerStore } from '../../state/playerStore';
import { AnnotationMarker } from './AnnotationMarker';
import './Timeline.css';

export interface TimelineProps {
  videoId: number;
  /** Длительность из списка видео — запасной вариант, пока плеер не отдал метаданные. */
  durationMs?: number;
  className?: string;
}

interface MenuState {
  annotation: Annotation;
  x: number;
  y: number;
}

const TICKS = [0, 0.25, 0.5, 0.75, 1];

function trimText(text: string, limit: number): string {
  const normalized = text.trim();
  return normalized.length > limit ? `${normalized.slice(0, limit)}…` : normalized;
}

export function Timeline({ videoId, durationMs, className }: TimelineProps): JSX.Element {
  const segments = usePlayerStore((state) => state.segments);
  const annotations = usePlayerStore((state) => state.annotations);
  const storeDuration = usePlayerStore((state) => state.durationMs);
  const positionMs = usePlayerStore((state) => state.positionMs);
  const seek = usePlayerStore((state) => state.seek);
  const selectedId = useAnnotationsStore((state) => state.selectedId);
  const select = useAnnotationsStore((state) => state.select);

  const lanesRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);

  const duration = useMemo(() => {
    if (storeDuration > 0) return storeDuration;
    if ((durationMs ?? 0) > 0) return durationMs ?? 0;
    return segments.reduce((max, segment) => Math.max(max, segment.end_ms), 0);
  }, [durationMs, segments, storeDuration]);

  const handleSeekMs = useCallback(
    (ms: number) => {
      seek(ms);
    },
    [seek],
  );

  const handleCreateRange = useCallback((range: TimeRange) => {
    void useAnnotationsStore.getState().createFromRange(range);
  }, []);

  const handleResizeCommit = useCallback((id: number, range: TimeRange) => {
    void useAnnotationsStore.getState().update(id, {
      start_ms: range.start_ms,
      end_ms: range.end_ms,
    });
  }, []);

  const scrub = useTimelineDrag({
    mode: 'scrub',
    durationMs: duration,
    onSeek: handleSeekMs,
  });
  const createDrag = useTimelineDrag({
    mode: 'create',
    durationMs: duration,
    segments,
    onSeek: handleSeekMs,
    onCreateRange: handleCreateRange,
  });
  const resize = useMarkerResize({
    durationMs: duration,
    segments,
    trackRef: lanesRef,
    onCommit: handleResizeCommit,
  });

  const handleMarkerSeek = useCallback(
    (annotation: Annotation) => {
      select(annotation.id);
      seek(annotation.start_ms);
    },
    [seek, select],
  );

  const handleMarkerEdit = useCallback((annotation: Annotation) => {
    useAnnotationsStore.getState().openEditEditor(annotation);
  }, []);

  const handleMarkerDelete = useCallback((annotation: Annotation) => {
    void useAnnotationsStore.getState().remove(annotation.id);
  }, []);

  const handleContextMenu = useCallback((annotation: Annotation, x: number, y: number) => {
    setMenu({
      annotation,
      x: Math.min(x, Math.max(0, window.innerWidth - 230)),
      y: Math.min(y, Math.max(0, window.innerHeight - 230)),
    });
  }, []);

  useEffect(() => {
    if (!menu) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (menuRef.current?.contains(event.target as Node)) return;
      setMenu(null);
    };
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') setMenu(null);
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [menu]);

  const closeMenu = useCallback(() => setMenu(null), []);

  const handleTrackKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const current = usePlayerStore.getState().positionMs;
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      event.stopPropagation();
      seek(current - 5000);
      return;
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      event.stopPropagation();
      seek(current + 5000);
      return;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      event.stopPropagation();
      seek(0);
      return;
    }
    if (event.key === 'End') {
      event.preventDefault();
      event.stopPropagation();
      seek(duration);
    }
  };

  const createPreviewStyle = createDrag.preview
    ? rangeToPercent(createDrag.preview.start_ms, createDrag.preview.end_ms, duration)
    : null;

  if (duration <= 0) {
    return (
      <div className={`vl-timeline vl-timeline--empty${className ? ` ${className}` : ''}`} data-video-id={videoId}>
        <span className="vl-timeline__empty-text">{t('timings.loading')}</span>
      </div>
    );
  }

  return (
    <div className={`vl-timeline${className ? ` ${className}` : ''}`} data-video-id={videoId}>
      <div className="vl-timeline__ruler" aria-hidden="true">
        {TICKS.map((fraction) => (
          <span
            key={fraction}
            className="vl-timeline__tick"
            style={{ left: `${fraction * 100}%` }}
          >
            {formatTimecode(duration * fraction)}
          </span>
        ))}
      </div>
      <div className="vl-timeline__lanes" ref={lanesRef}>
        <div
          className={`vl-timeline__lane vl-timeline__lane--segments${scrub.dragging ? ' is-dragging' : ''}`}
          role="slider"
          tabIndex={0}
          aria-label={t('timings.title')}
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={Math.round(positionMs)}
          aria-valuetext={`${formatTimecodeWithMs(positionMs)} / ${formatTimecodeWithMs(duration)}`}
          onPointerDown={scrub.onPointerDown}
          onKeyDown={handleTrackKeyDown}
        >
          {segments.map((segment) => {
            const { left, width } = rangeToPercent(segment.start_ms, segment.end_ms, duration);
            return (
              <div
                key={segment.id}
                className="vl-timeline__segment"
                style={{ left: `${left}%`, width: `${width}%` }}
                title={trimText(segment.text, 120)}
                data-segment-id={segment.id}
              />
            );
          })}
        </div>
        <div
          className={`vl-timeline__lane vl-timeline__lane--annotations${createDrag.creating ? ' is-creating' : ''}`}
          role="group"
          aria-label={t('annotations.list')}
          onPointerDown={createDrag.onPointerDown}
        >
          {annotations.map((annotation) => {
            const preview = resize.resizingId === annotation.id ? resize.preview : null;
            return (
              <AnnotationMarker
                key={annotation.id}
                annotation={annotation}
                durationMs={duration}
                selected={annotation.id === selectedId}
                previewRange={preview}
                onSeek={handleMarkerSeek}
                onEdit={handleMarkerEdit}
                onDelete={handleMarkerDelete}
                onContextMenu={handleContextMenu}
                onResizeStart={resize.onPointerDown}
              />
            );
          })}
          {createDrag.preview && createPreviewStyle && (
            <div
              className="vl-timeline__preview"
              style={{ left: `${createPreviewStyle.left}%`, width: `${createPreviewStyle.width}%` }}
              aria-hidden="true"
            >
              <span className="vl-timeline__preview-label">
                {formatTimecodeWithMs(createDrag.preview.start_ms)} — {formatTimecodeWithMs(createDrag.preview.end_ms)}
              </span>
            </div>
          )}
          {createDrag.snapLineMs !== null && (
            <div
              className="vl-timeline__snap"
              style={{ left: `${rangeToPercent(createDrag.snapLineMs, createDrag.snapLineMs, duration).left}%` }}
              aria-hidden="true"
            />
          )}
        </div>
        <div
          className="vl-timeline__playhead"
          style={{ left: `${(clampMs(positionMs, duration) / duration) * 100}%` }}
          aria-hidden="true"
        />
      </div>

      {menu && (
        <div
          className="vl-timeline__menu"
          style={{ left: `${menu.x}px`, top: `${menu.y}px` }}
          role="menu"
          aria-label={menu.annotation.label}
          ref={menuRef}
          onContextMenu={(event) => event.preventDefault()}
        >
          <button
            type="button"
            role="menuitem"
            className="vl-timeline__menu-item"
            onClick={() => {
              useAnnotationsStore.getState().openEditEditor(menu.annotation);
              closeMenu();
            }}
          >
            {t('annotations.editorTitleEdit')}
          </button>
          <div className="vl-timeline__menu-colors" role="group" aria-label={t('annotations.color')}>
            {ANNOTATION_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                className={`vl-timeline__menu-color${menu.annotation.color === color ? ' is-active' : ''}`}
                style={{ backgroundColor: color }}
                aria-label={color}
                aria-pressed={menu.annotation.color === color}
                onClick={() => {
                  void useAnnotationsStore.getState().update(menu.annotation.id, { color });
                  closeMenu();
                }}
              />
            ))}
          </div>
          <button
            type="button"
            role="menuitem"
            className="vl-timeline__menu-item"
            onClick={() => {
              void navigator.clipboard?.writeText(formatTimecodeWithMs(menu.annotation.start_ms));
              closeMenu();
            }}
          >
            {t('annotations.copyTimecode')}
          </button>
          <button
            type="button"
            role="menuitem"
            className="vl-timeline__menu-item vl-timeline__menu-item--danger"
            onClick={() => {
              void useAnnotationsStore.getState().remove(menu.annotation.id);
              closeMenu();
            }}
          >
            {t('common.delete')}
          </button>
        </div>
      )}
    </div>
  );
}
