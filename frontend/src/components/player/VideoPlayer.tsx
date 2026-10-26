import { useCallback, useEffect, useRef, useState } from 'react';

import { api, mediaUrl } from '../../api/client';
import { vl } from '../../api/electron';
import type { PlaybackInfo, Video } from '../../api/types';
import { useHotkeys } from '../../hooks/useHotkeys';
import { usePlaybackClock } from '../../hooks/usePlaybackClock';
import { STORAGE_KEYS } from '../../lib/constants';
import { t } from '../../lib/i18n';
import { readStorage, writeStorage } from '../../lib/storage';
import { clamp } from '../../lib/time';
import { useExternalStore } from '../../state/externalStore';
import { usePlayerStore } from '../../state/playerStore';
import { useUIStore } from '../../state/uiStore';
import { ExternalRemote } from '../external/ExternalRemote';
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

interface ExternalCta {
  detail: string | null;
  mode: string;
}

const POLL_INTERVAL_MS = 1200;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function VideoPlayer({ videoId, video = null, onShowInFolder, className }: VideoPlayerProps): JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const pollTimer = useRef<number | undefined>(undefined);
  const [volume, setVolume] = useState(() => clamp(readStorage<number>(STORAGE_KEYS.volume, 1), 0, 1));
  const [muted, setMuted] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [videoError, setVideoError] = useState<VideoErrorKind | null>(null);
  const [playback, setPlayback] = useState<PlaybackInfo | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [src, setSrc] = useState<string | undefined>(undefined);
  const [retryTick, setRetryTick] = useState(0);
  const [externalCta, setExternalCta] = useState<ExternalCta | null>(null);
  const transcodeChosen = useRef(false);
  const autoLaunched = useRef<number | null>(null);
  const wasExternal = useRef(false);

  const loading = usePlayerStore((state) => state.loading);
  const playing = usePlayerStore((state) => state.playing);
  const positionMs = usePlayerStore((state) => state.positionMs);
  const durationMs = usePlayerStore((state) => state.durationMs);
  const storeStep = usePlayerStore((state) => state.step);
  const storeToggle = usePlayerStore((state) => state.toggle);

  const externalActive = useExternalStore((state) => state.isActiveFor(videoId));
  usePlaybackClock(videoRef, !externalActive);
  // Глобальные клавиши плеера/меток (Space, ←/→, J/K/L, Ctrl+M, Delete, Ctrl+Z…).
  useHotkeys();

  useEffect(() => {
    setVideoError(null);
    setPreviewError(null);
    setPlayback(null);
    setSrc(undefined);
    setExternalCta(null);
    transcodeChosen.current = false;
    if (pollTimer.current) {
      window.clearTimeout(pollTimer.current);
      pollTimer.current = undefined;
    }
    if (videoId === null) {
      usePlayerStore.getState().reset();
      return;
    }
    void usePlayerStore.getState().load(videoId, true);

    let cancelled = false;
    let lastProgress = -1;

    const applyInfo = (info: PlaybackInfo): void => {
      if (cancelled) return;
      setPlayback(info);
      const external = useExternalStore.getState();
      if (external.isActiveFor(videoId)) return;
      if (info.mode === 'direct') {
        setSrc(mediaUrl(videoId, 'stream'));
        return;
      }
      if (info.mode === 'unsupported' || info.state === 'error') {
        setPreviewError(info.error ?? t('player.unsupported'));
        return;
      }
      if (external.policy !== 'never' && !transcodeChosen.current) {
        const configured = external.players.find((item) => item.id === external.configured);
        if (external.policy === 'always' && configured?.available && autoLaunched.current !== videoId) {
          autoLaunched.current = videoId;
          external.openLaunch(videoId, 0);
          void external.launch({ startMs: 0 });
          return;
        }
        setExternalCta({ detail: info.detail, mode: info.mode });
        return;
      }
      if (info.state === 'ready') {
        setSrc(mediaUrl(videoId, 'preview'));
        return;
      }
      if (info.state === 'idle') {
        void api
          .preparePreview(videoId)
          .then((next) => applyInfo(next))
          .catch((error: unknown) => {
            if (!cancelled) setPreviewError(errorText(error));
          });
        return;
      }
      if (Math.abs(info.progress - lastProgress) > 0.005) {
        lastProgress = info.progress;
      }
      poll();
    };

    const poll = (): void => {
      if (cancelled) return;
      pollTimer.current = window.setTimeout(() => {
        if (cancelled) return;
        void api
          .playback(videoId)
          .then((info) => applyInfo(info))
          .catch((error: unknown) => {
            if (!cancelled) setPreviewError(errorText(error));
          });
      }, POLL_INTERVAL_MS);
    };

    void api
      .playback(videoId)
      .then((info) => applyInfo(info))
      // Если /playback недоступен, пробуем прямой поток (совместимые файлы).
      .catch(() => setSrc(mediaUrl(videoId, 'stream')));

    return () => {
      cancelled = true;
      if (pollTimer.current) {
        window.clearTimeout(pollTimer.current);
        pollTimer.current = undefined;
      }
    };
  }, [videoId, retryTick]);

  // Внешний плеер закрылся — возвращаемся к обычному превью
  useEffect(() => {
    if (externalActive) {
      wasExternal.current = true;
      return;
    }
    if (wasExternal.current && videoId !== null) {
      wasExternal.current = false;
      setRetryTick((value) => value + 1);
    }
  }, [externalActive, videoId]);

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
    if (src?.includes('/preview')) {
      setPreviewError(t('player.previewFailed', { message: code ? `code ${code}` : 'decode error' }));
      return;
    }
    const kind: VideoErrorKind = code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED ? 'unsupported' : 'missing';
    setVideoError(kind);
    try {
      vl().log('error', `video ${videoId ?? '?'}: ${kind} (code ${code ?? 'n/a'})`);
    } catch {
      /* логирование не должно ломать UI */
    }
  }, [src, videoId]);

  const handleMetadata = useCallback((): void => {
    setVideoError(null);
    if (src?.includes('/preview')) setPreviewError(null);
  }, [src]);

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
        message: errorText(error),
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

  const preparing =
    playback !== null && playback.mode !== 'direct' && (playback.state === 'queued' || playback.state === 'preparing');
  const percent = Math.round((playback?.progress ?? 0) * 100);
  const previewFailed = previewError ?? (playback?.state === 'error' ? playback.error : null);

  if (externalActive && videoId !== null) {
    return (
      <div ref={containerRef} className={`vl-player vl-player--external${className ? ` ${className}` : ''}`}>
        <ExternalRemote videoId={videoId} title={video?.title ?? null} />
      </div>
    );
  }

  return (
    <div ref={containerRef} className={`vl-player${className ? ` ${className}` : ''}`}>
      <div className="vl-player__stage">
        {/* Элемент <video> рендерится всегда: playback clock подписывается на него при монтировании. */}
        <video
          ref={videoRef}
          className="vl-player__video"
          src={src}
          preload="metadata"
          playsInline
          onError={handleError}
          onLoadedMetadata={handleMetadata}
          aria-label={video?.title ?? (videoId !== null ? `#${videoId}` : t('player.noVideo'))}
        />
        {videoId === null && <div className="vl-player__overlay">{t('player.noVideo')}</div>}
        {videoId !== null && preparing && (
          <div className="vl-player__overlay vl-player__overlay--preview" role="status" aria-live="polite">
            <p className="vl-player__overlay-text">
              {t('player.previewProgress', { percent })}
            </p>
            <div className="vl-player__preview-bar" aria-hidden="true">
              <div className="vl-player__preview-bar-fill" style={{ width: `${percent}%` }} />
            </div>
            {playback?.detail && (
              <p className="vl-player__overlay-hint">{t('player.previewDetail', { detail: playback.detail })}</p>
            )}
          </div>
        )}
        {videoId !== null && !preparing && previewFailed && (
          <div className="vl-player__overlay vl-player__overlay--error" role="alert">
            <p className="vl-player__overlay-text">{t('player.previewFailed', { message: previewFailed })}</p>
            <div className="vl-player__overlay-actions">
              <button type="button" onClick={() => setRetryTick((value) => value + 1)}>
                {t('player.previewRetry')}
              </button>
              {(video?.path || onShowInFolder) && (
                <button type="button" onClick={handleReveal}>
                  {t('player.showInFolder')}
                </button>
              )}
            </div>
          </div>
        )}
        {videoId !== null && externalCta && !preparing && !previewFailed && !videoError && (
          <div className="vl-player__overlay vl-player__overlay--external" role="alert">
            <p className="vl-player__overlay-text">{t('external.ctaTitle')}</p>
            <p className="vl-player__overlay-hint">
              {t('external.ctaHint', { detail: externalCta.detail ?? externalCta.mode })}
            </p>
            <div className="vl-player__overlay-actions">
              <button
                type="button"
                className="primary"
                onClick={() => useExternalStore.getState().openLaunch(videoId as number, positionMs)}
              >
                {t('external.openTitle')}
              </button>
              <button
                type="button"
                onClick={() => {
                  transcodeChosen.current = true;
                  setExternalCta(null);
                  setRetryTick((value) => value + 1);
                }}
              >
                {t('external.convert')}
              </button>
              {(video?.path || onShowInFolder) && (
                <button type="button" onClick={handleReveal}>
                  {t('player.showInFolder')}
                </button>
              )}
            </div>
          </div>
        )}
        {videoId !== null && !preparing && !previewFailed && videoError && (
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
        {videoId !== null && !externalCta && !videoError && (
          <button
            type="button"
            className="vl-player__external-button"
            title={t('external.openTitle')}
            onClick={() => useExternalStore.getState().openLaunch(videoId as number, positionMs)}
          >
            {t('external.open')}
          </button>
        )}
        {videoId !== null && loading && !videoError && !preparing && !previewFailed && !src && (
          <div className="vl-player__overlay">{t('timings.loading')}</div>
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
