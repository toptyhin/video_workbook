import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { api } from '../../api/client';
import { vl } from '../../api/electron';
import type { Folder, FsEntry } from '../../api/types';
import { fileBaseName } from '../../lib/format';
import { t } from '../../lib/i18n';
import { useLibraryStore } from '../../state/libraryStore';
import { useUIStore } from '../../state/uiStore';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { EmptyState } from '../ui/EmptyState';
import { Spinner } from '../ui/Spinner';
import './FolderTree.css';

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface FolderTreeProps {
  /** Увеличивается при SSE `folder.scanned`, чтобы перечитать папки и счётчики. */
  refreshToken?: number;
}

/** Дерево отслеживаемых папок: раскрытие подкаталогов, фильтр списка, добавление/удаление. */
export function FolderTree({ refreshToken = 0 }: FolderTreeProps = {}) {
  const folderPath = useLibraryStore((state) => state.folderPath);
  const setFolder = useLibraryStore((state) => state.setFolder);
  const pushToast = useUIStore((state) => state.pushToast);

  const [folders, setFolders] = useState<Folder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<string[]>([]);
  const [children, setChildren] = useState<Record<string, FsEntry[]>>({});
  const [loadingPaths, setLoadingPaths] = useState<string[]>([]);
  const [folderToRemove, setFolderToRemove] = useState<Folder | null>(null);

  const toastError = (error: unknown): void => {
    pushToast({ kind: 'error', message: t('toast.error', { message: errorText(error) }) });
  };

  const loadFolders = async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const response = await api.folders();
      setFolders(response.items);
    } catch (loadError) {
      setError(errorText(loadError));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadFolders();
  }, [refreshToken]);

  const loadChildren = async (path: string): Promise<void> => {
    if (children[path] !== undefined) return;
    setLoadingPaths((current) => [...current, path]);
    try {
      const response = await api.fsList(path);
      setChildren((current) => ({ ...current, [path]: response.entries }));
    } catch (loadError) {
      toastError(loadError);
    } finally {
      setLoadingPaths((current) => current.filter((value) => value !== path));
    }
  };

  const toggleDir = (path: string): void => {
    const isExpanded = expanded.includes(path);
    setExpanded(isExpanded ? expanded.filter((value) => value !== path) : [...expanded, path]);
    if (!isExpanded) void loadChildren(path);
  };

  const handleAddFolder = async (): Promise<void> => {
    setBusy(true);
    try {
      const path = await vl().openFolder();
      if (!path) return;
      await api.addFolder(path);
      pushToast({ kind: 'success', message: t('toast.folderAdded') });
      await loadFolders();
    } catch (addError) {
      toastError(addError);
    } finally {
      setBusy(false);
    }
  };

  const handleRemoveFolder = async (folder: Folder): Promise<void> => {
    try {
      await api.removeFolder(folder.id);
      if (folderPath === folder.path) setFolder(null);
      pushToast({ kind: 'success', message: t('toast.folderRemoved') });
      await loadFolders();
    } catch (removeError) {
      toastError(removeError);
    }
  };

  const activeFolder = useMemo(() => folderPath, [folderPath]);

  const renderEntry = (entry: FsEntry, level: number): ReactNode => {
    const isExpanded = expanded.includes(entry.path);
    const isLoading = loadingPaths.includes(entry.path);
    const entryChildren = children[entry.path];
    return (
      <li
        key={entry.path}
        role="treeitem"
        aria-level={level}
        aria-expanded={isExpanded}
        aria-selected={activeFolder === entry.path}
      >
        <div className={`vl-tree-row${activeFolder === entry.path ? ' vl-tree-row--active' : ''}`} style={{ paddingLeft: 4 + level * 12 }}>
          <button
            type="button"
            className="vl-tree-row__chevron"
            aria-label={entry.name}
            aria-expanded={isExpanded}
            disabled={isLoading}
            onClick={() => toggleDir(entry.path)}
          >
            <span aria-hidden="true">{isLoading ? '…' : isExpanded ? '▾' : '▸'}</span>
          </button>
          <button
            type="button"
            className="vl-tree-row__label"
            title={entry.path}
            onClick={() => setFolder(activeFolder === entry.path ? null : entry.path)}
          >
            {entry.name}
          </button>
        </div>
        {isExpanded && entryChildren && entryChildren.length > 0 && (
          <ul role="group">
            {entryChildren.map((child) => renderEntry(child, level + 1))}
          </ul>
        )}
      </li>
    );
  };

  if (loading && folders.length === 0) {
    return (
      <div className="vl-tree-panel__status">
        <Spinner />
      </div>
    );
  }

  if (error && folders.length === 0) {
    return (
      <EmptyState
        title={t('toast.error', { message: error })}
        actionLabel={t('common.retry')}
        onAction={() => void loadFolders()}
      />
    );
  }

  return (
    <div className="vl-tree-panel">
      <div className="vl-tree-panel__toolbar">
        <button type="button" onClick={() => void handleAddFolder()} disabled={busy}>
          {t('toolbar.addFolder')}
        </button>
      </div>
      {folders.length === 0 ? (
        <EmptyState title={t('sidebar.noFolders')} actionLabel={t('toolbar.addFolder')} onAction={() => void handleAddFolder()} />
      ) : (
        <ul className="vl-tree" role="tree" aria-label={t('sidebar.tabFiles')}>
          {activeFolder !== null && (
            <li role="treeitem" aria-level={1} aria-selected={false}>
              <div className="vl-tree-row" style={{ paddingLeft: 4 }}>
                <span className="vl-tree-row__chevron" aria-hidden="true" />
                <button type="button" className="vl-tree-row__label" onClick={() => setFolder(null)}>
                  {t('sidebar.tabFiles')}
                </button>
              </div>
            </li>
          )}
          {folders.map((folder) => {
            const isExpanded = expanded.includes(folder.path);
            const folderChildren = children[folder.path];
            return (
              <li
                key={folder.id}
                role="treeitem"
                aria-level={1}
                aria-expanded={isExpanded}
                aria-selected={activeFolder === folder.path}
              >
                <div className={`vl-tree-row${activeFolder === folder.path ? ' vl-tree-row--active' : ''}`} style={{ paddingLeft: 4 }}>
                  <button
                    type="button"
                    className="vl-tree-row__chevron"
                    aria-label={fileBaseName(folder.path)}
                    aria-expanded={isExpanded}
                    onClick={() => toggleDir(folder.path)}
                  >
                    <span aria-hidden="true">{isExpanded ? '▾' : '▸'}</span>
                  </button>
                  <button
                    type="button"
                    className="vl-tree-row__label"
                    title={folder.path}
                    onClick={() => setFolder(activeFolder === folder.path ? null : folder.path)}
                  >
                    {fileBaseName(folder.path)}
                  </button>
                  <span className="vl-tree-row__count" title={t('sidebar.tabFiles')}>
                    {folder.done}/{folder.total}
                  </span>
                  <button
                    type="button"
                    className="vl-tree-row__action"
                    aria-label={t('common.delete')}
                    title={t('common.delete')}
                    onClick={() => setFolderToRemove(folder)}
                  >
                    ×
                  </button>
                </div>
                {isExpanded && (
                  <ul role="group">
                    {(folderChildren ?? []).map((entry) => renderEntry(entry, 2))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {folderToRemove && (
        <ConfirmDialog
          title={t('common.delete')}
          message={t('toast.folderRemoved')}
          confirmLabel={t('common.delete')}
          danger
          onConfirm={() => {
            const target = folderToRemove;
            setFolderToRemove(null);
            void handleRemoveFolder(target);
          }}
          onCancel={() => setFolderToRemove(null)}
        />
      )}
    </div>
  );
}
