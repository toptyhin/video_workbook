import type { KeyboardEvent, MouseEvent } from 'react';

import type { Annotation } from '../../api/types';
import { t } from '../../lib/i18n';
import { formatTimecode, formatTimecodeWithMs } from '../../lib/time';
import type { RowModifiers } from './SegmentRow';
import './AnnotationRow.css';

export interface AnnotationRowProps {
  annotation: Annotation;
  active: boolean;
  selected: boolean;
  onActivate: (annotation: Annotation) => void;
  onEdit: (annotation: Annotation) => void;
  onDelete: (annotation: Annotation) => void;
  onToggleSelect: (annotation: Annotation, modifiers: RowModifiers) => void;
}

export function AnnotationRow(props: AnnotationRowProps): JSX.Element {
  const { annotation, active, selected, onActivate, onEdit, onDelete, onToggleSelect } = props;
  const label = annotation.label.trim().length > 0 ? annotation.label : t('annotations.list');
  const className = [
    'vl-annotation-row',
    active ? 'is-active' : '',
    selected ? 'is-selected' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const handleClick = (event: MouseEvent<HTMLDivElement>): void => {
    const ctrl = event.ctrlKey || event.metaKey;
    if (ctrl || event.shiftKey) {
      event.preventDefault();
      onToggleSelect(annotation, { ctrl, shift: event.shiftKey });
      return;
    }
    onActivate(annotation);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Enter') {
      event.preventDefault();
      onActivate(annotation);
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
      className={className}
      style={{ borderLeftColor: annotation.color }}
      role="option"
      aria-selected={selected}
      tabIndex={0}
      title={`${label} · ${formatTimecodeWithMs(annotation.start_ms)} – ${formatTimecodeWithMs(annotation.end_ms)}`}
      onClick={handleClick}
      onDoubleClick={(event) => {
        event.stopPropagation();
        onEdit(annotation);
      }}
      onKeyDown={handleKeyDown}
      data-annotation-id={annotation.id}
    >
      <span className="vl-annotation-row__icon" aria-hidden="true">🏷</span>
      <span className="vl-annotation-row__label">{label}</span>
      <span className="vl-annotation-row__time">
        {formatTimecode(annotation.start_ms)} – {formatTimecode(annotation.end_ms)}
      </span>
    </div>
  );
}
