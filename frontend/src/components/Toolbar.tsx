import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { vl } from '../api/electron';
import type { SearchScope } from '../api/types';
import { t } from '../lib/i18n';
import { useLibraryStore } from '../state/libraryStore';
import { useSearchStore } from '../state/searchStore';
import { useUIStore } from '../state/uiStore';
import { ConfirmDialog } from './ui/ConfirmDialog';
import './Toolbar.css';

const SCOPES: { value: SearchScope; labelKey: string }[] = [
  { value: 'all', labelKey: 'toolbar.scopeAll' },
  { value: 'files', labelKey: 'toolbar.scopeFiles' },
  { value: 'segments', labelKey: 'toolbar.scopeSegments' },
  { value: 'annotations', labelKey: 'toolbar.scopeAnnotations' },
];

/** Верхняя панель: добавление/удаление файлов, поиск, настройки и «О клавишах». */
export function Toolbar() {
  const selectedCount = useLibraryStore((state) => state.selectedIds.length);
  const scanPaths = useLibraryStore((state) => state.scanPaths);
  const removeSelected = useLibraryStore((state) => state.removeSelected);

  const query = useSearchStore((state) => state.query);
  const scope = useSearchStore((state) => state.scope);
  const setQuery = useSearchStore((state) => state.setQuery);
  const setScope = useSearchStore((state) => state.setScope);
  const runSearch = useSearchStore((state) => state.runSearch);
  const clearSearch = useSearchStore((state) => state.clear);

  const setSettingsOpen = useUIStore((state) => state.setSettingsOpen);
  const setHotkeysOpen = useUIStore((state) => state.setHotkeysOpen);

  const searchRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.code === 'KeyF') {
        event.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, []);

  const handleAddFiles = async (): Promise<void> => {
    setBusy(true);
    try {
      const paths = await vl().openFiles();
      if (paths.length > 0) await scanPaths(paths);
    } finally {
      setBusy(false);
    }
  };

  const handleScopeChange = (event: ChangeEvent<HTMLSelectElement>): void => {
    setScope(event.target.value as SearchScope);
  };

  return (
    <div className="vl-toolbar" role="toolbar" aria-label={t('app.name')}>
      <button type="button" onClick={() => void handleAddFiles()} disabled={busy}>
        {t('toolbar.addFiles')}
      </button>
      <button
        type="button"
        onClick={() => setConfirmRemove(true)}
        disabled={selectedCount === 0}
        title={t('toolbar.removeFromAnalysis')}
      >
        {t('toolbar.removeFromAnalysis')}
      </button>

      <div className="vl-toolbar__search">
        <input
          ref={searchRef}
          type="search"
          className="vl-toolbar__search-input"
          value={query}
          placeholder={t('toolbar.searchPlaceholder')}
          aria-label={t('common.search')}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              void runSearch();
            } else if (event.key === 'Escape') {
              event.preventDefault();
              clearSearch();
              event.currentTarget.blur();
            }
          }}
        />
        <select
          className="vl-toolbar__scope"
          value={scope}
          aria-label={t('toolbar.searchScope')}
          title={t('toolbar.searchScope')}
          onChange={handleScopeChange}
        >
          {SCOPES.map((item) => (
            <option key={item.value} value={item.value}>
              {t(item.labelKey)}
            </option>
          ))}
        </select>
      </div>

      <div className="vl-toolbar__spacer" />

      <button
        type="button"
        className="vl-toolbar__icon-button"
        aria-label={t('hotkeys.help')}
        title={t('hotkeys.help')}
        onClick={() => setHotkeysOpen(true)}
      >
        <span aria-hidden="true">?</span>
      </button>
      <button
        type="button"
        className="vl-toolbar__icon-button"
        aria-label={t('toolbar.settings')}
        title={t('toolbar.settings')}
        onClick={() => setSettingsOpen(true)}
      >
        <span aria-hidden="true">⚙</span>
      </button>

      {confirmRemove && (
        <ConfirmDialog
          title={t('common.delete')}
          message={t('toast.videoRemoved')}
          confirmLabel={t('toolbar.removeFromAnalysis')}
          danger
          onConfirm={() => {
            setConfirmRemove(false);
            void removeSelected();
          }}
          onCancel={() => setConfirmRemove(false)}
        />
      )}
    </div>
  );
}
