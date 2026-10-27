import { useCallback, useEffect, useMemo, useState } from 'react';

import { api } from '../../api/client';
import type { ModelInfo, SettingsValues } from '../../api/types';
import { t } from '../../lib/i18n';
import { useSummaryStore } from '../../state/summaryStore';
import { Spinner } from '../ui/Spinner';
import './SummarySettings.css';

/**
 * Секция «Саммари» для `SettingsDialog` (M14, plans/14 §3 D-14.1/D-14.8, §6).
 *
 * Сам диалог не правится: Lead встраивает `<SummarySettings />` внутрь
 * `.vl-settings__body`, например новой секцией после «Моделей»:
 *
 * ```tsx
 * <section className="vl-settings__section">
 *   <h3 className="vl-settings__section-title">{t('settings.summarySection')}</h3>
 *   <SummarySettings onOpenModels={() => document.getElementById('vl-models-section')?.scrollIntoView()} />
 * </section>
 * ```
 *
 * Выбор модели (`summary.model`) — только из установленных моделей `kind:"summary"`;
 * обе модели (KoarAI — рекомендуемая, Qwen — альтернатива) показываются всегда.
 * Если ни одна не установлена, кнопка «Модели» вызывает `onOpenModels` (Lead передаёт
 * обработчик перехода к разделу моделей; без него кнопка неактивна).
 */
export interface SummarySettingsProps {
  className?: string;
  /** Перейти к разделу «Модели» (скачивание/импорт). Не задан — кнопка неактивна. */
  onOpenModels?: () => void;
}

const THINKING_LABELS = { auto: t('summary.thinkingAuto'), off: t('summary.thinkingOff') } as const;
const THINKING_HINTS = {
  auto: t('summary.thinkingAutoHint'),
  off: t('summary.thinkingOffHint'),
} as const;
const NO_MODEL_HINT = t('summary.noModelHint');

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function boolValue(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 0 || value === '0' || value === 'false') return false;
  if (value === 1 || value === '1' || value === 'true') return true;
  return fallback;
}

function modelLabel(model: ModelInfo): string {
  return model.label || model.id;
}

function modelBadge(model: ModelInfo): string {
  return model.recommended ? t('models.recommended') : t('models.alternative');
}

export function SummarySettings({ className, onOpenModels }: SummarySettingsProps): JSX.Element {
  const [values, setValues] = useState<SettingsValues>({});
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const summaryModels = useMemo(() => models.filter((model) => model.kind === 'summary'), [models]);
  const installedModels = useMemo(() => summaryModels.filter((model) => model.installed), [summaryModels]);
  const defaultModelId = useMemo(
    () => summaryModels.find((model) => model.default)?.id ?? installedModels[0]?.id ?? '',
    [installedModels, summaryModels],
  );
  const selectedModelId = String(values['summary.model'] ?? defaultModelId);
  const selectedModel = summaryModels.find((model) => model.id === selectedModelId) ?? null;
  const thinking = String(values['summary.thinking'] ?? 'auto') === 'off' ? 'off' : 'auto';
  const enabled = boolValue(values['summary.enabled'], true);
  const auto = boolValue(values['summary.auto'], true);
  const supportsThinking = selectedModel ? selectedModel.meta['supports_thinking'] !== false : true;

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const [settings, modelList] = await Promise.all([api.getSettings(), api.models()]);
      setValues(settings);
      setModels(modelList.items);
    } catch (loadError) {
      setError(errorText(loadError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const patch = async (partial: SettingsValues): Promise<void> => {
    const previous = values;
    setValues((current) => ({ ...current, ...partial }));
    setBusy(true);
    setError(null);
    try {
      const full = await api.patchSettings(partial);
      setValues(full);
      await useSummaryStore.getState().loadSettings(true);
      if (partial['summary.model'] !== undefined || partial['summary.thinking'] !== undefined) {
        void useSummaryStore.getState().reload();
      }
    } catch (patchError) {
      setValues(previous);
      setError(errorText(patchError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`vl-summary-settings${className ? ` ${className}` : ''}`}>
      {loading && (
        <div className="vl-summary-settings__status">
          <Spinner compact />
        </div>
      )}

      {!loading && error && (
        <div className="vl-summary-settings__status">
          <p className="vl-settings__hint">{t('models.error', { message: error })}</p>
          <button type="button" onClick={() => void load()}>
            {t('models.retry')}
          </button>
        </div>
      )}

      {!loading && !error && (
        <>
          <label className="vl-settings__field">
            <span>{t('settings.summaryModel')}</span>
            <select
              value={selectedModelId}
              disabled={busy || installedModels.length === 0}
              onChange={(event) => void patch({ 'summary.model': event.target.value })}
            >
              {summaryModels.length === 0 && <option value="">—</option>}
              {summaryModels.map((model) => (
                <option key={model.id} value={model.id} disabled={!model.installed}>
                  {modelLabel(model)} — {modelBadge(model)}
                  {model.installed ? '' : ` (${t('models.download').toLowerCase()})`}
                </option>
              ))}
            </select>
          </label>
          <p className="vl-settings__hint">{t('settings.summaryHint')}</p>

          <ul className="vl-summary-settings__models" aria-label={t('models.groupSummary')}>
            {summaryModels.map((model) => (
              <li key={model.id} className="vl-summary-settings__model">
                <span className="vl-summary-settings__model-label">{modelLabel(model)}</span>
                <span
                  className={`vl-summary-settings__badge${
                    model.recommended ? ' is-recommended' : ' is-alternative'
                  }`}
                >
                  {modelBadge(model)}
                </span>
                <span
                  className={`vl-summary-settings__state${model.installed ? ' is-installed' : ''}`}
                >
                  {model.installed ? t('models.installed') : t('models.download')}
                </span>
              </li>
            ))}
            {summaryModels.length === 0 && <li className="vl-summary-settings__model">{t('summary.modelMissing')}</li>}
          </ul>

          {installedModels.length === 0 && (
            <div className="vl-summary-settings__cta">
              <p className="vl-settings__hint">{NO_MODEL_HINT}</p>
              <button
                type="button"
                disabled={!onOpenModels}
                title={onOpenModels ? t('models.section') : undefined}
                onClick={() => onOpenModels?.()}
              >
                {t('models.section')}
              </button>
            </div>
          )}

          <label className="vl-settings__check">
            <input
              type="checkbox"
              checked={enabled}
              disabled={busy}
              onChange={(event) => void patch({ 'summary.enabled': event.target.checked })}
            />
            {t('settings.summaryEnabled')}
          </label>
          <label className="vl-settings__check">
            <input
              type="checkbox"
              checked={auto}
              disabled={busy}
              onChange={(event) => void patch({ 'summary.auto': event.target.checked })}
            />
            {t('settings.summaryAuto')}
          </label>

          <label className="vl-settings__field">
            <span>{t('settings.summaryThinking')}</span>
            <select
              value={thinking}
              disabled={busy}
              onChange={(event) => void patch({ 'summary.thinking': event.target.value })}
            >
              <option value="auto">{THINKING_LABELS.auto}</option>
              <option value="off">{THINKING_LABELS.off}</option>
            </select>
          </label>
          <p className="vl-settings__hint">
            {THINKING_HINTS[thinking]}
            {!supportsThinking && ' У выбранной модели нет режима рассуждений: «Авто» работает как «Выключено».'}
          </p>

          <div className="vl-settings__row">
            <button type="button" disabled={busy} onClick={() => void load()}>
              {t('models.update')}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
