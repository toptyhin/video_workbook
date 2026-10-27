import { useEffect, useRef } from 'react';

import { t } from '../../lib/i18n';
import { formatElapsed } from '../../lib/recording';
import { useRecordStore } from '../../state/recordStore';
import './RecordingPreview.css';

/**
 * Живой предпросмотр записываемого экрана/окна в основной панели видео.
 *
 * Используется тот же `MediaStream`, который кодирует MediaRecorder, поэтому
 * второй захват не создаётся. Звук всегда выключен (`muted`): иначе микрофон
 * попадёт в колонки и даст эхо; системный звук в потоке предпросмотра не участвует.
 */
export function RecordingPreview(): JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null);
  const stream = useRecordStore((state) => state.previewStream);
  const status = useRecordStore((state) => state.status);
  const elapsedMs = useRecordStore((state) => state.elapsedMs);
  const sourceName = useRecordStore((state) => {
    const selected = state.sources.find((source) => source.id === state.selectedSourceId);
    return selected?.name ?? null;
  });

  useEffect(() => {
    const element = videoRef.current;
    if (!element) return;
    try {
      element.srcObject = stream;
    } catch {
      /* среда без поддержки srcObject (jsdom) — предпросмотр остаётся тёмным */
    }
    if (stream) {
      try {
        const played = element.play?.();
        if (played && typeof played.catch === 'function') played.catch(() => undefined);
      } catch {
        /* autoplay может быть отклонён — кадр всё равно появится после жеста */
      }
    }
    return () => {
      try {
        element.srcObject = null;
      } catch {
        /* noop */
      }
    };
  }, [stream]);

  const paused = status === 'paused';
  const preparing = status === 'preparing';
  const finalizing = status === 'finalizing';

  return (
    <div
      className="vl-rec-preview"
      role="region"
      aria-label={t('recording.previewLabel')}
      data-status={status}
    >
      <video
        ref={videoRef}
        className="vl-rec-preview__video"
        aria-label={t('recording.previewLabel')}
        muted
        autoPlay
        playsInline
      />

      {!stream && (
        <div className="vl-rec-preview__placeholder">
          {preparing ? t('recording.barPreparing') : t('recording.previewWaiting')}
        </div>
      )}

      <div className={`vl-rec-preview__badge${paused ? ' is-paused' : ''}`}>
        <span className="vl-rec-preview__dot" aria-hidden="true" />
        <span>{paused ? t('recording.barPaused') : t('recording.barRecording')}</span>
      </div>

      <div className="vl-rec-preview__meta">
        <span className="vl-rec-preview__timer">{formatElapsed(elapsedMs)}</span>
        <span className="vl-rec-preview__source">{sourceName ?? t('recording.sourceUnknown')}</span>
      </div>

      {finalizing && (
        <div className="vl-rec-preview__overlay">{t('recording.barFinalizing')}</div>
      )}
    </div>
  );
}
