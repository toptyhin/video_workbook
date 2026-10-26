import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';

import { api } from '../../api/client';
import type { Annotation, Segment } from '../../api/types';
import { useResizable } from '../../hooks/useResizable';
import { useUndoStack } from '../../hooks/useUndoStack';
import { MIN_ANNOTATION_MS } from '../../lib/constants';
import { t } from '../../lib/i18n';
import { useAnnotationsStore, type AnnotationRange } from '../../state/annotationsStore';
import { useExternalStore } from '../../state/externalStore';
import { usePlayerStore } from '../../state/playerStore';
import { pushError, useUIStore } from '../../state/uiStore';
import { AnnotationRow } from './AnnotationRow';
import { SegmentRow } from './SegmentRow';
import type { RowModifiers } from './SegmentRow';
import type { PlayerVideoInfo } from './VideoPlayer';
import './TimingPanel.css';

export interface TimingPanelProps {
  videoId: number | null;
  /** Статус обработки видео из списка (для состояний «не готова»/«Обработать сейчас»). */
  video?: PlayerVideoInfo | null;
  className?: string;
}

interface TimingRow {
  key: string;
  startMs: number;
  endMs: number;
  segment?: Segment;
  annotation?: Annotation;
}

const MIN_WIDTH = 280;
const MAX_WIDTH = 560;
const COLLAPSED_WIDTH = 32;
const MANUAL_SCROLL_PAUSE_MS = 5000;
const SKELETON_ROWS = 5;

function rowKey(kind: 'segment' | 'annotation', id: number): string {
  return `${kind}:${id}`;
}

function buildRows(segments: readonly Segment[], annotations: readonly Annotation[], showAnnotations: boolean): TimingRow[] {
  const rows: TimingRow[] = segments.map((segment) => ({
    key: rowKey('segment', segment.id),
    startMs: segment.start_ms,
    endMs: segment.end_ms,
    segment,
  }));
  if (showAnnotations) {
    for (const annotation of annotations) {
      rows.push({
        key: rowKey('annotation', annotation.id),
        startMs: annotation.start_ms,
        endMs: annotation.end_ms,
        annotation,
      });
    }
  }
  return rows.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs || a.key.localeCompare(b.key));
}

/** Непрерывные группы выделенных строк → диапазоны для bulk-создания меток. */
function selectionToRanges(rows: readonly TimingRow[], selected: readonly string[]): AnnotationRange[] {
  const selectedSet = new Set(selected);
  const ranges: AnnotationRange[] = [];
  let current: AnnotationRange | null = null;
  const flush = (): void => {
    if (current && current.end_ms - current.start_ms >= MIN_ANNOTATION_MS) ranges.push(current);
    current = null;
  };
  for (const row of rows) {
    if (!selectedSet.has(row.key)) {
      flush();
      continue;
    }
    if (current && row.startMs <= current.end_ms + 1) {
      current.start_ms = Math.min(current.start_ms, row.startMs);
      current.end_ms = Math.max(current.end_ms, row.endMs);
      continue;
    }
    flush();
    current = { start_ms: row.startMs, end_ms: row.endMs };
  }
  flush();
  return ranges;
}

export function TimingPanel({ videoId, video = null, className }: TimingPanelProps): JSX.Element {
  const segments = usePlayerStore((state) => state.segments);
  const annotations = usePlayerStore((state) => state.annotations);
  const activeSegmentId = usePlayerStore((state) => state.activeSegmentId);
  const playerLoading = usePlayerStore((state) => state.loading);
  const playerError = usePlayerStore((state) => state.error);
  const seek = usePlayerStore((state) => state.seek);
  const activeAnnotationId = usePlayerStore((state) => {
    if (state.annotations.length === 0) return null;
    for (const annotation of state.annotations) {
      if (state.positionMs >= annotation.start_ms && state.positionMs < annotation.end_ms) {
        return annotation.id;
      }
    }
    return null;
  });
  const selectedId = useAnnotationsStore((state) => state.selectedId);

  const collapsed = useUIStore((state) => state.timingsCollapsed);
  const timingsWidth = useUIStore((state) => state.timingsWidth);
  const toggleTimings = useUIStore((state) => state.toggleTimings);
  const setTimingsWidth = useUIStore((state) => state.setTimingsWidth);

  const undoStack = useUndoStack();
  const [showAnnotations, setShowAnnotations] = useState(true);
  const [follow, setFollow] = useState(true);
  const [selectedRows, setSelectedRows] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const bodyRef = useRef<HTMLDivElement>(null);
  const programmaticScrollRef = useRef(false);
  const scrollTimerRef = useRef<number | null>(null);
  const scrollPauseTimerRef = useRef<number | null>(null);
  const anchorIndexRef = useRef<number | null>(null);

  const resizer = useResizable({
    initialSize: timingsWidth,
    min: MIN_WIDTH,
    max: MAX_WIDTH,
    invert: true,
    onChange: setTimingsWidth,
    onCommit: setTimingsWidth,
  });

  const rows = useMemo(
    () => buildRows(segments, annotations, showAnnotations),
    [annotations, segments, showAnnotations],
  );
  const ranges = useMemo(() => selectionToRanges(rows, selectedRows), [rows, selectedRows]);

  useEffect(() => {
    if (videoId === null) return;
    void useAnnotationsStore.getState().load(videoId);
  }, [videoId, reloadKey]);

  useEffect(() => {
    useAnnotationsStore.getState().setTimingSelection(ranges);
  }, [ranges]);

  useEffect(
    () => () => {
      if (scrollTimerRef.current !== null) window.clearTimeout(scrollTimerRef.current);
      if (scrollPauseTimerRef.current !== null) window.clearTimeout(scrollPauseTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    if (!follow || collapsed) return;
    const container = bodyRef.current;
    if (!container) return;
    const active = container.querySelector('.is-active');
    if (!active) return;
    const element = active as HTMLElement;
    if (typeof element.scrollIntoView !== 'function') return;
    programmaticScrollRef.current = true;
    element.scrollIntoView({ block: 'nearest' });
    if (scrollTimerRef.current !== null) window.clearTimeout(scrollTimerRef.current);
    scrollTimerRef.current = window.setTimeout(() => {
      programmaticScrollRef.current = false;
      scrollTimerRef.current = null;
    }, 150);
  }, [activeAnnotationId, activeSegmentId, collapsed, follow, showAnnotations]);

  const pauseFollow = useCallback(() => {
    setFollow(false);
    if (scrollPauseTimerRef.current !== null) window.clearTimeout(scrollPauseTimerRef.current);
    scrollPauseTimerRef.current = window.setTimeout(() => {
      setFollow(true);
      scrollPauseTimerRef.current = null;
    }, MANUAL_SCROLL_PAUSE_MS);
  }, []);

  const handleScroll = useCallback(() => {
    if (programmaticScrollRef.current) return;
    pauseFollow();
  }, [pauseFollow]);

  const handleActivateSegment = useCallback(
    (segment: Segment) => {
      setSelectedRows([]);
      anchorIndexRef.current = null;
      seek(segment.start_ms);
    },
    [seek],
  );

  const handleActivateAnnotation = useCallback(
    (annotation: Annotation) => {
      setSelectedRows([]);
      anchorIndexRef.current = null;
      useAnnotationsStore.getState().select(annotation.id);
      seek(annotation.start_ms);
    },
    [seek],
  );

  const handleEditAnnotation = useCallback((annotation: Annotation) => {
    useAnnotationsStore.getState().openEditEditor(annotation);
  }, []);

  const handleDeleteAnnotation = useCallback((annotation: Annotation) => {
    void useAnnotationsStore.getState().remove(annotation.id);
  }, []);

  const handleToggleSelect = useCallback(
    (key: string, modifiers: RowModifiers) => {
      const index = rows.findIndex((row) => row.key === key);
      if (index < 0) return;
      setSelectedRows((previous) => {
        if (modifiers.shift && anchorIndexRef.current !== null) {
          const from = Math.min(anchorIndexRef.current, index);
          const to = Math.max(anchorIndexRef.current, index);
          const rangeKeys = rows.slice(from, to + 1).map((row) => row.key);
          return Array.from(new Set([...previous, ...rangeKeys]));
        }
        anchorIndexRef.current = index;
        if (modifiers.ctrl) {
          return previous.includes(key)
            ? previous.filter((item) => item !== key)
            : [...previous, key];
        }
        return previous.includes(key) ? previous.filter((item) => item !== key) : [...previous, key];
      });
    },
    [rows],
  );

  const handleSegmentToggle = useCallback(
    (segment: Segment, modifiers: RowModifiers) => handleToggleSelect(rowKey('segment', segment.id), modifiers),
    [handleToggleSelect],
  );
  const handleAnnotationToggle = useCallback(
    (annotation: Annotation, modifiers: RowModifiers) => handleToggleSelect(rowKey('annotation', annotation.id), modifiers),
    [handleToggleSelect],
  );

  const clearSelection = useCallback(() => {
    setSelectedRows([]);
    anchorIndexRef.current = null;
  }, []);

  const handleCreateBulk = useCallback(async () => {
    if (ranges.length === 0) return;
    await useAnnotationsStore.getState().createFromRanges(ranges);
    clearSelection();
  }, [clearSelection, ranges]);

  const handleEnqueue = useCallback(async () => {
    if (videoId === null) return;
    setBusy(true);
    try {
      const result = await api.enqueue([videoId]);
      useUIStore.getState().pushToast({
        kind: 'info',
        message: t('toast.enqueued', { count: result.queued.length }),
      });
      setReloadKey((value) => value + 1);
    } catch (error) {
      pushError(error);
    } finally {
      setBusy(false);
    }
  }, [videoId]);

  const handleReprocess = useCallback(async () => {
    if (videoId === null) return;
    setBusy(true);
    try {
      await api.reprocess(videoId);
      setReloadKey((value) => value + 1);
    } catch (error) {
      pushError(error);
    } finally {
      setBusy(false);
    }
  }, [videoId]);

  const handleRetry = useCallback(() => {
    void usePlayerStore.getState().reload();
    if (videoId !== null) void useAnnotationsStore.getState().refresh(videoId);
  }, [videoId]);

  const handleSeparatorKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    event.stopPropagation();
    const delta = event.key === 'ArrowLeft' ? 16 : -16;
    setTimingsWidth(resizer.size + delta);
  };

  const panelWidth = collapsed ? COLLAPSED_WIDTH : resizer.size;
  const status = video?.status ?? null;
  const progress = video?.progress ?? 0;

  const renderBody = (): JSX.Element => {
    if (playerLoading) {
      return (
        <div className="vl-timing-panel__skeleton" aria-label={t('timings.loading')}>
          {Array.from({ length: SKELETON_ROWS }).map((_, index) => (
            <div key={index} className="vl-timing-panel__skeleton-row" />
          ))}
        </div>
      );
    }
    if (playerError) {
      return (
        <div className="vl-timing-panel__state">
          <p className="vl-timing-panel__state-text">{t('annotations.loadFailed')}</p>
          <button type="button" onClick={handleRetry}>
            {t('common.retry')}
          </button>
        </div>
      );
    }
    if (rows.length === 0) {
      if (status === 'queued' || status === 'processing') {
        return (
          <div className="vl-timing-panel__state">
            <p className="vl-timing-panel__state-text">{t('status.processing', { percent: Math.round(progress * 100) })}</p>
            <div className="vl-timing-panel__progress" aria-hidden="true">
              <div className="vl-timing-panel__progress-bar" style={{ width: `${Math.round(progress * 100)}%` }} />
            </div>
            <button type="button" disabled>
              {t('timings.processNow')}
            </button>
          </div>
        );
      }
      if (status === 'error') {
        return (
          <div className="vl-timing-panel__state">
            <p className="vl-timing-panel__state-text">{video?.error ?? t('toast.error', { message: '' })}</p>
            <button type="button" disabled={busy} onClick={() => void handleReprocess()}>
              {t('timings.reprocess')}
            </button>
          </div>
        );
      }
      if (status === 'missing') {
        return (
          <div className="vl-timing-panel__state">
            <p className="vl-timing-panel__state-text">{t('player.fileMissing')}</p>
          </div>
        );
      }
      if (status === 'done') {
        return (
          <div className="vl-timing-panel__state">
            <p className="vl-timing-panel__state-text">{t('timings.noSegments')}</p>
            <button type="button" disabled={busy} onClick={() => void handleReprocess()}>
              {t('timings.reprocess')}
            </button>
          </div>
        );
      }
      return (
        <div className="vl-timing-panel__state">
          <p className="vl-timing-panel__state-text">{t('timings.notReady')}</p>
          <button type="button" className="primary" disabled={busy} onClick={() => void handleEnqueue()}>
            {t('timings.processNow')}
          </button>
        </div>
      );
    }
    return (
      <div className="vl-timing-panel__rows" role="listbox" aria-label={t('timings.title')} aria-multiselectable="true">
        {rows.map((row) => {
          if (row.segment) {
            return (
              <SegmentRow
                key={row.key}
                segment={row.segment}
                active={row.segment.id === activeSegmentId}
                selected={selectedRows.includes(row.key)}
                onActivate={handleActivateSegment}
                onToggleSelect={handleSegmentToggle}
              />
            );
          }
          if (row.annotation) {
            return (
              <AnnotationRow
                key={row.key}
                annotation={row.annotation}
                active={row.annotation.id === activeAnnotationId || row.annotation.id === selectedId}
                selected={selectedRows.includes(row.key)}
                onActivate={handleActivateAnnotation}
                onEdit={handleEditAnnotation}
                onDelete={handleDeleteAnnotation}
                onToggleSelect={handleAnnotationToggle}
              />
            );
          }
          return <div key={row.key} />;
        })}
      </div>
    );
  };

  return (
    <aside
      className={`vl-timing-panel${collapsed ? ' is-collapsed' : ''}${className ? ` ${className}` : ''}`}
      style={{ width: `${panelWidth}px` }}
      aria-label={t('timings.title')}
    >
      {!collapsed && (
        <div
          className={`vl-timing-panel__resizer${resizer.dragging ? ' is-dragging' : ''}`}
          role="separator"
          aria-orientation="vertical"
          aria-label={t('timings.title')}
          aria-valuemin={MIN_WIDTH}
          aria-valuemax={MAX_WIDTH}
          aria-valuenow={resizer.size}
          tabIndex={0}
          onPointerDown={resizer.onPointerDown}
          onKeyDown={handleSeparatorKeyDown}
        />
      )}
      <div className="vl-timing-panel__inner">
        <header className="vl-timing-panel__header">
          <button
            type="button"
            className="vl-timing-panel__collapse"
            aria-label={collapsed ? t('timings.expand') : t('timings.collapse')}
            title={collapsed ? t('timings.expand') : t('timings.collapse')}
            aria-expanded={!collapsed}
            onClick={toggleTimings}
          >
            {collapsed ? '▶' : '◀'}
          </button>
          {!collapsed && (
            <>
              <h2 className="vl-timing-panel__title">{t('timings.title')}</h2>
              <button
                type="button"
                className="primary"
                onClick={() => useAnnotationsStore.getState().createAtPlayhead()}
              >
                {t('annotations.add')}
              </button>
              <button
                type="button"
                title={t('external.openTitle')}
                disabled={videoId === null}
                onClick={() => {
                  if (videoId === null) return;
                  useExternalStore
                    .getState()
                    .openLaunch(videoId, usePlayerStore.getState().positionMs);
                }}
              >
                {t('external.open')}
              </button>
            </>
          )}
        </header>
        {!collapsed && (
          <>
            <div className="vl-timing-panel__tools">
              <button
                type="button"
                aria-pressed={follow}
                className={follow ? 'is-active' : ''}
                onClick={() => setFollow((value) => !value)}
                title={t('timings.follow')}
              >
                {t('timings.follow')}
              </button>
              <button
                type="button"
                aria-pressed={showAnnotations}
                className={showAnnotations ? 'is-active' : ''}
                onClick={() => setShowAnnotations((value) => !value)}
                title={t('timings.showAnnotations')}
              >
                🏷
              </button>
              <span className="vl-timing-panel__tools-spacer" />
              <button
                type="button"
                aria-label={t('annotations.undo')}
                title={t('annotations.undo')}
                disabled={!undoStack.canUndo}
                onClick={() => void undoStack.undo()}
              >
                ↶
              </button>
              <button
                type="button"
                aria-label={t('annotations.redo')}
                title={t('annotations.redo')}
                disabled={!undoStack.canRedo}
                onClick={() => void undoStack.redo()}
              >
                ↷
              </button>
            </div>
            {ranges.length > 0 && (
              <div className="vl-timing-panel__bulk">
                <button type="button" onClick={() => void handleCreateBulk()}>
                  {t('annotations.createOnSelection')}
                </button>
                <button type="button" onClick={clearSelection}>
                  {t('common.cancel')}
                </button>
              </div>
            )}
            <div
              className="vl-timing-panel__body"
              ref={bodyRef}
              onScroll={handleScroll}
              onWheel={pauseFollow}
              onTouchMove={pauseFollow}
            >
              {renderBody()}
            </div>
          </>
        )}
      </div>
    </aside>
  );
}
