import { memo } from 'react';
import type { KeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';

import type { Annotation } from '../../api/types';
import { t } from '../../lib/i18n';
import { formatTimecode, formatTimecodeWithMs } from '../../lib/time';
import { rangeToPercent, type TimeRange } from '../../lib/timelineGeometry';
import './AnnotationMarker.css';

export interface AnnotationMarkerProps {
  annotation: Annotation;
  durationMs: number;
  selected: boolean;
  /** Диапазон-превью во время ресайза; если задан — перекрывает сохранённые границы. */
  previewRange?: TimeRange | null;
  onSeek: (annotation: Annotation) => void;
  onEdit: (annotation: Annotation) => void;
  onDelete: (annotation: Annotation) => void;
  onContextMenu: (annotation: Annotation, x: number, y: number) => void;
  onResizeStart?: (
    event: ReactPointerEvent<HTMLElement>,
    annotation: Annotation,
    edge: 'start' | 'end',
  ) => void;
}

function AnnotationMarkerInner(props: AnnotationMarkerProps): JSX.Element {
  const {
    annotation,
    durationMs,
    selected,
    previewRange = null,
    onSeek,
    onEdit,
    onDelete,
    onContextMenu,
    onResizeStart,
  } = props;
  const range: TimeRange = previewRange ?? {
    start_ms: annotation.start_ms,
    end_ms: annotation.end_ms,
  };
  const { left, width } = rangeToPercent(range.start_ms, range.end_ms, durationMs);
  const label = annotation.label.trim().length > 0 ? annotation.label : t('annotations.list');
  const timeRange = `${formatTimecode(range.start_ms)} – ${formatTimecode(range.end_ms)}`;
  const ariaLabel = `${t('annotations.list')}: ${label}, ${timeRange}`;

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      event.stopPropagation();
      onSeek(annotation);
      return;
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      event.stopPropagation();
      onDelete(annotation);
      return;
    }
    if (event.key === 'F2') {
      event.preventDefault();
      event.stopPropagation();
      onEdit(annotation);
    }
  };

  return (
    <div
      className={`vl-marker${selected ? ' is-selected' : ''}`}
      style={{ left: `${left}%`, width: `${width}%`, backgroundColor: annotation.color }}
      role="button"
      tabIndex={0}
      aria-label={ariaLabel}
      aria-pressed={selected}
      title={`${label} · ${formatTimecodeWithMs(range.start_ms)} – ${formatTimecodeWithMs(range.end_ms)}`}
      data-annotation-id={annotation.id}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        onSeek(annotation);
      }}
      onDoubleClick={(event) => {
        event.stopPropagation();
        onEdit(annotation);
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onContextMenu(annotation, event.clientX, event.clientY);
      }}
      onKeyDown={handleKeyDown}
    >
      <span className="vl-marker__label">{label}</span>
      {selected && onResizeStart && (
        <>
          <span
            className="vl-marker__handle vl-marker__handle--start"
            aria-hidden="true"
            onPointerDown={(event) => onResizeStart(event, annotation, 'start')}
            onDoubleClick={(event) => event.stopPropagation()}
          />
          <span
            className="vl-marker__handle vl-marker__handle--end"
            aria-hidden="true"
            onPointerDown={(event) => onResizeStart(event, annotation, 'end')}
            onDoubleClick={(event) => event.stopPropagation()}
          />
        </>
      )}
    </div>
  );
}

export const AnnotationMarker = memo(AnnotationMarkerInner);
