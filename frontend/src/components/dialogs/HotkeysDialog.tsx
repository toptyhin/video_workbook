import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { t } from '../../lib/i18n';
import { useUIStore } from '../../state/uiStore';
import './HotkeysDialog.css';

interface HotkeyRow {
  keys: string;
  labelKey: string;
}

interface HotkeyGroup {
  titleKey: string;
  rows: HotkeyRow[];
}

/**
 * Статический список клавиш. Реестр `lib/hotkeys.ts` (plans/09 T-09.1) ещё не создан,
 * поэтому данные локальны; при появлении реестра сюда нужно передавать его содержимое.
 */
const GROUPS: HotkeyGroup[] = [
  {
    titleKey: 'common.search',
    rows: [
      { keys: 'Ctrl+F', labelKey: 'hotkeys.search' },
      { keys: 'Ctrl+O', labelKey: 'hotkeys.addFiles' },
      { keys: 'F1', labelKey: 'hotkeys.help' },
    ],
  },
  {
    titleKey: 'timings.title',
    rows: [{ keys: 'Space', labelKey: 'hotkeys.playPause' }],
  },
  {
    titleKey: 'annotations.list',
    rows: [
      { keys: 'Ctrl+M', labelKey: 'hotkeys.annotation' },
      { keys: 'Delete', labelKey: 'hotkeys.delete' },
      { keys: 'Ctrl+Z', labelKey: 'hotkeys.undo' },
      { keys: 'Ctrl+Shift+Z', labelKey: 'hotkeys.redo' },
    ],
  },
  {
    titleKey: 'settings.title',
    rows: [{ keys: 'Esc', labelKey: 'common.close' }],
  },
];

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/** Окно «О клавишах»: `role="dialog"`, ловушка фокуса, закрытие по `Esc`/`F1`. */
export function HotkeysDialog() {
  const open = useUIStore((state) => state.hotkeysOpen);
  const setHotkeysOpen = useUIStore((state) => state.setHotkeysOpen);
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' || event.code === 'F1') {
        event.preventDefault();
        event.stopPropagation();
        setHotkeysOpen(false);
        return;
      }
      if (event.key !== 'Tab') return;
      const nodes = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
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
  }, [open, setHotkeysOpen]);

  if (!open) return null;

  return createPortal(
    <div
      className="vl-hotkeys-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) setHotkeysOpen(false);
      }}
    >
      <div
        ref={dialogRef}
        className="vl-hotkeys"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <header className="vl-hotkeys__header">
          <h2 className="vl-hotkeys__title" id={titleId}>
            {t('hotkeys.title')}
          </h2>
          <button
            type="button"
            className="vl-hotkeys__close"
            aria-label={t('common.close')}
            title={t('common.close')}
            onClick={() => setHotkeysOpen(false)}
          >
            ×
          </button>
        </header>
        <p className="vl-hotkeys__hint">{t('toolbar.searchPlaceholder')}</p>
        <div className="vl-hotkeys__groups">
          {GROUPS.map((group) => (
            <section className="vl-hotkeys__group" key={group.titleKey}>
              <h3 className="vl-hotkeys__group-title">{t(group.titleKey)}</h3>
              <dl className="vl-hotkeys__list">
                {group.rows.map((row) => (
                  <div className="vl-hotkeys__row" key={row.labelKey}>
                    <dt>
                      <kbd>{row.keys}</kbd>
                    </dt>
                    <dd>{t(row.labelKey)}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
        <footer className="vl-hotkeys__footer">
          <button type="button" className="primary" onClick={() => setHotkeysOpen(false)}>
            {t('common.close')}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
