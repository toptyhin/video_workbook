import type { ReactNode } from 'react';
import './EmptyState.css';

export interface EmptyStateProps {
  title: string;
  description?: string;
  actionLabel?: string;
  onAction?: () => void;
  icon?: ReactNode;
  /** Дополнительное содержимое под кнопкой (например, подсказка). */
  children?: ReactNode;
}

export function EmptyState({ title, description, actionLabel, onAction, icon, children }: EmptyStateProps) {
  return (
    <div className="vl-empty">
      {icon !== undefined && (
        <div className="vl-empty__icon" aria-hidden="true">
          {icon}
        </div>
      )}
      <p className="vl-empty__title">{title}</p>
      {description && <p className="vl-empty__description">{description}</p>}
      {actionLabel && onAction && (
        <button type="button" className="vl-empty__action" onClick={onAction}>
          {actionLabel}
        </button>
      )}
      {children}
    </div>
  );
}
