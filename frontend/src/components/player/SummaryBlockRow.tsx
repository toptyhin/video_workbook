import type { KeyboardEvent } from 'react';

import type { SummaryBlock } from '../../api/types';
import { formatTimecode } from '../../lib/time';
import { usePlayerStore } from '../../state/playerStore';
import './SummaryBlockRow.css';

/**
 * Строка блока смыслового дерева саммари (M14 rev2): заголовок узла (если есть),
 * таймкод диапазона, текст и ключевые термины. Клик/Enter — переход к началу блока.
 *
 * Для корневого уровня дерева (`max_level`) у блока может не быть заголовка —
 * `titleFallback` подставляет «Кратко о видео» (см. `TimingPanel`).
 */
export interface SummaryBlockRowProps {
  block: SummaryBlock;
  active: boolean;
  /** Заголовок-заглушка, если у блока нет собственного `title`. */
  titleFallback?: string | null;
  /** Дополнительная реакция панели (например, отключить follow при ручном выборе). */
  onActivate?: (block: SummaryBlock) => void;
}

export function SummaryBlockRow({
  block,
  active,
  titleFallback = null,
  onActivate,
}: SummaryBlockRowProps): JSX.Element {
  const timecode = `[${formatTimecode(block.start_ms)}–${formatTimecode(block.end_ms)}]`;
  const className = `vl-summary-block${active ? ' is-active' : ''}`;
  const title = block.title ?? titleFallback;

  const activate = (): void => {
    usePlayerStore.getState().seek(block.start_ms);
    onActivate?.(block);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    activate();
  };

  return (
    <div
      className={className}
      role="option"
      aria-selected={active}
      tabIndex={0}
      title={title ? `${title} · ${timecode}` : `${timecode} ${block.text}`}
      data-summary-block=""
      data-node-id={block.node_id}
      data-start-ms={block.start_ms}
      onClick={activate}
      onKeyDown={handleKeyDown}
    >
      {title && <span className="vl-summary-block__title">{title}</span>}
      <span className="vl-summary-block__time">{timecode}</span>
      <span className="vl-summary-block__text">{block.text}</span>
      {block.keywords && block.keywords.length > 0 && (
        <span className="vl-summary-block__keywords">
          {block.keywords.map((keyword, index) => (
            <span className="vl-summary-block__chip" key={`${keyword}-${index}`}>
              {keyword}
            </span>
          ))}
        </span>
      )}
    </div>
  );
}
