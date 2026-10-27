import { describe, expect, it, vi } from 'vitest';

import {
  DESKTOP_MAX_FRAME_RATE,
  DEFAULT_RECORDING_QUALITY,
  RECORDING_AUDIO_MODES,
  RECORDING_QUALITIES,
  RECORDING_QUALITY_PRESETS,
  approxBytesPerMinute,
  approxSize,
  approxSizeMbPerMin,
  desktopVideoConstraints,
  formatElapsed,
  isRecordingAudioMode,
  isRecordingQuality,
  microphoneConstraints,
  pickMimeType,
  type RecordingQuality,
} from './recording';

function supportedSet(mimes: readonly string[]): (mimeType: string) => boolean {
  return (mimeType: string) => mimes.includes(mimeType);
}

describe('pickMimeType', () => {
  it('выбирает VP9+Opus, если поддержан', () => {
    const isSupported = vi.fn(() => true);
    expect(pickMimeType(true, isSupported)).toBe('video/webm;codecs=vp9,opus');
    expect(isSupported).toHaveBeenCalledWith('video/webm;codecs=vp9,opus');
  });

  it('откатывается на VP8+Opus, затем на video/webm', () => {
    expect(
      pickMimeType(
        true,
        supportedSet(['video/webm;codecs=vp8,opus', 'video/webm']),
      ),
    ).toBe('video/webm;codecs=vp8,opus');
    expect(
      pickMimeType(true, supportedSet(['video/webm'])),
    ).toBe('video/webm');
  });

  it('для видео без звука использует video-only варианты', () => {
    expect(pickMimeType(false, supportedSet(['video/webm;codecs=vp9']))).toBe(
      'video/webm;codecs=vp9',
    );
    expect(pickMimeType(false, supportedSet(['video/webm;codecs=vp8']))).toBe(
      'video/webm;codecs=vp8',
    );
    expect(pickMimeType(false, supportedSet(['video/webm']))).toBe('video/webm');
  });

  it('возвращает video/webm, если ничего не поддержано (ошибку обработает store)', () => {
    expect(pickMimeType(true, () => false)).toBe('video/webm');
    expect(pickMimeType(false, () => false)).toBe('video/webm');
  });

  it('переживает исключение из isTypeSupported', () => {
    const isSupported = vi.fn((mimeType: string) => {
      if (mimeType.includes('vp9')) throw new Error('bad mime');
      return true;
    });
    expect(pickMimeType(true, isSupported)).toBe('video/webm;codecs=vp8,opus');
  });
});

describe('пресеты качества', () => {
  it('содержит low/standard/high с битрейтами и оценкой размера', () => {
    expect(RECORDING_QUALITIES).toEqual(['low', 'standard', 'high']);
    expect(DEFAULT_RECORDING_QUALITY).toBe('standard');

    expect(RECORDING_QUALITY_PRESETS.low).toMatchObject({
      maxWidth: 1280,
      maxHeight: 720,
      videoBitsPerSecond: 1_500_000,
      audioBitsPerSecond: 96_000,
      approxMbPerMin: 11,
    });
    expect(RECORDING_QUALITY_PRESETS.standard).toMatchObject({
      maxWidth: 1920,
      maxHeight: 1080,
      videoBitsPerSecond: 3_000_000,
      audioBitsPerSecond: 128_000,
      approxMbPerMin: 22,
    });
    expect(RECORDING_QUALITY_PRESETS.high).toMatchObject({
      maxWidth: null,
      maxHeight: null,
      videoBitsPerSecond: 6_000_000,
      audioBitsPerSecond: 128_000,
      approxMbPerMin: 45,
    });
  });

  it('оценивает размер на минуту и произвольную длительность', () => {
    expect(approxSizeMbPerMin('low')).toBe(11);
    expect(approxSizeMbPerMin('standard')).toBe(22);
    expect(approxSizeMbPerMin('high')).toBe(45);

    expect(approxSize('standard')).toBe(22);
    expect(approxSize('standard', 30_000)).toBe(11);
    expect(approxSize('low', 120_000)).toBe(22);
    expect(approxSize('high', 0)).toBe(0);

    expect(approxBytesPerMinute('low')).toBe(11_000_000);
    expect(approxBytesPerMinute('high')).toBe(45_000_000);
  });

  it('валидирует качество и режим звука', () => {
    expect(RECORDING_AUDIO_MODES).toEqual(['none', 'mic', 'system', 'mic_system']);
    for (const quality of RECORDING_QUALITIES) expect(isRecordingQuality(quality)).toBe(true);
    expect(isRecordingQuality('ultra')).toBe(false);
    expect(isRecordingQuality(null)).toBe(false);

    for (const mode of RECORDING_AUDIO_MODES) expect(isRecordingAudioMode(mode)).toBe(true);
    expect(isRecordingAudioMode('mic+system')).toBe(false);
  });

  it('labelKey задан для i18n', () => {
    for (const quality of RECORDING_QUALITIES) {
      expect(RECORDING_QUALITY_PRESETS[quality].labelKey).toBe(`recording.quality.${quality}`);
    }
  });
});

describe('desktopVideoConstraints', () => {
  it('для low/standard задаёт downscale и desktop-источник', () => {
    const low = desktopVideoConstraints('screen:0:0', 'low');
    expect(low.mandatory).toEqual({
      chromeMediaSource: 'desktop',
      chromeMediaSourceId: 'screen:0:0',
      maxWidth: 1280,
      maxHeight: 720,
      maxFrameRate: DESKTOP_MAX_FRAME_RATE,
    });

    const standard = desktopVideoConstraints('window:42:1', 'standard');
    expect(standard.mandatory.chromeMediaSourceId).toBe('window:42:1');
    expect(standard.mandatory.maxWidth).toBe(1920);
    expect(standard.mandatory.maxHeight).toBe(1080);
    expect(standard.mandatory.maxFrameRate).toBe(30);
  });

  it('для high оставляет исходное разрешение (без maxWidth/maxHeight)', () => {
    const high = desktopVideoConstraints('screen:1:0', 'high');
    expect(high.mandatory.chromeMediaSource).toBe('desktop');
    expect(high.mandatory.chromeMediaSourceId).toBe('screen:1:0');
    expect(high.mandatory.maxWidth).toBeUndefined();
    expect(high.mandatory.maxHeight).toBeUndefined();
    expect(high.mandatory.maxFrameRate).toBe(DESKTOP_MAX_FRAME_RATE);
  });
});

describe('microphoneConstraints', () => {
  it('без устройства не задаёт deviceId и отключает обработку речи', () => {
    const constraints = microphoneConstraints(null);
    expect(constraints.deviceId).toBeUndefined();
    expect(constraints.echoCancellation).toBe(false);
    expect(constraints.noiseSuppression).toBe(false);
    expect(constraints.autoGainControl).toBe(false);
  });

  it('с устройством требует exact deviceId', () => {
    const constraints = microphoneConstraints('mic-1');
    expect(constraints.deviceId).toEqual({ exact: 'mic-1' });
  });
});

describe('formatElapsed', () => {
  it('форматирует как HH:MM:SS', () => {
    expect(formatElapsed(0)).toBe('00:00:00');
    expect(formatElapsed(999)).toBe('00:00:00');
    expect(formatElapsed(1_000)).toBe('00:00:01');
    expect(formatElapsed(61_000)).toBe('00:01:01');
    expect(formatElapsed(3_661_000)).toBe('01:01:01');
    expect(formatElapsed(3_600_000)).toBe('01:00:00');
    expect(formatElapsed(36_000_000)).toBe('10:00:00');
  });

  it('не уходит в минус и переживает NaN', () => {
    expect(formatElapsed(-5_000)).toBe('00:00:00');
    expect(formatElapsed(Number.NaN)).toBe('00:00:00');
  });
});

describe('типобезопасность пресетов', () => {
  it('approxSize принимает только известное качество', () => {
    const quality: RecordingQuality = 'low';
    expect(approxSize(quality, 60_000)).toBe(11);
  });
});
