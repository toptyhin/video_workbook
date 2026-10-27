import { useEffect, useState } from 'react';

import { api } from '../../api/client';
import { vl } from '../../api/electron';
import type { ModelInfo, ModelKind, ModelStatus } from '../../api/types';
import { formatBytes } from '../../lib/format';
import { t } from '../../lib/i18n';
import { ACTIVE_MODEL_STATUSES, useModelsStore } from '../../state/modelsStore';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { Spinner } from '../ui/Spinner';
import './ModelsSection.css';

const GROUPS: { kind: ModelKind; labelKey: string }[] = [
  { kind: 'transcription', labelKey: 'models.groupTranscription' },
  { kind: 'embedding', labelKey: 'models.groupEmbedding' },
  { kind: 'summary', labelKey: 'models.groupSummary' },
];

function isActive(status: ModelStatus): boolean {
  return ACTIVE_MODEL_STATUSES.includes(status);
}

function percentOf(model: ModelInfo): number {
  if (model.progress) {
    const percent = Number.isFinite(model.progress.percent) ? model.progress.percent : 0;
    return Math.min(100, Math.max(0, Math.round(percent)));
  }
  // «Проверка» идёт после скачивания: данные уже получены.
  return model.status === 'verifying' ? 100 : 0;
}

/** Подпись состояния строки (без действий). */
function statusText(model: ModelInfo): string | null {
  switch (model.status) {
    case 'ready':
      return t('models.installed');
    case 'bundled':
      return t('models.bundled');
    case 'queued':
      return t('models.queued');
    case 'verifying':
      return t('models.verifying');
    case 'downloading':
      return t('models.progress', { percent: percentOf(model) });
    case 'error':
      return errorText(model);
    case 'absent':
      return null;
    default:
      return null;
  }
}

/** Текст ошибки строки: специальные коды показываются понятнее. */
function errorText(model: ModelInfo): string {
  if (model.error_code === 'insufficient_disk') {
    return t('models.insufficientDisk', { size: formatBytes(model.size_bytes) });
  }
  if (model.error_code === 'model_in_use') {
    return t('models.inUse');
  }
  return t('models.error', { message: model.error ?? '' });
}

/**
 * Раздел «Настройки → Модели» (plans/13 §6): менеджер загрузки моделей.
 * Прогресс/статусы приходят через SSE в `useModelsStore.applyEvent` (wiring — App.tsx).
 */
export function ModelsSection() {
  const items = useModelsStore((state) => state.items);
  const totalInstalledBytes = useModelsStore((state) => state.totalInstalledBytes);
  const modelsDir = useModelsStore((state) => state.modelsDir);
  const offline = useModelsStore((state) => state.offline);
  const loading = useModelsStore((state) => state.loading);
  const error = useModelsStore((state) => state.error);
  const load = useModelsStore((state) => state.load);
  const download = useModelsStore((state) => state.download);
  const cancel = useModelsStore((state) => state.cancel);
  const remove = useModelsStore((state) => state.remove);
  const importModel = useModelsStore((state) => state.importModel);
  const setOffline = useModelsStore((state) => state.setOffline);
  const setEndpoint = useModelsStore((state) => state.setEndpoint);

  const [endpointDraft, setEndpointDraft] = useState('');
  const [savedEndpoint, setSavedEndpoint] = useState('');
  const [endpointLoaded, setEndpointLoaded] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<ModelInfo | null>(null);

  useEffect(() => {
    void load();
  }, [load]);

  // Текущее значение `models.endpoint` берём из настроек: в GET /api/models его нет.
  useEffect(() => {
    let cancelled = false;
    void api
      .getSettings()
      .then((values) => {
        if (cancelled) return;
        const value = String(values['models.endpoint'] ?? '');
        setEndpointDraft(value);
        setSavedEndpoint(value);
        setEndpointLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setEndpointLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const saveEndpoint = (): void => {
    const next = endpointDraft.trim();
    if (next === savedEndpoint) return;
    setSavedEndpoint(next);
    setEndpointDraft(next);
    void setEndpoint(next);
  };

  const openLicense = (url: string): void => {
    void vl().openExternal(url);
  };

  const handleImport = async (id: string): Promise<void> => {
    const path = await vl().openFolder();
    if (!path) return;
    await importModel(id, path);
  };

  const renderActions = (model: ModelInfo) => {
    if (model.status === 'bundled') return null;

    if (model.status === 'ready') {
      return (
        <>
          {model.update_available && (
            <button type="button" onClick={() => void download(model.id)}>
              {t('models.update')}
            </button>
          )}
          <button type="button" onClick={() => setRemoveTarget(model)}>
            {t('models.delete')}
          </button>
        </>
      );
    }

    if (isActive(model.status)) {
      return (
        <button type="button" onClick={() => void cancel(model.id)}>
          {t('models.cancel')}
        </button>
      );
    }

    if (model.status === 'error') {
      return (
        <>
          <button
            type="button"
            disabled={offline}
            title={offline ? t('models.offline') : undefined}
            onClick={() => void download(model.id)}
          >
            {t('models.retry')}
          </button>
          <button type="button" onClick={() => void handleImport(model.id)}>
            {t('models.import')}
          </button>
        </>
      );
    }

    return (
      <>
        <button
          type="button"
          disabled={offline}
          title={offline ? t('models.offline') : undefined}
          onClick={() => void download(model.id)}
        >
          {t('models.download')}
        </button>
        <button type="button" onClick={() => void handleImport(model.id)}>
          {t('models.import')}
        </button>
      </>
    );
  };

  const renderModel = (model: ModelInfo) => {
    const active = isActive(model.status);
    const percent = percentOf(model);
    const label = statusText(model);

    return (
      <li key={model.id} className="vl-models__item" data-model-id={model.id} data-status={model.status}>
        <div className="vl-models__row">
          <div className="vl-models__info">
            <div className="vl-models__title">
              <span className="vl-models__label">{model.label}</span>
              {model.recommended && (
                <span className="vl-models__badge vl-models__badge--recommended">
                  {t('models.recommended')}
                </span>
              )}
              {!model.recommended && model.kind === 'summary' && (
                <span className="vl-models__badge vl-models__badge--alternative">
                  {t('models.alternative')}
                </span>
              )}
            </div>
            <div className="vl-models__sub">
              <span className="vl-models__size">{formatBytes(model.size_bytes)}</span>
              <span aria-hidden="true"> · </span>
              <a
                className="vl-models__license"
                href={model.license.url}
                onClick={(event) => {
                  event.preventDefault();
                  openLicense(model.license.url);
                }}
              >
                {model.license.name}
              </a>
              {label && (
                <>
                  <span aria-hidden="true"> · </span>
                  <span className="vl-models__state">{label}</span>
                </>
              )}
            </div>
          </div>
          <div className="vl-models__actions">{renderActions(model)}</div>
        </div>

        {active && (
          <div className="vl-models__progress">
            <div
              className="vl-models__progressbar"
              role="progressbar"
              aria-label={model.label}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
            >
              <span className="vl-models__progressfill" style={{ width: `${percent}%` }} />
            </div>
            <span className="vl-models__progress-text">
              {percent}% · {formatBytes(model.progress?.bytes_received ?? 0)} /{' '}
              {formatBytes(model.progress?.total_bytes ?? model.size_bytes)}
            </span>
          </div>
        )}

        {model.error && model.status !== 'error' && (
          <p className="vl-models__row-error" role="alert">
            {errorText(model)}
          </p>
        )}
      </li>
    );
  };

  return (
    <section className="vl-settings__section vl-models" id="vl-models-section">
      <h3 className="vl-settings__section-title">{t('models.section')}</h3>

      {loading && items.length === 0 && <Spinner />}

      {error && items.length === 0 && (
        <div className="vl-models__load-error">
          <p role="alert">{t('models.error', { message: error })}</p>
          <button type="button" onClick={() => void load()}>
            {t('models.retry')}
          </button>
        </div>
      )}

      {items.length > 0 && (
        <p className="vl-models__total">
          {t('models.installedTotal', { size: formatBytes(totalInstalledBytes) })}
        </p>
      )}

      {GROUPS.map((group) => {
        const groupItems = items.filter((item) => item.kind === group.kind);
        if (groupItems.length === 0) return null;
        return (
          <div key={group.kind} className="vl-models__group" data-kind={group.kind}>
            <h4 className="vl-models__group-title">{t(group.labelKey)}</h4>
            <ul className="vl-models__list">{groupItems.map(renderModel)}</ul>
          </div>
        );
      })}

      <div className="vl-models__settings">
        <label className="vl-settings__field">
          <span>{t('models.endpoint')}</span>
          <input
            type="url"
            value={endpointDraft}
            placeholder="https://huggingface.co"
            disabled={!endpointLoaded}
            onChange={(event) => setEndpointDraft(event.target.value)}
            onBlur={saveEndpoint}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                saveEndpoint();
              }
            }}
          />
        </label>
        <p className="vl-settings__hint">
          {t('models.endpointHint')}
        </p>
        <label className="vl-models__check">
          <input
            type="checkbox"
            checked={offline}
            onChange={(event) => void setOffline(event.target.checked)}
          />
          {t('models.offline')}
        </label>
      </div>

      <div className="vl-settings__row vl-models__footer">
        <button
          type="button"
          disabled={!modelsDir}
          title={modelsDir || undefined}
          onClick={() => {
            if (modelsDir) void vl().revealInExplorer(modelsDir);
          }}
        >
          {t('models.openDir')}
        </button>
      </div>
      <p className="vl-settings__hint">{t('models.importHint')}</p>

      <p className="sr-only" aria-live="polite">
        {items
          .filter((item) => isActive(item.status))
          .map((item) => `${item.label}: ${statusText(item) ?? ''}`)
          .join('. ')}
      </p>

      {removeTarget && (
        <ConfirmDialog
          title={t('models.delete')}
          message={t('models.deleteConfirm', {
            label: removeTarget.label,
            size: formatBytes(removeTarget.size_bytes),
          })}
          confirmLabel={t('common.delete')}
          danger
          onConfirm={() => {
            const target = removeTarget;
            setRemoveTarget(null);
            void remove(target.id);
          }}
          onCancel={() => setRemoveTarget(null)}
        />
      )}
    </section>
  );
}
