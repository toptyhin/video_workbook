import { t } from '../../lib/i18n';
import { clamp, formatTimecode } from '../../lib/time';
import './VideoControls.css';

export interface VideoControlsProps {
  playing: boolean;
  positionMs: number;
  durationMs: number;
  volume: number;
  muted: boolean;
  fullscreen: boolean;
  onTogglePlay: () => void;
  onStep: (deltaMs: number) => void;
  onVolumeChange: (volume: number) => void;
  onToggleMute: () => void;
  onToggleFullscreen: () => void;
}

const STEP_MS = 5000;

export function VideoControls(props: VideoControlsProps): JSX.Element {
  const {
    playing,
    positionMs,
    durationMs,
    volume,
    muted,
    fullscreen,
    onTogglePlay,
    onStep,
    onVolumeChange,
    onToggleMute,
    onToggleFullscreen,
  } = props;

  return (
    <div className="vl-controls" role="toolbar" aria-label={t('app.name')}>
      <button
        type="button"
        className="vl-controls__button vl-controls__button--play"
        aria-label={playing ? t('player.pause') : t('player.play')}
        title={playing ? t('player.pause') : t('player.play')}
        onClick={onTogglePlay}
      >
        {playing ? '❚❚' : '▶'}
      </button>
      <button
        type="button"
        className="vl-controls__button"
        aria-label={t('player.stepBack')}
        title={t('player.stepBack')}
        onClick={() => onStep(-STEP_MS)}
      >
        −5
      </button>
      <button
        type="button"
        className="vl-controls__button"
        aria-label={t('player.stepForward')}
        title={t('player.stepForward')}
        onClick={() => onStep(STEP_MS)}
      >
        +5
      </button>
      <span className="vl-controls__time" aria-live="off">
        <span className="vl-controls__time-current">{formatTimecode(positionMs)}</span>
        <span className="vl-controls__time-divider">/</span>
        <span className="vl-controls__time-total">{formatTimecode(durationMs)}</span>
      </span>
      <div className="vl-controls__spacer" />
      <button
        type="button"
        className="vl-controls__button"
        aria-label={muted ? t('player.unmute') : t('player.mute')}
        title={muted ? t('player.unmute') : t('player.mute')}
        onClick={onToggleMute}
      >
        {muted || volume === 0 ? '🔇' : '🔊'}
      </button>
      <input
        className="vl-controls__volume"
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={clamp(volume, 0, 1)}
        aria-label={t('player.volume')}
        onChange={(event) => onVolumeChange(clamp(Number(event.target.value), 0, 1))}
      />
      <button
        type="button"
        className="vl-controls__button"
        aria-label={t('player.fullscreen')}
        title={t('player.fullscreen')}
        aria-pressed={fullscreen}
        onClick={onToggleFullscreen}
      >
        {fullscreen ? '⤢' : '⛶'}
      </button>
    </div>
  );
}
