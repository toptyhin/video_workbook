import type { ReactNode } from 'react';
import { t } from '../../lib/i18n';
import './Spinner.css';

export interface SpinnerProps {
  /** Видимый текст рядом со спиннером (по умолчанию — «Загрузка…»). */
  label?: string;
  size?: number;
  /** Не добавлять текстовую подпись, только индикатор. */
  compact?: boolean;
}

export function Spinner({ label, size = 18, compact = false }: SpinnerProps) {
  const text = label ?? t('timings.loading');
  return (
    <span className="vl-spinner" role="status" aria-live="polite">
      <span
        className="vl-spinner__circle"
        style={{ width: size, height: size }}
        aria-hidden="true"
      />
      {!compact && <span className="vl-spinner__label">{text}</span>}
      {compact && <span className="sr-only">{text}</span>}
    </span>
  );
}

export function SpinnerBlock({ children }: { children?: ReactNode }) {
  return <div className="vl-spinner-block">{children ?? <Spinner />}</div>;
}
