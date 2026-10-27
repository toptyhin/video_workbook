/**
 * M11: чистые помощники для записи экрана/окна.
 *
 * Контракт — plans/11-screen-recording.md §6.1. Здесь нет DOM-состояния и
 * побочных эффектов: только пресеты, выбор mime/constraints и форматирование.
 */

export type RecordingQuality = 'low' | 'standard' | 'high';
export type RecordingAudioMode = 'none' | 'mic' | 'system' | 'mic_system';

export interface RecordingQualityPreset {
  id: RecordingQuality;
  /** Ключ i18n для подписи пресета (строки — в lib/i18n/ru.json). */
  labelKey: string;
  /** null — исходное разрешение источника (без downscale). */
  maxWidth: number | null;
  maxHeight: number | null;
  videoBitsPerSecond: number;
  audioBitsPerSecond: number;
  /** Оценка размера, МБ/мин (совпадает с plans/11 §1: ≈11/22/45). */
  approxMbPerMin: number;
}

export const RECORDING_QUALITIES: readonly RecordingQuality[] = ['low', 'standard', 'high'];

export const RECORDING_AUDIO_MODES: readonly RecordingAudioMode[] = [
  'none',
  'mic',
  'system',
  'mic_system',
];

export const DEFAULT_RECORDING_QUALITY: RecordingQuality = 'standard';
export const DESKTOP_MAX_FRAME_RATE = 30;

export const RECORDING_QUALITY_PRESETS: Record<RecordingQuality, RecordingQualityPreset> = {
  low: {
    id: 'low',
    labelKey: 'recording.quality.low',
    maxWidth: 1280,
    maxHeight: 720,
    videoBitsPerSecond: 1_500_000,
    audioBitsPerSecond: 96_000,
    approxMbPerMin: 11,
  },
  standard: {
    id: 'standard',
    labelKey: 'recording.quality.standard',
    maxWidth: 1920,
    maxHeight: 1080,
    videoBitsPerSecond: 3_000_000,
    audioBitsPerSecond: 128_000,
    approxMbPerMin: 22,
  },
  high: {
    id: 'high',
    labelKey: 'recording.quality.high',
    maxWidth: null,
    maxHeight: null,
    videoBitsPerSecond: 6_000_000,
    audioBitsPerSecond: 128_000,
    approxMbPerMin: 45,
  },
};

/** Кандидаты mime в порядке приоритета: VP9 → VP8 → контейнер без явного кодека. */
export const RECORDING_MIME_CANDIDATES: Readonly<Record<'withAudio' | 'videoOnly', readonly string[]>> =
  {
    withAudio: ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'],
    videoOnly: ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'],
  };

export function isRecordingQuality(value: unknown): value is RecordingQuality {
  return value === 'low' || value === 'standard' || value === 'high';
}

export function isRecordingAudioMode(value: unknown): value is RecordingAudioMode {
  return value === 'none' || value === 'mic' || value === 'system' || value === 'mic_system';
}

/**
 * Выбирает первый поддерживаемый mime. Если не поддержан ни один (в т.ч. проверка
 * недоступна) — возвращает базовый `video/webm`: конструктор MediaRecorder может
 * выбросить исключение, это обрабатывает recordStore.
 */
export function pickMimeType(
  hasAudio: boolean,
  isSupported: (mimeType: string) => boolean,
): string {
  const candidates = hasAudio
    ? RECORDING_MIME_CANDIDATES.withAudio
    : RECORDING_MIME_CANDIDATES.videoOnly;
  for (const mimeType of candidates) {
    try {
      if (isSupported(mimeType)) return mimeType;
    } catch {
      /* невалидный mime в isTypeSupported — пробуем следующий */
    }
  }
  return candidates[candidates.length - 1];
}

export interface DesktopVideoMandatoryConstraints {
  chromeMediaSource: 'desktop';
  chromeMediaSourceId: string;
  maxWidth?: number;
  maxHeight?: number;
  maxFrameRate: number;
}

export type DesktopVideoConstraints = MediaTrackConstraints & {
  mandatory: DesktopVideoMandatoryConstraints;
};

/**
 * Electron/Chromium desktop capture: `mandatory.chromeMediaSource = 'desktop'`.
 * Официальные TS-типы MediaTrackConstraints `mandatory` не содержат, поэтому
 * результат кастуется; вызывающий передаёт его как `video` в getUserMedia.
 */
export function desktopVideoConstraints(
  sourceId: string,
  quality: RecordingQuality,
): DesktopVideoConstraints {
  const preset = RECORDING_QUALITY_PRESETS[quality];
  const mandatory: DesktopVideoMandatoryConstraints = {
    chromeMediaSource: 'desktop',
    chromeMediaSourceId: sourceId,
    maxFrameRate: DESKTOP_MAX_FRAME_RATE,
  };
  if (preset.maxWidth !== null) mandatory.maxWidth = preset.maxWidth;
  if (preset.maxHeight !== null) mandatory.maxHeight = preset.maxHeight;
  return { mandatory } as DesktopVideoConstraints;
}

/** Микрофон пишем без обработки речи — исходный звук для WebM (Opus). */
export function microphoneConstraints(deviceId: string | null): MediaTrackConstraints {
  const constraints: MediaTrackConstraints = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  };
  if (deviceId) constraints.deviceId = { exact: deviceId };
  return constraints;
}

/** `HH:MM:SS` для панели записи (всегда часы, в отличие от `formatTimecode`). */
export function formatElapsed(ms: number): string {
  const totalSeconds = Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 1000)) : 0;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map((part) => String(part).padStart(2, '0')).join(':');
}

/** Оценка размера пресета, МБ/мин (см. plans/11 §1). */
export function approxSizeMbPerMin(quality: RecordingQuality): number {
  return RECORDING_QUALITY_PRESETS[quality].approxMbPerMin;
}

/** Оценка размера для длительности (по умолчанию — одна минута), МБ. */
export function approxSize(quality: RecordingQuality, durationMs = 60_000): number {
  const minutes = Math.max(0, durationMs) / 60_000;
  return Math.round(approxSizeMbPerMin(quality) * minutes * 10) / 10;
}

/** Оценка размера пресета, байт/мин (для подсказки/лимитов). */
export function approxBytesPerMinute(quality: RecordingQuality): number {
  return Math.round(approxSizeMbPerMin(quality) * 1_000_000);
}
