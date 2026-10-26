import { useRef } from 'react';
import type { PointerEvent as ReactPointerEvent, KeyboardEvent as ReactKeyboardEvent } from 'react';
import { t } from '../../lib/i18n';
import { useUIStore } from '../../state/uiStore';
import { FolderTree } from './FolderTree';
import { TagTree } from './TagTree';
import './Sidebar.css';

const MIN_WIDTH = 200;
const MAX_WIDTH = 520;
const KEYBOARD_STEP = 16;

export interface SidebarProps {
  /** Увеличивается при SSE `folder.scanned`/`tags.changed`, чтобы перечитать деревья. */
  refreshToken?: number;
}

/** Левая панель: табы «Файлы»/«Теги» и регулировка ширины. */
export function Sidebar({ refreshToken = 0 }: SidebarProps = {}) {
  const tab = useUIStore((state) => state.sidebarTab);
  const setTab = useUIStore((state) => state.setSidebarTab);
  const width = useUIStore((state) => state.sidebarWidth);
  const setWidth = useUIStore((state) => state.setSidebarWidth);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    dragRef.current = { startX: event.clientX, startWidth: width };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (!drag) return;
    setWidth(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, drag.startWidth + event.clientX - drag.startX)));
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const handleResizerKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      setWidth(Math.max(MIN_WIDTH, width - KEYBOARD_STEP));
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      setWidth(Math.min(MAX_WIDTH, width + KEYBOARD_STEP));
    }
  };

  return (
    <aside className="vl-sidebar" style={{ width }} aria-label={t('sidebar.tabFiles')}>
      <div className="vl-sidebar__tabs" role="tablist" aria-label={t('app.name')}>
        <button
          type="button"
          role="tab"
          id="vl-sidebar-tab-files"
          aria-selected={tab === 'files'}
          aria-controls="vl-sidebar-panel"
          className={tab === 'files' ? 'vl-sidebar__tab vl-sidebar__tab--active' : 'vl-sidebar__tab'}
          onClick={() => setTab('files')}
        >
          {t('sidebar.tabFiles')}
        </button>
        <button
          type="button"
          role="tab"
          id="vl-sidebar-tab-tags"
          aria-selected={tab === 'tags'}
          aria-controls="vl-sidebar-panel"
          className={tab === 'tags' ? 'vl-sidebar__tab vl-sidebar__tab--active' : 'vl-sidebar__tab'}
          onClick={() => setTab('tags')}
        >
          {t('sidebar.tabTags')}
        </button>
      </div>
      <div
        className="vl-sidebar__panel"
        role="tabpanel"
        id="vl-sidebar-panel"
        aria-labelledby={tab === 'files' ? 'vl-sidebar-tab-files' : 'vl-sidebar-tab-tags'}
      >
        {tab === 'files' ? <FolderTree refreshToken={refreshToken} /> : <TagTree refreshToken={refreshToken} />}
      </div>
      <div
        className="vl-sidebar__resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label={t('sidebar.tabFiles')}
        aria-valuenow={width}
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={MAX_WIDTH}
        tabIndex={0}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onKeyDown={handleResizerKeyDown}
      />
    </aside>
  );
}
