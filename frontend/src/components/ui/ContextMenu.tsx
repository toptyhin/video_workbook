import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import './ContextMenu.css';

export interface ContextMenuItem {
  id: string;
  label: string;
  /** Необязательный тултип пункта (например, полный путь назначения). */
  title?: string;
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

const SUBMENU_MIN_WIDTH = 220;
const VIEWPORT_MARGIN = 8;
const SUBMENU_MAX_HEIGHT = 520;

interface SubmenuProps {
  anchor: HTMLElement | null;
  items: ContextMenuItem[];
  onClose: () => void;
}

/**
 * Подменю рендерится порталом в `document.body` с `position: fixed`: иначе его
 * обрезает `overflow-y` родительского `.vl-menu`, а у края окна оно уходит за
 * экран. Позиция считается по кнопке-якорю: справа, при нехватке места — слева
 * от неё; по вертикали прижимается к вьюпорту, высота ограничивается скроллом.
 */
function Submenu({ anchor, items, onClose }: SubmenuProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || !anchor) return;
    const anchorRect = anchor.getBoundingClientRect();
    const width = container.offsetWidth || SUBMENU_MIN_WIDTH;
    const naturalHeight = container.offsetHeight;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    let left = anchorRect.right - 2;
    if (left + width > viewportWidth - VIEWPORT_MARGIN) {
      left = Math.max(VIEWPORT_MARGIN, anchorRect.left - width + 2);
    }
    left = Math.min(left, Math.max(VIEWPORT_MARGIN, viewportWidth - width - VIEWPORT_MARGIN));

    const maxHeight = Math.min(SUBMENU_MAX_HEIGHT, viewportHeight - VIEWPORT_MARGIN * 2);
    const height = Math.min(naturalHeight, maxHeight);
    let top = anchorRect.top - 4;
    if (top + height > viewportHeight - VIEWPORT_MARGIN) {
      top = viewportHeight - VIEWPORT_MARGIN - height;
    }
    top = Math.max(VIEWPORT_MARGIN, top);

    container.style.left = `${left}px`;
    container.style.top = `${top}px`;
    const menu = container.querySelector<HTMLElement>('.vl-menu');
    if (menu) menu.style.maxHeight = `${Math.max(120, viewportHeight - top - VIEWPORT_MARGIN)}px`;
  }, [anchor, items]);

  return createPortal(
    <div ref={containerRef} className="vl-menu__submenu" data-submenu="true">
      <MenuLevel
        items={items}
        onClose={onClose}
        openId={null}
        setOpenId={() => undefined}
        submenu
      />
    </div>,
    document.body,
  );
}

function MenuLevel({ items, onClose, openId, setOpenId, submenu = false }: MenuLevelProps) {
  const itemRefs = useRef<Record<string, HTMLButtonElement | null>>({});

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
            ref={(element) => {
              itemRefs.current[item.id] = element;
            }}
            type="button"
            role="menuitem"
            className={`vl-menu__item${item.danger ? ' vl-menu__item--danger' : ''}`}
            disabled={item.disabled}
            title={item.title}
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
            <Submenu anchor={itemRefs.current[item.id] ?? null} items={item.children} onClose={onClose} />
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
      const target = event.target as Element | null;
      const insideMenu = containerRef.current?.contains(target as Node);
      // Подменю живёт в портале (`data-submenu`) вне контейнера корневого меню.
      const insideSubmenu = target?.closest?.('[data-submenu="true"]') != null;
      if (!insideMenu && !insideSubmenu) onClose();
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
