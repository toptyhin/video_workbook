import { useCallback, useEffect, useRef, useState } from 'react';

import { mediaUrl } from '../../api/client';
import { vl } from '../../api/electron';
import type { Video } from '../../api/types';
import { useHotkeys } from '../../hooks/useHotkeys';
import { usePlaybackClock } from '../../hooks/usePlaybackClock';
import { STORAGE_KEYS } from '../../lib/constants';
import { t } from '../../lib/i18n';
import { clamp } from '../../lib/time';
import { readStorage, writeStorage } from '../../lib/storage';
import { usePlayerStore } from '../../state/playerStore';
import { useUIStore } from '../../state/uiStore';
import { VideoControls } from './VideoControls';
import './VideoPlayer.css';

/** Минимум данных о видео, нужный плееру (совместимо с `api/types.Video`). */
export type PlayerVideoInfo = Pick<
  Video,
  'id' | 'path' | 'title' | 'duration_ms' | 'status' | 'progress' | 'error'
>;

export interface VideoPlayerProps {
  videoId: number | null;
  video?: PlayerVideoInfo | null;
  /** Запасной обработчик «Показать в папке», если нет `video.path`. */
  onShowInFolder?: () => void;
  className?: string;
}

type VideoErrorKind = 'missing' | 'unsupported';

export function VideoPlayer({ videoId, video = null, onShowInFolder, className }: VideoPlayerProps): JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [volume, setVolume] = useState(() => clamp(readStorage<number>(STORAGE_KEYS.volume, 1), 0, 1));
  const [muted, setMuted] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [videoError, setVideoError] = useState<VideoErrorKind | null>(null);

  const loading = usePlayerStore((state) => state.loading);
  const playing = usePlayerStore((state) => state.playing);
  const positionMs = usePlayerStore((state) => state.positionMs);
  const durationMs = usePlayerStore((state) => state.durationMs);
  const storeStep = usePlayerStore((state) => state.step);
  const storeToggle = usePlayerStore((state) => state.toggle);

  usePlaybackClock(videoRef);
  // Глобальные клавиши плеера/меток (Space, ←/→, J/K/L, Ctrl+M, Delete, Ctrl+Z…).
  useHotkeys();

  useEffect(() => {
    setVideoError(null);
    const element = videoRef.current;
    if (videoId === null) {
      usePlayerStore.getState().reset();
      return;
    }
    void usePlayerStore.getState().load(videoId, true);
    if (element) {
      try {
        element.load();
      } catch {
        /* элемент ещё не смонтирован — браузер загрузит src сам */
      }
    }
  }, [videoId]);

  useEffect(() => {
    const element = videoRef.current;
    if (!element) return;
    element.volume = volume;
    element.muted = muted;
  }, [volume, muted]);

  useEffect(() => {
    const onChange = (): void => setFullscreen(document.fullscreenElement === containerRef.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const handleError = useCallback((): void => {
    const element = videoRef.current;
    const code = element?.error?.code;
    const kind: VideoErrorKind = code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED ? 'unsupported' : 'missing';
    setVideoError(kind);
    try {
      vl().log('error', `video ${videoId ?? '?'}: ${kind} (code ${code ?? 'n/a'})`);
    } catch {
      /* логирование не должно ломать UI */
    }
  }, [videoId]);

  const handleReveal = useCallback((): void => {
    try {
      if (video?.path) {
        void vl().revealInExplorer(video.path);
        return;
      }
      onShowInFolder?.();
    } catch (error) {
      useUIStore.getState().pushToast({
        kind: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, [onShowInFolder, video?.path]);

  const handleVolume = useCallback((next: number): void => {
    const value = clamp(next, 0, 1);
    setVolume(value);
    if (value > 0) setMuted(false);
    writeStorage(STORAGE_KEYS.volume, value);
  }, []);

  const toggleFullscreen = useCallback((): void => {
    const container = containerRef.current;
    if (!container) return;
    if (document.fullscreenElement) {
      const exit = document.exitFullscreen;
      if (typeof exit === 'function') void exit.call(document).catch(() => undefined);
      return;
    }
    const request = container.requestFullscreen;
    if (typeof request === 'function') {
      void request.call(container).catch(() => undefined);
    }
  }, []);

  return (
    <div ref={containerRef} className={`vl-player${className ? ` ${className}` : ''}`}>
      <div className="vl-player__stage">
        {/* Элемент <video> рендерится всегда: playback clock подписывается на него при монтировании. */}
        <video
          ref={videoRef}
          className="vl-player__video"
          src={videoId !== null ? mediaUrl(videoId, 'stream') : undefined}
          preload="metadata"
          playsInline
          onError={handleError}
          onLoadedMetadata={() => setVideoError(null)}
          aria-label={video?.title ?? (videoId !== null ? `#${videoId}` : t('player.noVideo'))}
        />
        {videoId === null && <div className="vl-player__overlay">{t('player.noVideo')}</div>}
        {videoId !== null && loading && !videoError && (
          <div className="vl-player__overlay">{t('timings.loading')}</div>
        )}
        {videoId !== null && videoError && (
          <div className="vl-player__overlay vl-player__overlay--error" role="alert">
            <p className="vl-player__overlay-text">
              {videoError === 'missing' ? t('player.fileMissing') : t('player.unsupported')}
            </p>
            {(video?.path || onShowInFolder) && (
              <button type="button" onClick={handleReveal}>
                {t('player.showInFolder')}
              </button>
            )}
          </div>
        )}
      </div>
      <VideoControls
        playing={playing}
        positionMs={positionMs}
        durationMs={durationMs}
        volume={volume}
        muted={muted}
        fullscreen={fullscreen}
        onTogglePlay={storeToggle}
        onStep={storeStep}
        onVolumeChange={handleVolume}
        onToggleMute={() => setMuted((value) => !value)}
        onToggleFullscreen={toggleFullscreen}
      />
    </div>
  );
}
