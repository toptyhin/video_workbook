import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { t } from '../../lib/i18n';
import './ConfirmDialog.css';

export interface ConfirmDialogProps {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Модальное подтверждение с ловушкой фокуса и закрытием по `Esc`. */
export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  cancelLabel,
  danger = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;
  const titleId = useId();
  const messageId = useId();

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const buttons = (): HTMLElement[] =>
      Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button') ?? []);
    buttons()[0]?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onCancelRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const nodes = buttons();
      if (nodes.length === 0) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener('keydown', handleKey, true);
    return () => {
      document.removeEventListener('keydown', handleKey, true);
      previousFocus?.focus();
    };
  }, []);

  return createPortal(
    <div
      className="vl-confirm-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        ref={dialogRef}
        className="vl-confirm"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={messageId}
      >
        <h2 className="vl-confirm__title" id={titleId}>
          {title}
        </h2>
        <p className="vl-confirm__message" id={messageId}>
          {message}
        </p>
        <div className="vl-confirm__actions">
          <button type="button" onClick={onCancel}>
            {cancelLabel ?? t('common.cancel')}
          </button>
          <button
            type="button"
            className={danger ? 'vl-confirm__confirm vl-confirm__confirm--danger' : 'vl-confirm__confirm primary'}
            onClick={onConfirm}
          >
            {confirmLabel ?? t('common.delete')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
