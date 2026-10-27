import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../../api/client';
import { formatBytes } from '../../lib/format';
import { t } from '../../lib/i18n';
import { formatElapsed } from '../../lib/recording';
import { useLibraryStore } from '../../state/libraryStore';
import { useRecordStore } from '../../state/recordStore';
import { useUIStore } from '../../state/uiStore';
import { Spinner } from '../ui/Spinner';
import './RecorderBar.css';

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Плавающая панель активной записи: таймер, пауза, сохранение и отмена.
 * Видна при `preparing/recording/paused/finalizing/error`, портал в `document.body`.
 */
export function RecorderBar(): JSX.Element | null {
  const status = useRecordStore((state) => state.status);
  const error = useRecordStore((state) => state.error);
  const elapsedMs = useRecordStore((state) => state.elapsedMs);
  const bytesSent = useRecordStore((state) => state.bytesSent);
  const sources = useRecordStore((state) => state.sources);
  const selectedSourceId = useRecordStore((state) => state.selectedSourceId);
  const audioMode = useRecordStore((state) => state.audioMode);
  const capabilities = useRecordStore((state) => state.capabilities);

  const pause = useRecordStore((state) => state.pause);
  const resume = useRecordStore((state) => state.resume);
  const stop = useRecordStore((state) => state.stop);
  const cancel = useRecordStore((state) => state.cancel);

  const [confirmCancel, setConfirmCancel] = useState(false);
  const stoppingRef = useRef(false);

  const active =
    status === 'preparing' ||
    status === 'recording' ||
    status === 'paused' ||
    status === 'finalizing' ||
    status === 'error';
  const captureActive =
    status === 'preparing' ||
    status === 'recording' ||
    status === 'paused' ||
    status === 'finalizing';

  // Предупреждение при закрытии окна, пока идёт захват.
  useEffect(() => {
    if (!captureActive) return;
    const handleBeforeUnload = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      event.returnValue = t('recording.leaveWarning');
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [captureActive]);

  // Подтверждение отмены актуально только для активной записи.
  useEffect(() => {
    if (status !== 'recording' && status !== 'paused') setConfirmCancel(false);
  }, [status]);

  if (!active) return null;

  const sourceName =
    sources.find((source) => source.id === selectedSourceId)?.name ?? t('recording.sourceUnknown');
  const stateLabel =
    status === 'preparing'
      ? t('recording.barPreparing')
      : status === 'paused'
        ? t('recording.barPaused')
        : status === 'finalizing'
          ? t('recording.barFinalizing')
          : status === 'error'
            ? t('recording.barError')
            : t('recording.barRecording');
  const canControl = status === 'recording' || status === 'paused';
  const systemAudioWarning =
    audioMode === 'mic_system' &&
    capabilities !== null &&
    !capabilities.system_audio.available;
  const className = [
    'vl-recorder',
    status === 'recording' ? 'is-recording' : '',
    status === 'paused' ? 'is-paused' : '',
    status === 'finalizing' ? 'is-finalizing' : '',
    status === 'error' ? 'is-error' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const handlePauseToggle = (): void => {
    if (status === 'paused') void resume();
    else void pause();
  };

  const handleCancel = async (): Promise<void> => {
    setConfirmCancel(false);
    await cancel();
  };

  const handleSave = async (): Promise<void> => {
    if (stoppingRef.current) return;
    stoppingRef.current = true;
    try {
      const result = await stop();
      if (!result) {
        // В состоянии error панель сама показывает причину; тост — только если панель уже скрылась.
        const state = useRecordStore.getState();
        if (state.status === 'idle') {
          useUIStore.getState().pushToast({
            kind: 'error',
            message: t('toast.error', { message: state.error ?? t('recording.saveFailed') }),
          });
        }
        return;
      }
      void useLibraryStore.getState().refresh();
      useUIStore.getState().pushToast({
        kind: 'success',
        message: t('recording.saved', { title: result.title }),
        action: {
          label: t('recording.process'),
          run: () => {
            void api.enqueue([result.videoId]).catch((enqueueError: unknown) => {
              useUIStore.getState().pushToast({
                kind: 'error',
                message: t('toast.error', { message: errorText(enqueueError) }),
              });
            });
          },
        },
      });
      window.dispatchEvent(new CustomEvent('vl:open', { detail: { videoId: result.videoId } }));
    } finally {
      stoppingRef.current = false;
    }
  };

  return createPortal(
    <div className={className}>
      {status === 'finalizing' ? (
        <Spinner compact size={18} label={t('recording.barFinalizing')} />
      ) : (
        <div className="vl-recorder__pulse" aria-hidden="true">
          <span className="vl-recorder__dot" />
        </div>
      )}

      <div className="vl-recorder__main" role="status" aria-live="polite">
        <div className="vl-recorder__line">
          <span className="vl-recorder__state">{stateLabel}</span>
          <span className="vl-recorder__timer" aria-label={t('recording.elapsed')}>
            {formatElapsed(elapsedMs)}
          </span>
        </div>
        <div className="vl-recorder__meta">
          <span className="vl-recorder__source" title={sourceName}>
            {sourceName}
          </span>
          <span className="vl-recorder__sep" aria-hidden="true">
            ·
          </span>
          <span className="vl-recorder__size" title={t('recording.size')}>
            {formatBytes(bytesSent)}
          </span>
        </div>
        {error && (
          <p className="vl-recorder__error" role="alert">
            {error}
          </p>
        )}
        {systemAudioWarning && status !== 'error' && (
          <div className="vl-recorder__warn">{t('recording.systemAudioFallback')}</div>
        )}
      </div>

      {canControl && (
        <div className="vl-recorder__actions">
          {confirmCancel ? (
            <div className="vl-recorder__confirm" role="group" aria-label={t('recording.discard')}>
              <span className="vl-recorder__confirm-text">{t('recording.cancelConfirm')}</span>
              <button type="button" onClick={() => setConfirmCancel(false)}>
                {t('recording.keep')}
              </button>
              <button
                type="button"
                className="vl-recorder__discard"
                onClick={() => void handleCancel()}
              >
                {t('recording.discard')}
              </button>
            </div>
          ) : (
            <>
              <button type="button" onClick={handlePauseToggle}>
                {status === 'paused' ? t('recording.resume') : t('recording.pause')}
              </button>
              <button type="button" className="vl-recorder__save" onClick={() => void handleSave()}>
                {t('recording.save')}
              </button>
              <button
                type="button"
                className="vl-recorder__cancel"
                onClick={() => setConfirmCancel(true)}
              >
                {t('recording.cancel')}
              </button>
            </>
          )}
        </div>
      )}

      {status === 'error' && (
        <div className="vl-recorder__actions">
          <button type="button" className="vl-recorder__cancel" onClick={() => void handleCancel()}>
            {t('recording.cancel')}
          </button>
        </div>
      )}
    </div>,
    document.body,
  );
}
