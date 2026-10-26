import { useEffect } from 'react';
import type { RefObject } from 'react';

import { usePlayerStore } from '../state/playerStore';

/**
 * Playback clock: позиция берётся только из `video.currentTime` (D4, `plans/05`),
 * публикуется в playerStore с троттлингом 4 Гц (250 мс), немедленно — на seeked/play/pause.
 * requestVideoFrameCallback используется при наличии, иначе requestAnimationFrame.
 */

const THROTTLE_MS = 250;

export function usePlaybackClock(videoRef: RefObject<HTMLVideoElement>, enabled = true): void {
  useEffect(() => {
    const element = videoRef.current;
    if (!element || !enabled) return;

    const store = usePlayerStore.getState;
    let rafId = 0;
    let frameId = 0;
    let lastPublish = 0;
    let running = false;
    let disposed = false;

    const publish = (force: boolean): void => {
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      if (!force && now - lastPublish < THROTTLE_MS) return;
      lastPublish = now;
      store().setPosition(Math.round(element.currentTime * 1000));
    };

    const stopLoop = (): void => {
      running = false;
      if (rafId !== 0) {
        cancelAnimationFrame(rafId);
        rafId = 0;
      }
      if (frameId !== 0 && typeof element.cancelVideoFrameCallback === 'function') {
        element.cancelVideoFrameCallback(frameId);
        frameId = 0;
      }
    };

    const startLoop = (): void => {
      if (running || disposed) return;
      running = true;
      const supportsVideoFrames = typeof element.requestVideoFrameCallback === 'function';
      if (supportsVideoFrames) {
        const step = (): void => {
          if (!running || disposed) return;
          publish(false);
          frameId = element.requestVideoFrameCallback(step);
        };
        frameId = element.requestVideoFrameCallback(step);
      } else {
        const step = (): void => {
          if (!running || disposed) return;
          publish(false);
          rafId = requestAnimationFrame(step);
        };
        rafId = requestAnimationFrame(step);
      }
    };

    const onDuration = (): void => {
      if (!Number.isFinite(element.duration)) return;
      store().setDuration(Math.round(element.duration * 1000));
      const target = store().positionMs;
      if (target > 500 && Math.abs(element.currentTime * 1000 - target) > 250) {
        try {
          element.currentTime = target / 1000;
        } catch {
          /* элемент может не поддерживать seek до загрузки данных */
        }
      }
    };
    const onSeeked = (): void => publish(true);
    const onTimeUpdate = (): void => publish(false);
    const onPlay = (): void => {
      store().setPlaying(true);
      startLoop();
    };
    const onPause = (): void => {
      store().setPlaying(false);
      publish(true);
      stopLoop();
    };
    const onEnded = (): void => {
      store().setPlaying(false);
      publish(true);
      stopLoop();
    };

    element.addEventListener('loadedmetadata', onDuration);
    element.addEventListener('durationchange', onDuration);
    element.addEventListener('seeked', onSeeked);
    element.addEventListener('timeupdate', onTimeUpdate);
    element.addEventListener('play', onPlay);
    element.addEventListener('pause', onPause);
    element.addEventListener('ended', onEnded);

    store().setVideoElement(element);
    if (Number.isFinite(element.duration) && element.duration > 0) onDuration();
    publish(true);
    if (!element.paused && !element.ended) {
      store().setPlaying(true);
      startLoop();
    }

    return () => {
      disposed = true;
      stopLoop();
      element.removeEventListener('loadedmetadata', onDuration);
      element.removeEventListener('durationchange', onDuration);
      element.removeEventListener('seeked', onSeeked);
      element.removeEventListener('timeupdate', onTimeUpdate);
      element.removeEventListener('play', onPlay);
      element.removeEventListener('pause', onPause);
      element.removeEventListener('ended', onEnded);
      store().setPlaying(false);
      store().setVideoElement(null);
    };
  }, [videoRef, enabled]);
}
