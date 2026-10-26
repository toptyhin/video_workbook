import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, KeyboardEvent } from 'react';

import { api } from '../../api/client';
import type { Annotation, TagNode, Video } from '../../api/types';
import { ANNOTATION_COLORS, SEARCH_DEBOUNCE_MS } from '../../lib/constants';
import { fileBaseName, formatDate } from '../../lib/format';
import { t } from '../../lib/i18n';
import { formatTimecode, formatTimecodeWithMs } from '../../lib/time';
import { useUndoStack } from '../../hooks/useUndoStack';
import { useAnnotationsStore } from '../../state/annotationsStore';
import { usePlayerStore } from '../../state/playerStore';
import { pushError, useUIStore } from '../../state/uiStore';
import './AnnotationList.css';

export interface AnnotationListProps {
  /** Если не задан — переход выполняется событием `vl:open` `{videoId, ms}`. */
  onOpen?: (videoId: number, startMs: number) => void;
  className?: string;
}

interface FlatTag {
  id: number;
  name: string;
  depth: number;
  color: string | null;
}

interface Filters {
  q: string;
  tagId: number | null;
  color: string | null;
  videoId: number | null;
}

type SortMode = 'time' | 'video';

const PAGE_LIMIT = 200;

function flattenTags(nodes: readonly TagNode[], depth = 0, out: FlatTag[] = []): FlatTag[] {
  for (const node of nodes) {
    out.push({ id: node.id, name: node.name, depth, color: node.color });
    if (node.children.length > 0) flattenTags(node.children, depth + 1, out);
  }
  return out;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function AnnotationList({ onOpen, className }: AnnotationListProps): JSX.Element {
  const [filters, setFilters] = useState<Filters>({ q: '', tagId: null, color: null, videoId: null });
  const [queryText, setQueryText] = useState('');
  const [sort, setSort] = useState<SortMode>('time');
  const [items, setItems] = useState<Annotation[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tags, setTags] = useState<FlatTag[]>([]);
  const [videos, setVideos] = useState<Video[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [importing, setImporting] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);
  const undoStack = useUndoStack();
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setFilters((previous) =>
        previous.q === queryText ? previous : { ...previous, q: queryText },
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [queryText]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .annotations({
        video_id: filters.videoId ?? undefined,
        tag_id: filters.tagId ?? undefined,
        color: filters.color ?? undefined,
        q: filters.q.trim() || undefined,
        limit: PAGE_LIMIT,
      })
      .then((response) => {
        if (cancelled) return;
        setItems(response.items);
        setTotal(response.total);
        setError(null);
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setError(errorText(reason));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [filters, refreshTick]);

  useEffect(() => {
    let cancelled = false;
    api
      .tags()
      .then((response) => {
        if (!cancelled) setTags(flattenTags(response.items));
      })
      .catch(() => undefined);
    api
      .listVideos({ limit: 500 })
      .then((response) => {
        if (!cancelled) setVideos(response.items);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const onChanged = (): void => setRefreshTick((value) => value + 1);
    window.addEventListener('vl:annotations:changed', onChanged);
    return () => window.removeEventListener('vl:annotations:changed', onChanged);
  }, []);

  const tagNames = useMemo(() => {
    const map = new Map<number, string>();
    for (const tag of tags) map.set(tag.id, tag.name);
    return map;
  }, [tags]);

  const videoTitles = useMemo(() => {
    const map = new Map<number, string>();
    for (const video of videos) map.set(video.id, video.title ?? fileBaseName(video.path));
    return map;
  }, [videos]);

  const sortedItems = useMemo(() => {
    const copy = [...items];
    if (sort === 'video') {
      copy.sort((a, b) => {
        const left = videoTitles.get(a.video_id) ?? '';
        const right = videoTitles.get(b.video_id) ?? '';
        return left.localeCompare(right, 'ru') || a.start_ms - b.start_ms || a.id - b.id;
      });
    } else {
      copy.sort((a, b) => a.start_ms - b.start_ms || a.video_id - b.video_id || a.id - b.id);
    }
    return copy;
  }, [items, sort, videoTitles]);

  const openAnnotation = useCallback(
    (annotation: Annotation) => {
      setActiveId(annotation.id);
      if (onOpen) {
        onOpen(annotation.video_id, annotation.start_ms);
        return;
      }
      window.dispatchEvent(
        new CustomEvent('vl:open', {
          detail: { videoId: annotation.video_id, ms: annotation.start_ms },
        }),
      );
      // playerStore применит seek после load(videoId), если видео ещё не открыто.
      window.dispatchEvent(
        new CustomEvent('vl:seek', {
          detail: { videoId: annotation.video_id, ms: annotation.start_ms },
        }),
      );
    },
    [onOpen],
  );

  const editAnnotation = useCallback((annotation: Annotation) => {
    useAnnotationsStore.getState().openEditEditor(annotation);
  }, []);

  const deleteAnnotation = useCallback(async (annotation: Annotation) => {
    const removed = await useAnnotationsStore.getState().remove(annotation.id);
    if (removed) setRefreshTick((value) => value + 1);
  }, []);

  const handleExport = useCallback(async () => {
    try {
      const data = await api.exportAnnotations(filters.videoId ?? undefined);
      if (typeof URL.createObjectURL !== 'function') {
        throw new Error('Blob download недоступен в этом окружении');
      }
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `annotations-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (reason) {
      pushError(reason);
    }
  }, [filters.videoId]);

  const handleImportClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleImportFile = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.target;
    const file = input.files?.[0] ?? null;
    input.value = '';
    if (!file) return;
    const targetVideo = filters.videoId ?? usePlayerStore.getState().videoId;
    if (targetVideo === null) {
      useUIStore.getState().pushToast({ kind: 'warn', message: t('annotations.importSelectVideo') });
      return;
    }
    setImporting(true);
    try {
      const text = await file.text();
      const data: unknown = JSON.parse(text);
      const result = await api.importAnnotations(targetVideo, data);
      useUIStore.getState().pushToast({
        kind: 'success',
        message: t('annotations.imported', { imported: result.imported, skipped: result.skipped }),
      });
      setRefreshTick((value) => value + 1);
    } catch (reason) {
      pushError(reason);
    } finally {
      setImporting(false);
    }
  }, [filters.videoId]);

  const handleRowKeyDown = (event: KeyboardEvent<HTMLLIElement>, annotation: Annotation): void => {
    if (event.key === 'Enter') {
      event.preventDefault();
      openAnnotation(annotation);
      return;
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      event.stopPropagation();
      void deleteAnnotation(annotation);
    }
  };

  const handleRetry = useCallback(() => setRefreshTick((value) => value + 1), []);

  return (
    <section className={`vl-annotation-list${className ? ` ${className}` : ''}`} aria-label={t('annotations.list')}>
      <header className="vl-annotation-list__header">
        <h2 className="vl-annotation-list__title">{t('annotations.list')}</h2>
        <span className="vl-annotation-list__count" aria-live="polite">
          {total}
        </span>
        <span className="vl-annotation-list__spacer" />
        <button
          type="button"
          disabled={!undoStack.canUndo}
          title={t('annotations.undo')}
          aria-label={t('annotations.undo')}
          onClick={() => void undoStack.undo()}
        >
          ↶
        </button>
        <button
          type="button"
          disabled={!undoStack.canRedo}
          title={t('annotations.redo')}
          aria-label={t('annotations.redo')}
          onClick={() => void undoStack.redo()}
        >
          ↷
        </button>
        <button type="button" onClick={handleExport} title={t('annotations.export')}>
          {t('annotations.export')}
        </button>
        <button type="button" disabled={importing} onClick={handleImportClick} title={t('annotations.import')}>
          {t('annotations.import')}
        </button>
        <button type="button" onClick={handleRetry} title={t('common.retry')} aria-label={t('common.retry')}>
          ↻
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".json,application/json"
          className="vl-annotation-list__file"
          onChange={(event) => void handleImportFile(event)}
        />
      </header>

      <div className="vl-annotation-list__filters">
        <input
          type="search"
          className="vl-annotation-list__query"
          value={queryText}
          placeholder={t('annotations.filterText')}
          aria-label={t('annotations.filterText')}
          onChange={(event) => setQueryText(event.target.value)}
        />
        <select
          value={filters.tagId ?? ''}
          aria-label={t('annotations.filterTag')}
          onChange={(event) =>
            setFilters((previous) => ({
              ...previous,
              tagId: event.target.value === '' ? null : Number(event.target.value),
            }))
          }
        >
          <option value="">{t('annotations.filterTag')}</option>
          {tags.map((tag) => (
            <option key={tag.id} value={tag.id}>
              {`${'— '.repeat(tag.depth)}${tag.name}`}
            </option>
          ))}
        </select>
        <select
          value={filters.videoId ?? ''}
          aria-label={t('annotations.filterVideo')}
          onChange={(event) =>
            setFilters((previous) => ({
              ...previous,
              videoId: event.target.value === '' ? null : Number(event.target.value),
            }))
          }
        >
          <option value="">{t('annotations.allVideos')}</option>
          {videos.map((video) => (
            <option key={video.id} value={video.id}>
              {video.title ?? fileBaseName(video.path)}
            </option>
          ))}
        </select>
        <select
          value={sort}
          aria-label={t('annotations.sort')}
          onChange={(event) => setSort(event.target.value === 'video' ? 'video' : 'time')}
        >
          <option value="time">{t('annotations.sortByTime')}</option>
          <option value="video">{t('annotations.sortByVideo')}</option>
        </select>
      </div>

      <div className="vl-annotation-list__colors" role="group" aria-label={t('annotations.filterColor')}>
        {ANNOTATION_COLORS.map((color) => (
          <button
            key={color}
            type="button"
            className={`vl-annotation-list__color${filters.color === color ? ' is-active' : ''}`}
            style={{ backgroundColor: color }}
            aria-label={color}
            aria-pressed={filters.color === color}
            onClick={() =>
              setFilters((previous) => ({
                ...previous,
                color: previous.color === color ? null : color,
              }))
            }
          />
        ))}
      </div>

      {loading && (
        <div className="vl-annotation-list__skeleton" aria-label={t('timings.loading')}>
          {[0, 1, 2].map((index) => (
            <div key={index} className="vl-annotation-list__skeleton-row" />
          ))}
        </div>
      )}

      {!loading && error && (
        <div className="vl-annotation-list__state">
          <p>{error}</p>
          <button type="button" onClick={handleRetry}>
            {t('common.retry')}
          </button>
        </div>
      )}

      {!loading && !error && sortedItems.length === 0 && (
        <div className="vl-annotation-list__state">
          <p>{t('annotations.empty')}</p>
        </div>
      )}

      {!loading && !error && sortedItems.length > 0 && (
        <ul className="vl-annotation-list__items" role="listbox" aria-label={t('annotations.list')}>
          {sortedItems.map((annotation) => (
            <li
              key={annotation.id}
              className={`vl-annotation-list__item${activeId === annotation.id ? ' is-active' : ''}`}
              role="option"
              aria-selected={activeId === annotation.id}
              tabIndex={0}
              data-annotation-id={annotation.id}
              onClick={() => openAnnotation(annotation)}
              onDoubleClick={() => editAnnotation(annotation)}
              onKeyDown={(event) => handleRowKeyDown(event, annotation)}
            >
              <span className="vl-annotation-list__item-color" style={{ backgroundColor: annotation.color }} aria-hidden="true" />
              <span className="vl-annotation-list__item-label">{annotation.label}</span>
              <span className="vl-annotation-list__item-time" title={formatTimecodeWithMs(annotation.start_ms)}>
                {formatTimecode(annotation.start_ms)} – {formatTimecode(annotation.end_ms)}
              </span>
              <span className="vl-annotation-list__item-video">
                {videoTitles.get(annotation.video_id) ?? `#${annotation.video_id}`}
              </span>
              <span className="vl-annotation-list__item-tags">
                {annotation.tag_ids.map((tagId) => (
                  <span key={tagId} className="vl-annotation-list__tag">
                    {tagNames.get(tagId) ?? `#${tagId}`}
                  </span>
                ))}
              </span>
              <span className="vl-annotation-list__item-date">{formatDate(annotation.created_at)}</span>
              <button
                type="button"
                className="vl-annotation-list__item-delete"
                aria-label={t('common.delete')}
                title={t('common.delete')}
                onClick={(event) => {
                  event.stopPropagation();
                  void deleteAnnotation(annotation);
                }}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
