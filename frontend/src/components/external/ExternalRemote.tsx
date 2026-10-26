import { mediaUrl } from '../../api/client';
import { t } from '../../lib/i18n';
import { formatTimecode } from '../../lib/time';
import { useExternalStore } from '../../state/externalStore';
import './ExternalRemote.css';

export interface ExternalRemoteProps {
  videoId: number;
  title: string | null;
}

/** «Пульт» внешнего плеера (V3): живое время, управление и переход по позиции. */
export function ExternalRemote({ videoId, title }: ExternalRemoteProps): JSX.Element | null {
  const status = useExternalStore((state) => state.status);
  const session = status.active ? status.session : null;
  if (!session || session.video_id !== videoId) return null;
  const position = session.sync ? session.position_ms : session.start_ms;
  const duration = session.duration_ms || 0;
  const percent = duration > 0 ? Math.min(100, (position / duration) * 100) : 0;

  const seek = (ms: number): void => {
    void useExternalStore.getState().seek(Math.max(0, ms));
  };

  return (
    <div className="vl-external" role="region" aria-label={t('external.title')}>
      <div className="vl-external__backdrop">
        <img className="vl-external__poster" src={mediaUrl(videoId, 'thumb')} alt="" />
        <div className="vl-external__scrim" />
        <div className="vl-external__status">
          <span className={`vl-external__badge${session.sync ? ' is-sync' : ''}`}>
            {session.player_label} · {session.sync ? t('external.syncOn') : t('external.syncOff')}
          </span>
          <p className="vl-external__title">{title ?? t('external.title')}</p>
          <p className="vl-external__hint">
            {session.sync ? t('external.syncHint') : t('external.noSyncHint')}
          </p>
          <button
            type="button"
            className="primary"
            onClick={() => useExternalStore.getState().openLaunch(videoId, position)}
          >
            {t('external.openTitle')}
          </button>
        </div>
      </div>
      <div className="vl-external__controls" role="toolbar" aria-label={t('external.title')}>
        <button type="button" onClick={() => seek(position - 5000)} aria-label={t('external.seekBack')}>
          {t('external.seekBack')}
        </button>
        <button
          type="button"
          className="vl-external__play"
          onClick={() => void useExternalStore.getState().toggle()}
          aria-label={session.paused ? t('external.play') : t('external.pause')}
        >
          {session.paused ? '▶' : '❚❚'}
        </button>
        <button type="button" onClick={() => seek(position + 5000)} aria-label={t('external.seekForward')}>
          {t('external.seekForward')}
        </button>
        <span className="vl-external__time" aria-live="off">
          {formatTimecode(position)} <span className="vl-external__divider">/</span>{' '}
          {formatTimecode(duration)}
        </span>
        <div className="vl-external__progress" aria-hidden="true">
          <div className="vl-external__progress-fill" style={{ width: `${percent}%` }} />
        </div>
        <label className="vl-external__volume">
          <span className="sr-only">{t('player.volume')}</span>
          <input
            type="range"
            min={0}
            max={100}
            value={Math.round(session.volume)}
            disabled={!session.sync}
            onChange={(event) => void useExternalStore.getState().setVolume(Number(event.target.value))}
            aria-label={t('player.volume')}
          />
        </label>
        <button
          type="button"
          className="vl-external__stop"
          onClick={() => void useExternalStore.getState().stop()}
          title={t('external.stop')}
        >
          {t('external.stop')}
        </button>
      </div>
    </div>
  );
}
