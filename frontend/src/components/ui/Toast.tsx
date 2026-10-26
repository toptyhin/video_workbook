import { createPortal } from 'react-dom';
import type { Toast } from '../../state/uiStore';
import { useUIStore } from '../../state/uiStore';
import { t } from '../../lib/i18n';
import './Toast.css';

const ICONS: Record<Toast['kind'], string> = {
  info: 'i',
  success: '✓',
  warn: '!',
  error: '×',
};

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const role = toast.kind === 'error' ? 'alert' : 'status';
  return (
    <div className={`vl-toast vl-toast--${toast.kind}`} role={role}>
      <span className="vl-toast__icon" aria-hidden="true">
        {ICONS[toast.kind]}
      </span>
      <span className="vl-toast__message">{toast.message}</span>
      {toast.action && (
        <button
          type="button"
          className="vl-toast__action"
          onClick={() => {
            toast.action?.run();
            onDismiss();
          }}
        >
          {toast.action.label}
        </button>
      )}
      <button type="button" className="vl-toast__close" aria-label={t('common.close')} onClick={onDismiss}>
        ×
      </button>
    </div>
  );
}

/** Хост тостов: читает `useUIStore.toasts`, рендерит в `document.body`. */
export function ToastHost() {
  const toasts = useUIStore((state) => state.toasts);
  const dismissToast = useUIStore((state) => state.dismissToast);
  if (toasts.length === 0) return null;
  return createPortal(
    <div className="vl-toasts" role="region" aria-live="polite" aria-label={t('app.name')}>
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onDismiss={() => dismissToast(toast.id)} />
      ))}
    </div>,
    document.body,
  );
}
