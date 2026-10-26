import type { KeyboardEvent, MouseEvent } from 'react';

import type { Segment } from '../../api/types';
import { formatTimecode } from '../../lib/time';
import './SegmentRow.css';

export interface RowModifiers {
  ctrl: boolean;
  shift: boolean;
}

export interface SegmentRowProps {
  segment: Segment;
  active: boolean;
  selected: boolean;
  onActivate: (segment: Segment) => void;
  onToggleSelect: (segment: Segment, modifiers: RowModifiers) => void;
}

export function SegmentRow({ segment, active, selected, onActivate, onToggleSelect }: SegmentRowProps): JSX.Element {
  const className = [
    'vl-segment-row',
    active ? 'is-active' : '',
    selected ? 'is-selected' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const handleClick = (event: MouseEvent<HTMLDivElement>): void => {
    const ctrl = event.ctrlKey || event.metaKey;
    if (ctrl || event.shiftKey) {
      event.preventDefault();
      onToggleSelect(segment, { ctrl, shift: event.shiftKey });
      return;
    }
    onActivate(segment);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Enter') {
      event.preventDefault();
      onActivate(segment);
    }
  };

  return (
    <div
      className={className}
      role="option"
      aria-selected={selected}
      tabIndex={0}
      title={segment.text}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      data-segment-id={segment.id}
    >
      <span className="vl-segment-row__time">{formatTimecode(segment.start_ms)}</span>
      <span className="vl-segment-row__text">{segment.text}</span>
    </div>
  );
}
