import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../../api/client';
import { vl } from '../../api/electron';
import type { AppInfo, Folder, SettingsValues } from '../../api/types';
import { t } from '../../lib/i18n';
import type { Theme } from '../../state/uiStore';
import { useUIStore } from '../../state/uiStore';
import { useExternalStore } from '../../state/externalStore';
import { useTagsStore } from '../../state/tagsStore';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { Spinner } from '../ui/Spinner';
import { ModelsSection } from './ModelsSection';
import { SummarySettings } from './SummarySettings';
import './SettingsDialog.css';

const THEMES: { value: Theme; labelKey: string }[] = [
  { value: 'light', labelKey: 'settings.themeLight' },
  { value: 'dark', labelKey: 'settings.themeDark' },
  { value: 'system', labelKey: 'settings.themeSystem' },
];

const MODELS = ['tiny', 'base', 'small', 'medium'] as const;
const LANGUAGES = ['auto', 'ru', 'en'] as const;
const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Окно настроек: библиотека (папки, переиндексация), распознавание (модель, язык),
 * интерфейс (тема, режим тегов), данные/о программе.
 */
export function SettingsDialog() {
  const open = useUIStore((state) => state.settingsOpen);
  const setSettingsOpen = useUIStore((state) => state.setSettingsOpen);
  const theme = useUIStore((state) => state.theme);
  const setTheme = useUIStore((state) => state.setTheme);
  const setHotkeysOpen = useUIStore((state) => state.setHotkeysOpen);
  const pushToast = useUIStore((state) => state.pushToast);

  const tagsMode = useTagsStore((state) => state.mode);
  const syncMode = useTagsStore((state) => state.syncMode);
  const setMode = useTagsStore((state) => state.setMode);

  const [values, setValues] = useState<SettingsValues>({});
  const [folders, setFolders] = useState<Folder[]>([]);
  const [clearingPreview, setClearingPreview] = useState(false);
  const [playerPathDraft, setPlayerPathDraft] = useState('');
  const externalPlayers = useExternalStore((state) => state.players);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [backendVersion, setBackendVersion] = useState<string | null>(null);
  const [folderToRemove, setFolderToRemove] = useState<Folder | null>(null);
  const [confirmReindex, setConfirmReindex] = useState(false);

  const dialogRef = useRef<HTMLDivElement>(null);
  const blockEscapeRef = useRef(false);
  blockEscapeRef.current = Boolean(folderToRemove || confirmReindex);
  const titleId = useId();

  const toastError = (toastSource: unknown): void => {
    pushToast({ kind: 'error', message: t('toast.error', { message: errorText(toastSource) }) });
  };

  const load = async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const [settingsValues, folderResponse] = await Promise.all([api.getSettings(), api.folders()]);
      setValues(settingsValues);
      setPlayerPathDraft(String(settingsValues['external.player_path'] ?? ''));
      setFolders(folderResponse.items);
      void useExternalStore.getState().refreshPlayers();
      const modeValue = settingsValues['tags.multi_select_mode'];
      if (modeValue === 'union' || modeValue === 'intersection') syncMode(modeValue);
      const info = await vl().getAppInfo().catch(() => null);
      setAppInfo(info);
      const health = await api.health().catch(() => null);
      setBackendVersion(health?.version ?? null);
    } catch (loadError) {
      setError(errorText(loadError));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) void load();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (blockEscapeRef.current) return;
        event.preventDefault();
        event.stopPropagation();
        setSettingsOpen(false);
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
  }, [open, setSettingsOpen]);

  const patch = async (partial: SettingsValues): Promise<boolean> => {
    const previous = values;
    setValues({ ...values, ...partial });
    setBusy(true);
    try {
      const full = await api.patchSettings(partial);
      setValues(full);
      return true;
    } catch (patchError) {
      toastError(patchError);
      setValues(previous);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const handleThemeChange = async (next: Theme): Promise<void> => {
    const previous = theme;
    setTheme(next);
    const ok = await patch({ theme: next });
    if (!ok) setTheme(previous);
  };

  const reloadFolders = async (): Promise<void> => {
    const response = await api.folders();
    setFolders(response.items);
  };

  const handleAddFolder = async (): Promise<void> => {
    setBusy(true);
    try {
      const path = await vl().openFolder();
      if (!path) return;
      await api.addFolder(path);
      await reloadFolders();
      pushToast({ kind: 'success', message: t('toast.folderAdded') });
    } catch (addError) {
      toastError(addError);
    } finally {
      setBusy(false);
    }
  };

  const handleRemoveFolder = async (folder: Folder): Promise<void> => {
    try {
      await api.removeFolder(folder.id);
      await reloadFolders();
      pushToast({ kind: 'success', message: t('toast.folderRemoved') });
    } catch (removeError) {
      toastError(removeError);
    }
  };

  const handleReindexAll = async (): Promise<void> => {
    if (folders.length === 0) return;
    setBusy(true);
    try {
      for (const folder of folders) {
        await api.scan(folder.path);
      }
      pushToast({ kind: 'success', message: t('settings.reindexAll') });
    } catch (scanError) {
      toastError(scanError);
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  return createPortal(
    <div
      className="vl-settings-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) setSettingsOpen(false);
      }}
    >
      <div
        ref={dialogRef}
        className="vl-settings"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <header className="vl-settings__header">
          <h2 className="vl-settings__title" id={titleId}>
            {t('settings.title')}
          </h2>
          <button
            type="button"
            className="vl-settings__close"
            aria-label={t('common.close')}
            title={t('common.close')}
            onClick={() => setSettingsOpen(false)}
          >
            ×
          </button>
        </header>

        <div className="vl-settings__body">
          {loading && (
            <div className="vl-settings__status">
              <Spinner />
            </div>
          )}

          {!loading && error && (
            <div className="vl-settings__status">
              <p>{t('toast.error', { message: error })}</p>
              <button type="button" onClick={() => void load()}>
                {t('common.retry')}
              </button>
            </div>
          )}

          {!loading && !error && (
            <>
              <section className="vl-settings__section">
                <h3 className="vl-settings__section-title">{t('settings.folders')}</h3>
                <ul className="vl-settings__folders">
                  {folders.map((folder) => (
                    <li key={folder.id} className="vl-settings__folder">
                      <span className="vl-settings__folder-path" title={folder.path}>
                        {folder.path}
                      </span>
                      <span className="vl-settings__folder-count">
                        {folder.done}/{folder.total}
                      </span>
                      <button
                        type="button"
                        aria-label={t('common.delete')}
                        title={t('common.delete')}
                        onClick={() => setFolderToRemove(folder)}
                      >
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
                <div className="vl-settings__row">
                  <button type="button" disabled={busy} onClick={() => void handleAddFolder()}>
                    {t('settings.addFolder')}
                  </button>
                  <button
                    type="button"
                    disabled={busy || folders.length === 0}
                    onClick={() => setConfirmReindex(true)}
                  >
                    {t('settings.reindexAll')}
                  </button>
                </div>
              </section>

              <section className="vl-settings__section">
                <h3 className="vl-settings__section-title">{t('settings.model')}</h3>
                <label className="vl-settings__field">
                  <span>{t('settings.model')}</span>
                  <select
                    value={String(values.whisper_model ?? 'small')}
                    disabled={busy}
                    onChange={(event) => void patch({ whisper_model: event.target.value })}
                  >
                    {MODELS.map((model) => (
                      <option key={model} value={model}>
                        {model}
                      </option>
                    ))}
                  </select>
                </label>
                <p className="vl-settings__hint">{t('settings.modelHint')}</p>
                <label className="vl-settings__field">
                  <span>{t('settings.language')}</span>
                  <select
                    value={String(values.language ?? 'auto')}
                    disabled={busy}
                    onChange={(event) => void patch({ language: event.target.value })}
                  >
                    {LANGUAGES.map((language) => (
                      <option key={language} value={language}>
                        {language}
                      </option>
                    ))}
                  </select>
                </label>
              </section>

              <ModelsSection />

              <section className="vl-settings__section">
                <h3 className="vl-settings__section-title">{t('settings.summarySection')}</h3>
                <SummarySettings
                  onOpenModels={() =>
                    document.getElementById('vl-models-section')?.scrollIntoView({ block: 'start' })
                  }
                />
              </section>

              <section className="vl-settings__section">
                <h3 className="vl-settings__section-title">{t('settings.theme')}</h3>
                <label className="vl-settings__field">
                  <span>{t('settings.theme')}</span>
                  <select
                    value={theme}
                    disabled={busy}
                    onChange={(event) => void handleThemeChange(event.target.value as Theme)}
                  >
                    {THEMES.map((item) => (
                      <option key={item.value} value={item.value}>
                        {t(item.labelKey)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="vl-settings__field">
                  <span>{t('annotations.tags')}</span>
                  <select
                    value={tagsMode}
                    disabled={busy}
                    onChange={(event) => {
                      const next = event.target.value === 'intersection' ? 'intersection' : 'union';
                      void setMode(next);
                    }}
                  >
                    <option value="union">{t('tags.multiUnion')}</option>
                    <option value="intersection">{t('tags.multiIntersection')}</option>
                  </select>
                </label>
              </section>

              <section className="vl-settings__section">
                <h3 className="vl-settings__section-title">{t('settings.clearModelCache')}</h3>
                <p className="vl-settings__hint">{t('settings.modelHint')}</p>
                <button
                  type="button"
                  disabled
                  title={t('settings.clearModelCache')}
                  aria-disabled="true"
                >
                  {t('settings.clearModelCache')}
                </button>
              </section>

              <section className="vl-settings__section">
                <h3 className="vl-settings__section-title">{t('settings.externalSection')}</h3>
                <label className="vl-settings__field">
                  <span>{t('external.player')}</span>
                  <select
                    value={String(values['external.player'] ?? 'mpv')}
                    disabled={busy}
                    onChange={(event) =>
                      void patch({ 'external.player': event.target.value }).then(() =>
                        useExternalStore.getState().refreshPlayers(),
                      )
                    }
                  >
                    {externalPlayers.map((item) => (
                      <option key={item.id} value={item.id} disabled={!item.available}>
                        {item.label}
                        {item.sync ? ' · sync' : ''}
                        {item.available ? '' : ` — ${t('external.notAvailable')}`}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="vl-settings__field">
                  <span>{t('external.policy')}</span>
                  <select
                    value={String(values['external.policy'] ?? 'ask')}
                    disabled={busy}
                    onChange={(event) =>
                      void patch({ 'external.policy': event.target.value }).then(() =>
                        useExternalStore.getState().refreshPlayers(),
                      )
                    }
                  >
                    <option value="ask">{t('external.policyAsk')}</option>
                    <option value="always">{t('external.policyAlways')}</option>
                    <option value="never">{t('external.policyNever')}</option>
                  </select>
                </label>
                <label className="vl-settings__field">
                  <span>{t('external.path')}</span>
                  <input
                    value={playerPathDraft}
                    placeholder="/usr/bin/mpv"
                    onChange={(event) => setPlayerPathDraft(event.target.value)}
                    onBlur={() => {
                      if (playerPathDraft !== String(values['external.player_path'] ?? '')) {
                        void patch({ 'external.player_path': playerPathDraft });
                      }
                    }}
                  />
                </label>
                <label className="vl-settings__check">
                  <input
                    type="checkbox"
                    checked={Boolean(values['external.pass_marks'] ?? true)}
                    disabled={busy}
                    onChange={(event) =>
                      void patch({ 'external.pass_marks': event.target.checked }).then(() =>
                        useExternalStore.getState().refreshPlayers(),
                      )
                    }
                  />
                  {t('external.passMarks')}
                </label>
                <p className="vl-settings__hint">
                  {externalPlayers
                    .map(
                      (item) =>
                        `${item.label}: ${
                          item.available
                            ? `${t('external.available')} (${item.path})`
                            : t('external.notAvailable')
                        }`,
                    )
                    .join(' · ')}
                </p>
              </section>

              <section className="vl-settings__section">
                <h3 className="vl-settings__section-title">{t('settings.previewCache')}</h3>
                <p className="vl-settings__hint">{t('settings.previewCacheHint')}</p>
                <button
                  type="button"
                  disabled={clearingPreview}
                  onClick={() => {
                    setClearingPreview(true);
                    void api
                      .clearPreviewCache()
                      .then(() => pushToast({ kind: 'success', message: t('settings.previewCacheCleared') }))
                      .catch((error: unknown) =>
                        pushToast({ kind: 'error', message: t('toast.error', { message: errorText(error) }) }),
                      )
                      .finally(() => setClearingPreview(false));
                  }}
                >
                  {t('settings.clearPreviewCache')}
                </button>
              </section>

              <section className="vl-settings__section">
                <h3 className="vl-settings__section-title">{t('settings.about')}</h3>
                <dl className="vl-settings__dl">
                  <div>
                    <dt>{t('settings.about')}</dt>
                    <dd>{appInfo?.version ?? '—'}</dd>
                  </div>
                  <div>
                    <dt>{'backend'}</dt>
                    <dd>{backendVersion ?? '—'}</dd>
                  </div>
                  <div>
                    <dt>{'data'}</dt>
                    <dd className="vl-settings__path">{appInfo?.dataDir ?? '—'}</dd>
                  </div>
                  <div>
                    <dt>{'logs'}</dt>
                    <dd className="vl-settings__path">{appInfo?.logsDir ?? '—'}</dd>
                  </div>
                </dl>
                <div className="vl-settings__row">
                  <button
                    type="button"
                    disabled={!appInfo}
                    onClick={() => {
                      if (appInfo) void vl().revealInExplorer(appInfo.logsDir);
                    }}
                  >
                    {t('player.showInFolder')}
                  </button>
                  <button type="button" onClick={() => setHotkeysOpen(true)}>
                    {t('settings.hotkeys')}
                  </button>
                </div>
              </section>
            </>
          )}
        </div>

        <footer className="vl-settings__footer">
          <button type="button" className="primary" onClick={() => setSettingsOpen(false)}>
            {t('common.close')}
          </button>
        </footer>

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

        {confirmReindex && (
          <ConfirmDialog
            title={t('settings.reindexAll')}
            message={t('settings.modelHint')}
            confirmLabel={t('settings.reindexAll')}
            onConfirm={() => {
              setConfirmReindex(false);
              void handleReindexAll();
            }}
            onCancel={() => setConfirmReindex(false)}
          />
        )}
      </div>
    </div>,
    document.body,
  );
}
