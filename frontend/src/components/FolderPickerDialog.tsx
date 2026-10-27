import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api/client';
import type { Folder, FsEntry } from '../api/types';
import { dirName, fileBaseName } from '../lib/format';
import { t } from '../lib/i18n';
import { useFileBrowserStore } from '../state/fileBrowserStore';
import { useLibraryStore } from '../state/libraryStore';
import { Spinner } from './ui/Spinner';
import './FolderPickerDialog.css';

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isWithin(path: string, root: string): boolean {
  const normalizedRoot = root.replace(/\/+$/, '');
  return path === normalizedRoot || path.startsWith(`${normalizedRoot}/`);
}

function isWithinRoots(path: string, folders: Folder[]): boolean {
  return folders.some((folder) => isWithin(path, folder.path));
}

/**
 * Модальный выбор папки-назначения для перемещения/копирования (plans/15 §4.3).
 * Открывается из `useFileBrowserStore.transfer !== null`; навигация — по
 * watched roots через `GET /api/fs/list` (как в FolderTree).
 */
export function FolderPickerDialog() {
  const transfer = useFileBrowserStore((state) => state.transfer);
  const transferring = useFileBrowserStore((state) => state.transferring);
  const closeTransfer = useFileBrowserStore((state) => state.closeTransfer);
  const transferTo = useFileBrowserStore((state) => state.transferTo);

  const [roots, setRoots] = useState<Folder[]>([]);
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const [parent, setParent] = useState<string | null>(null);
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const open = transfer !== null;

  const navigate = async (path: string): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const response = await api.fsList(path);
      setCurrentPath(response.path.length > 0 ? response.path : path);
      setParent(response.parent);
      setEntries(response.entries);
    } catch (loadError) {
      setError(errorText(loadError));
    } finally {
      setLoading(false);
    }
  };

  // Стартовая папка — родитель первого выбранного файла (если внутри watched root),
  // иначе — список отслеживаемых корней.
  useEffect(() => {
    if (!transfer) return;
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        let rootItems = useFileBrowserStore.getState().folders;
        if (rootItems.length === 0) {
          const response = await api.folders();
          rootItems = response.items;
        }
        if (cancelled) return;
        setRoots(rootItems);
        const firstVideo = useLibraryStore
          .getState()
          .videos.find((video) => video.id === transfer.ids[0]);
        const startCandidate = firstVideo ? dirName(firstVideo.path) : null;
        const start = startCandidate && isWithinRoots(startCandidate, rootItems) ? startCandidate : null;
        if (start) {
          const response = await api.fsList(start);
          if (cancelled) return;
          setCurrentPath(response.path.length > 0 ? response.path : start);
          setParent(response.parent);
          setEntries(response.entries);
        } else {
          setCurrentPath(null);
          setParent(null);
          setEntries([]);
        }
      } catch (loadError) {
        if (!cancelled) setError(errorText(loadError));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [transfer]);

  // Escape/«Отмена» + focus-trap как в SettingsDialog/LaunchDialog.
  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeTransfer();
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
  }, [open, closeTransfer]);

  if (!transfer) return null;

  const title = transfer.action === 'move' ? t('files.folderPickTitleMove') : t('files.folderPickTitleCopy');
  const confirmLabel = transfer.action === 'move' ? t('files.moveHere') : t('files.copyHere');

  const retry = (): void => {
    setError(null);
    void navigate(currentPath ?? '');
  };

  const handleConfirm = (): void => {
    if (transferring || currentPath === null) return;
    void transferTo(transfer.action, transfer.ids, currentPath);
  };

  return createPortal(
    <div
      className="vl-folderpick-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !transferring) closeTransfer();
      }}
    >
      <div
        ref={dialogRef}
        className="vl-folderpick"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={transferring}
        tabIndex={-1}
      >
        <header className="vl-folderpick__header">
          <h2 className="vl-folderpick__title" id={titleId}>
            {title}
          </h2>
          <button
            type="button"
            className="vl-folderpick__close"
            aria-label={t('common.close')}
            title={t('common.close')}
            onClick={closeTransfer}
          >
            ×
          </button>
        </header>

        <div className="vl-folderpick__path" title={currentPath ?? ''}>
          <span className="vl-folderpick__path-label">{t('files.path')}:</span>
          <span className="vl-folderpick__path-value">{currentPath ?? t('files.roots')}</span>
        </div>

        <div className="vl-folderpick__body">
          {currentPath !== null && (
            <button
              type="button"
              className="vl-folderpick__up"
              disabled={parent === null || loading}
              onClick={() => {
                if (parent !== null) void navigate(parent);
              }}
            >
              {t('files.up')}
            </button>
          )}

          {loading && (
            <div className="vl-folderpick__status">
              <Spinner />
            </div>
          )}

          {!loading && error && (
            <div className="vl-folderpick__status">
              <p>{t('toast.error', { message: error })}</p>
              <button type="button" onClick={retry}>
                {t('common.retry')}
              </button>
            </div>
          )}

          {!loading && !error && currentPath === null && (
            roots.length === 0 ? (
              <p className="vl-folderpick__empty">{t('sidebar.noFolders')}</p>
            ) : (
              <ul className="vl-folderpick__list" aria-label={t('files.roots')}>
                {roots.map((folder) => (
                  <li key={folder.id}>
                    <button
                      type="button"
                      className="vl-folderpick__entry"
                      title={folder.path}
                      onClick={() => void navigate(folder.path)}
                    >
                      <span className="vl-folderpick__entry-icon" aria-hidden="true">
                        📁
                      </span>
                      <span className="vl-folderpick__entry-name">{fileBaseName(folder.path)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )
          )}

          {!loading && !error && currentPath !== null && (
            entries.length === 0 ? (
              <p className="vl-folderpick__empty">{t('files.noSubfolders')}</p>
            ) : (
              <ul className="vl-folderpick__list">
                {entries.map((entry) => (
                  <li key={entry.path}>
                    <button
                      type="button"
                      className="vl-folderpick__entry"
                      title={entry.path}
                      onClick={() => void navigate(entry.path)}
                    >
                      <span className="vl-folderpick__entry-icon" aria-hidden="true">
                        📁
                      </span>
                      <span className="vl-folderpick__entry-name">{entry.name}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )
          )}
        </div>

        <footer className="vl-folderpick__footer">
          <span className="vl-folderpick__count">
            {t('files.selectedCount', { count: transfer.ids.length })}
          </span>
          <button type="button" disabled={transferring} onClick={closeTransfer}>
            {t('files.cancel')}
          </button>
          <button
            type="button"
            className="primary"
            disabled={transferring || currentPath === null || loading}
            onClick={handleConfirm}
          >
            {transferring ? t('files.transferring') : confirmLabel}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
