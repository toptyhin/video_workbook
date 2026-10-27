import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { isCaptureAvailable } from '../../api/electron';
import type { CaptureSource } from '../../api/types';
import { t } from '../../lib/i18n';
import {
  RECORDING_QUALITIES,
  RECORDING_QUALITY_PRESETS,
  approxSizeMbPerMin,
} from '../../lib/recording';
import type { RecordingAudioMode, RecordingQuality } from '../../lib/recording';
import { useRecordStore } from '../../state/recordStore';
import { Spinner } from '../ui/Spinner';
import './RecordDialog.css';

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

type SourceTab = 'screen' | 'window';

const TABS: { value: SourceTab; labelKey: string }[] = [
  { value: 'screen', labelKey: 'recording.tabScreen' },
  { value: 'window', labelKey: 'recording.tabWindow' },
];

/** Миниатюра источника: при битой data URL показываем заглушку. */
function SourceThumb({ source }: { source: CaptureSource }): JSX.Element {
  const [failed, setFailed] = useState(false);
  const showImage = Boolean(source.thumbnail_data_url) && !failed;
  return (
    <span className="vl-record__thumb">
      {showImage ? (
        <img
          src={source.thumbnail_data_url}
          alt=""
          loading="lazy"
          draggable={false}
          onError={() => setFailed(true)}
        />
      ) : (
        <span className="vl-record__thumb-fallback" aria-hidden="true">
          {source.type === 'screen' ? '▭' : '❐'}
        </span>
      )}
    </span>
  );
}

/**
 * Модальный диалог записи экрана: выбор источника (экран/окно), звука, качества
 * и названия. По паттерну `SettingsDialog`: портал, ловушка фокуса, `Esc`.
 */
export function RecordDialog(): JSX.Element | null {
  const open = useRecordStore((state) => state.dialogOpen);
  const status = useRecordStore((state) => state.status);
  const error = useRecordStore((state) => state.error);
  const sources = useRecordStore((state) => state.sources);
  const sourcesLoading = useRecordStore((state) => state.sourcesLoading);
  const capabilities = useRecordStore((state) => state.capabilities);
  const audioInputs = useRecordStore((state) => state.audioInputs);
  const selectedSourceId = useRecordStore((state) => state.selectedSourceId);
  const audioMode = useRecordStore((state) => state.audioMode);
  const micDeviceId = useRecordStore((state) => state.micDeviceId);
  const quality = useRecordStore((state) => state.quality);
  const title = useRecordStore((state) => state.title);

  const closeDialog = useRecordStore((state) => state.closeDialog);
  const loadSources = useRecordStore((state) => state.loadSources);
  const setSelectedSource = useRecordStore((state) => state.setSelectedSource);
  const setAudioMode = useRecordStore((state) => state.setAudioMode);
  const setMicDeviceId = useRecordStore((state) => state.setMicDeviceId);
  const setQuality = useRecordStore((state) => state.setQuality);
  const setTitle = useRecordStore((state) => state.setTitle);
  const start = useRecordStore((state) => state.start);

  const [tab, setTab] = useState<SourceTab>('screen');
  const dialogRef = useRef<HTMLDivElement>(null);
  const blockEscapeRef = useRef(false);
  const titleId = useId();
  const hintId = useId();

  const busy = status === 'preparing';
  blockEscapeRef.current = busy;

  const close = (): void => {
    const state = useRecordStore.getState();
    if (state.status === 'preparing') return;
    // Ошибка запуска относится только к попытке в диалоге — сбрасываем при закрытии,
    // чтобы не оставлять «повисшую» панель записи.
    if (state.status === 'error') state.reset();
    state.closeDialog();
  };
  const closeRef = useRef(close);
  closeRef.current = close;

  // При открытии: вкладка по выбранному источнику.
  useEffect(() => {
    if (!open) return;
    const state = useRecordStore.getState();
    const selected = state.sources.find((source) => source.id === state.selectedSourceId);
    setTab(selected?.type ?? 'screen');
  }, [open]);

  // Успешный старт (status меняется на recording) закрывает диалог.
  useEffect(() => {
    if (!open) return;
    if (status === 'recording' || status === 'paused') closeDialog();
  }, [open, status, closeDialog]);

  // Фокус-ловушка, Esc, возврат фокуса.
  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (blockEscapeRef.current) return;
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
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
  }, [open]);

  const micAvailable = audioInputs.length > 0;
  const systemAvailable = capabilities?.system_audio.available ?? false;
  const systemDetail = capabilities?.system_audio.detail ?? null;

  // Разумный дефолт, если сохранённый режим стал недоступен: микрофон → системный → без звука.
  useEffect(() => {
    if (!open || capabilities === null) return;
    const needsMic = audioMode === 'mic' || audioMode === 'mic_system';
    const needsSystem = audioMode === 'system' || audioMode === 'mic_system';
    if ((needsMic && !micAvailable) || (needsSystem && !systemAvailable)) {
      setAudioMode(micAvailable ? 'mic' : systemAvailable ? 'system' : 'none');
    }
  }, [open, capabilities, micAvailable, systemAvailable, audioMode, setAudioMode]);

  if (!open) return null;

  const visibleSources = sources.filter((source) => source.type === tab);
  const electronAvailable = isCaptureAvailable();
  const unavailable = !electronAvailable && !sourcesLoading && sources.length === 0;

  const audioOptions: {
    value: RecordingAudioMode;
    label: string;
    disabled: boolean;
    note?: string;
  }[] = [
    { value: 'none', label: t('recording.audioNone'), disabled: false },
    {
      value: 'mic',
      label: t('recording.audioMic'),
      disabled: !micAvailable,
      note: micAvailable ? undefined : t('recording.micMissingShort'),
    },
    {
      value: 'system',
      label: t('recording.audioSystem'),
      disabled: !systemAvailable,
      note: systemAvailable ? undefined : t('recording.unavailableShort'),
    },
    {
      value: 'mic_system',
      label: t('recording.audioMicSystem'),
      disabled: !micAvailable || !systemAvailable,
      note: !systemAvailable
        ? t('recording.unavailableShort')
        : !micAvailable
          ? t('recording.micMissingShort')
          : undefined,
    },
  ];
  const micMode = audioMode === 'mic' || audioMode === 'mic_system';

  const handleStart = async (): Promise<void> => {
    if (!selectedSourceId || busy) return;
    await start();
    const state = useRecordStore.getState();
    if (state.status === 'recording' || state.status === 'paused') state.closeDialog();
  };

  const footerMessage = error
    ? t('toast.error', { message: error })
    : selectedSourceId
      ? null
      : t('recording.needSource');

  return createPortal(
    <div
      className="vl-record-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) close();
      }}
    >
      <div
        ref={dialogRef}
        className="vl-record"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={hintId}
        tabIndex={-1}
      >
        <header className="vl-record__header">
          <span className="vl-record__rec-chip" aria-hidden="true">
            REC
          </span>
          <div className="vl-record__heading">
            <h2 className="vl-record__title" id={titleId}>
              {t('recording.dialogTitle')}
            </h2>
            <p className="vl-record__subtitle" id={hintId}>
              {t('recording.dialogHint')}
            </p>
          </div>
          <button
            type="button"
            className="vl-record__close"
            aria-label={t('common.close')}
            title={t('common.close')}
            disabled={busy}
            onClick={close}
          >
            ×
          </button>
        </header>

        <div className="vl-record__body">
          <section className="vl-record__sources" aria-label={t('recording.sources')}>
            <div className="vl-record__sources-head">
              <div className="vl-record__tabs" role="tablist" aria-label={t('recording.selectSource')}>
                {TABS.map((item) => {
                  const count = sources.filter((source) => source.type === item.value).length;
                  return (
                    <button
                      key={item.value}
                      type="button"
                      role="tab"
                      aria-selected={tab === item.value}
                      className={`vl-record__tab${tab === item.value ? ' is-active' : ''}`}
                      onClick={() => setTab(item.value)}
                    >
                      {t(item.labelKey)}
                      {count > 0 && (
                        <span className="vl-record__tab-count" aria-hidden="true">
                          {count}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
              <button
                type="button"
                className={`vl-record__refresh${sourcesLoading ? ' is-spinning' : ''}`}
                aria-label={t('recording.refresh')}
                title={t('recording.refresh')}
                disabled={sourcesLoading}
                onClick={() => void loadSources()}
              >
                <svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6">
                  <path d="M13.5 8a5.5 5.5 0 1 1-1.7-3.97" strokeLinecap="round" />
                  <path d="M13.5 1.8v3.2h-3.2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <span>{t('recording.refresh')}</span>
              </button>
            </div>

            {unavailable ? (
              <div className="vl-record__sources-status vl-record__unavailable" role="note">
                <p className="vl-record__unavailable-title">{t('recording.unavailable')}</p>
              </div>
            ) : sourcesLoading && visibleSources.length === 0 ? (
              <div className="vl-record__sources-status">
                <Spinner label={t('recording.loadingSources')} />
              </div>
            ) : visibleSources.length === 0 ? (
              <div className="vl-record__sources-status">
                <p>
                  {tab === 'screen'
                    ? t('recording.sourcesEmptyScreen')
                    : t('recording.sourcesEmptyWindow')}
                </p>
                <button type="button" onClick={() => void loadSources()}>
                  {t('recording.refresh')}
                </button>
              </div>
            ) : (
              <div
                className="vl-record__grid-wrap"
                role="tabpanel"
                aria-label={tab === 'screen' ? t('recording.tabScreen') : t('recording.tabWindow')}
              >
                <ul
                  className="vl-record__grid"
                  role="radiogroup"
                  aria-label={t('recording.selectSource')}
                >
                  {visibleSources.map((source) => {
                    const selected = source.id === selectedSourceId;
                    return (
                      <li key={source.id}>
                        <button
                          type="button"
                          role="radio"
                          aria-checked={selected}
                          className={`vl-record__card${selected ? ' is-selected' : ''}`}
                          onClick={() => setSelectedSource(source.id)}
                        >
                          <SourceThumb source={source} />
                          <span className="vl-record__card-name" title={source.name}>
                            {source.name}
                          </span>
                          {selected && (
                            <span className="vl-record__check" aria-hidden="true">
                              ✓
                            </span>
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </section>

          <section className="vl-record__settings">
            <fieldset className="vl-record__section">
              <legend className="vl-record__legend">{t('recording.audio')}</legend>
              <div className="vl-record__radios">
                {audioOptions.map((option) => (
                  <label
                    key={option.value}
                    className={[
                      'vl-record__radio',
                      audioMode === option.value ? 'is-selected' : '',
                      option.disabled ? 'is-disabled' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                  >
                    <input
                      type="radio"
                      name="vl-recording-audio"
                      value={option.value}
                      checked={audioMode === option.value}
                      disabled={option.disabled}
                      onChange={() => setAudioMode(option.value)}
                    />
                    <span className="vl-record__radio-text">
                      <span className="vl-record__radio-label">{option.label}</span>
                      {option.note && (
                        <span className="vl-record__radio-note">{option.note}</span>
                      )}
                    </span>
                  </label>
                ))}
              </div>
              {systemAvailable ? (
                <p className="vl-record__hint">{t('recording.systemAudioHint')}</p>
              ) : (
                <p className="vl-record__hint vl-record__hint--warn">
                  {systemDetail
                    ? t('recording.systemAudioUnavailable', { reason: systemDetail })
                    : t('recording.systemAudioUnavailableGeneric')}
                </p>
              )}
              {micMode && micAvailable && (
                <div className="vl-record__field vl-record__field--mic">
                  <label className="vl-record__field-label" htmlFor="vl-recording-mic">
                    {t('recording.micDevice')}
                  </label>
                  <select
                    id="vl-recording-mic"
                    value={micDeviceId ?? ''}
                    onChange={(event) =>
                      setMicDeviceId(event.target.value === '' ? null : event.target.value)
                    }
                  >
                    <option value="">{t('recording.micDefault')}</option>
                    {audioInputs.map((device, index) => (
                      <option key={device.device_id} value={device.device_id}>
                        {device.label || `${t('recording.audioMic')} ${index + 1}`}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </fieldset>

            <fieldset className="vl-record__section">
              <legend className="vl-record__legend">{t('recording.quality')}</legend>
              <div className="vl-record__field">
                <select
                  value={quality}
                  aria-label={t('recording.quality')}
                  onChange={(event) => setQuality(event.target.value as RecordingQuality)}
                >
                  {RECORDING_QUALITIES.map((value) => (
                    <option key={value} value={value}>
                      {t(RECORDING_QUALITY_PRESETS[value].labelKey)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="vl-record__quality-row">
                <span className="vl-record__size-pill">
                  {t('recording.sizePerMin', { size: approxSizeMbPerMin(quality) })}
                </span>
                <span className="vl-record__format-chip">{t('recording.formatNote')}</span>
              </div>
            </fieldset>

            <div className="vl-record__section">
              <div className="vl-record__field">
                <label className="vl-record__field-label" htmlFor="vl-recording-title">
                  {t('recording.title')}
                </label>
                <input
                  id="vl-recording-title"
                  type="text"
                  value={title}
                  maxLength={200}
                  placeholder={t('recording.titlePlaceholder')}
                  onChange={(event) => setTitle(event.target.value)}
                />
              </div>
            </div>

            <p className="vl-record__tip">{t('recording.dialogTip')}</p>
          </section>
        </div>

        <footer className="vl-record__footer">
          <div
            className={`vl-record__footer-status${error ? ' vl-record__footer-status--error' : ''}`}
            role={error ? 'alert' : undefined}
          >
            {footerMessage}
          </div>
          <div className="vl-record__footer-actions">
            <button type="button" disabled={busy} onClick={close}>
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="vl-record__start"
              disabled={!selectedSourceId || busy}
              onClick={() => void handleStart()}
            >
              {busy ? (
                <span className="vl-record__busy">
                  <Spinner compact size={13} label={t('recording.starting')} />
                  <span aria-hidden="true">{t('recording.starting')}</span>
                </span>
              ) : (
                <>
                  <span className="vl-record__start-dot" aria-hidden="true" />
                  <span>{t('recording.start')}</span>
                </>
              )}
            </button>
          </div>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
