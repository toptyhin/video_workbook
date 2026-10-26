import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import './ContextMenu.css';

export interface ContextMenuItem {
  id: string;
  label: string;
  disabled?: boolean;
  danger?: boolean;
  separatorBefore?: boolean;
  onSelect?: () => void;
  /** Вложенное меню (например, список тегов). */
  children?: ContextMenuItem[];
}

export interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
  label?: string;
}

const MENU_WIDTH = 240;
const MENU_HEIGHT_ESTIMATE = 320;

function clampPosition(x: number, y: number): { left: number; top: number } {
  const left = Math.min(x, Math.max(8, window.innerWidth - MENU_WIDTH - 8));
  const top = Math.min(y, Math.max(8, window.innerHeight - MENU_HEIGHT_ESTIMATE));
  return { left, top };
}

interface MenuLevelProps {
  items: ContextMenuItem[];
  onClose: () => void;
  openId: string | null;
  setOpenId: (id: string | null) => void;
  submenu?: boolean;
}

function MenuLevel({ items, onClose, openId, setOpenId, submenu = false }: MenuLevelProps) {
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const buttons = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>(
        ':scope > .vl-menu__entry > [role="menuitem"]',
      ),
    ).filter((button) => !button.disabled);
    if (buttons.length === 0) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      const next = buttons[(index + delta + buttons.length) % buttons.length];
      next?.focus();
      return;
    }
    if (event.key === 'ArrowRight') {
      const entry = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('.vl-menu__entry');
      const id = entry?.dataset.entryId;
      if (id && items.find((item) => item.id === id)?.children?.length) {
        event.preventDefault();
        setOpenId(id);
      }
      return;
    }
    if (event.key === 'ArrowLeft' && submenu) {
      event.preventDefault();
      setOpenId(null);
    }
  };

  return (
    <div
      className={`vl-menu${submenu ? ' vl-menu--sub' : ''}`}
      role="menu"
      onKeyDown={handleKeyDown}
    >
      {items.map((item) => (
        <div
          key={item.id}
          className={`vl-menu__entry${item.separatorBefore ? ' vl-menu__entry--separated' : ''}`}
          data-entry-id={item.id}
        >
          <button
            type="button"
            role="menuitem"
            className={`vl-menu__item${item.danger ? ' vl-menu__item--danger' : ''}`}
            disabled={item.disabled}
            aria-haspopup={item.children?.length ? 'menu' : undefined}
            aria-expanded={item.children?.length ? openId === item.id : undefined}
            onMouseEnter={() => setOpenId(item.children?.length ? item.id : null)}
            onClick={() => {
              if (item.children?.length) {
                setOpenId(openId === item.id ? null : item.id);
                return;
              }
              item.onSelect?.();
              onClose();
            }}
          >
            <span className="vl-menu__label">{item.label}</span>
            {item.children?.length ? (
              <span className="vl-menu__chevron" aria-hidden="true">
                ›
              </span>
            ) : null}
          </button>
          {item.children?.length && openId === item.id ? (
            <div className="vl-menu__submenu">
              <MenuLevel
                items={item.children}
                onClose={onClose}
                openId={null}
                setOpenId={() => undefined}
                submenu
              />
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

/** Позиционируемое контекстное меню с клавиатурной навигацией. */
export function ContextMenu({ x, y, items, onClose, label }: ContextMenuProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const position = useMemo(() => clampPosition(x, y), [x, y]);

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) onClose();
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKey, true);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKey, true);
    };
  }, [onClose]);

  useEffect(() => {
    const first = containerRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)');
    first?.focus();
  }, []);

  return createPortal(
    <div
      ref={containerRef}
      className="vl-context-menu"
      role="presentation"
      aria-label={label}
      style={{ left: position.left, top: position.top }}
    >
      <MenuLevel items={items} onClose={onClose} openId={openId} setOpenId={setOpenId} />
    </div>,
    document.body,
  );
}
