import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api/client', () => ({
  api: {
    recordingCapabilities: vi.fn(),
    startRecording: vi.fn(),
    uploadRecordingChunk: vi.fn(),
    pauseRecording: vi.fn(),
    resumeRecording: vi.fn(),
    finishRecording: vi.fn(),
    cancelRecording: vi.fn(),
  },
}));

vi.mock('../api/electron', () => ({
  getCaptureSources: vi.fn(),
}));

import { api } from '../api/client';
import { getCaptureSources } from '../api/electron';
import type { CaptureSource, RecordingCapabilities, StartRecordingResponse } from '../api/types';
import { useRecordStore, type RecordStoreState } from './recordStore';

const mockedApi = api as unknown as {  recordingCapabilities: ReturnType<typeof vi.fn>;
  startRecording: ReturnType<typeof vi.fn>;
  uploadRecordingChunk: ReturnType<typeof vi.fn>;
  pauseRecording: ReturnType<typeof vi.fn>;
  resumeRecording: ReturnType<typeof vi.fn>;
  finishRecording: ReturnType<typeof vi.fn>;
  cancelRecording: ReturnType<typeof vi.fn>;
};
const mockedGetCaptureSources = getCaptureSources as unknown as ReturnType<typeof vi.fn>;

const SOURCE: CaptureSource = {
  id: 'screen:0:0',
  name: 'Entire Screen',
  type: 'screen',
  display_id: '1',
  thumbnail_data_url: 'data:image/png;base64,AAA',
};

const CAPABILITIES: RecordingCapabilities = {
  system_audio: { available: true, detail: null },
  max_chunk_bytes: 33_554_432,
};

const RECORDING_ID = 'a'.repeat(32);

class FakeTrack {
  readonly kind: 'audio' | 'video';
  readyState: 'live' | 'ended' = 'live';
  stop = vi.fn(() => {
    this.readyState = 'ended';
  });

  constructor(kind: 'audio' | 'video') {
    this.kind = kind;
  }
}

class FakeMediaStream {
  readonly tracks: FakeTrack[];

  constructor(tracks: FakeTrack[] = []) {
    this.tracks = [...tracks];
  }

  getTracks(): FakeTrack[] {
    return [...this.tracks];
  }

  getVideoTracks(): FakeTrack[] {
    return this.tracks.filter((track) => track.kind === 'video');
  }

  getAudioTracks(): FakeTrack[] {
    return this.tracks.filter((track) => track.kind === 'audio');
  }
}

class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = [];
  static isTypeSupported = vi.fn((_mimeType: string) => true);

  state: 'inactive' | 'recording' | 'paused' = 'inactive';
  readonly stream: FakeMediaStream;
  readonly options: MediaRecorderOptions;
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;

  start = vi.fn((_timeslice?: number) => {
    this.state = 'recording';
  });
  stop = vi.fn(() => {
    this.state = 'inactive';
    this.onstop?.();
  });
  pause = vi.fn(() => {
    this.state = 'paused';
  });
  resume = vi.fn(() => {
    this.state = 'recording';
  });

  constructor(stream: FakeMediaStream, options: MediaRecorderOptions = {}) {
    this.stream = stream;
    this.options = options;
    FakeMediaRecorder.instances.push(this);
  }

  emit(data: Blob): void {
    this.ondataavailable?.({ data });
  }
}

interface FakeMediaDevices {
  getUserMedia: ReturnType<typeof vi.fn>;
  enumerateDevices: ReturnType<typeof vi.fn>;
  desktopTrack: FakeTrack;
  micTrack: FakeTrack;
}

let mediaDevices: FakeMediaDevices;
let originalMediaDevicesDescriptor: PropertyDescriptor | undefined;

function createMediaDevices(): FakeMediaDevices {
  const desktopTrack = new FakeTrack('video');
  const micTrack = new FakeTrack('audio');
  const getUserMedia = vi.fn(async (constraints: MediaStreamConstraints) => {
    if (constraints.video) return new FakeMediaStream([desktopTrack]);
    return new FakeMediaStream([micTrack]);
  });
  const enumerateDevices = vi.fn(
    async () =>
      [
        {
          deviceId: 'mic-1',
          groupId: 'g1',
          kind: 'audioinput',
          label: 'Built-in Microphone',
          toJSON: () => ({}),
        },
      ] as unknown as MediaDeviceInfo[],
  );
  return { getUserMedia, enumerateDevices, desktopTrack, micTrack };
}

function seedStore(overrides: Partial<RecordStoreState> = {}): void {
  useRecordStore.setState({
    dialogOpen: false,
    status: 'idle',
    error: null,
    sources: [SOURCE],
    sourcesLoading: false,
    capabilities: CAPABILITIES,
    audioInputs: [{ device_id: 'mic-1', label: 'Built-in Microphone' }],
    selectedSourceId: SOURCE.id,
    audioMode: 'mic',
    micDeviceId: null,
    quality: 'standard',
    title: '',
    elapsedMs: 0,
    bytesSent: 0,
    recordingId: null,
    lastVideoId: null,
    ...overrides,
  });
}

function currentRecorder(): FakeMediaRecorder {
  const recorder = FakeMediaRecorder.instances.at(-1);
  if (!recorder) throw new Error('MediaRecorder not constructed');
  return recorder;
}

async function flushAsync(rounds = 20): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve();
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

// jsdom в этом окружении не даёт localStorage — подменяем in-memory Storage.
const memoryStorage = new Map<string, string>();
Object.defineProperty(window, 'localStorage', {
  configurable: true,
  writable: true,
  value: {
    get length() {
      return memoryStorage.size;
    },
    clear: () => memoryStorage.clear(),
    getItem: (key: string) => (memoryStorage.has(key) ? (memoryStorage.get(key) ?? null) : null),
    key: (index: number) => Array.from(memoryStorage.keys())[index] ?? null,
    removeItem: (key: string) => {
      memoryStorage.delete(key);
    },
    setItem: (key: string, value: string) => {
      memoryStorage.set(key, String(value));
    },
  },
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  FakeMediaRecorder.instances = [];
  FakeMediaRecorder.isTypeSupported = vi.fn((_mimeType: string) => true);
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
  vi.stubGlobal('MediaStream', FakeMediaStream);

  mediaDevices = createMediaDevices();
  originalMediaDevicesDescriptor = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: mediaDevices,
  });

  window.localStorage.clear();

  mockedGetCaptureSources.mockResolvedValue([SOURCE]);
  mockedApi.recordingCapabilities.mockResolvedValue(CAPABILITIES);
  mockedApi.startRecording.mockResolvedValue({
    recording_id: RECORDING_ID,
    system_audio: { active: true, detail: null },
  });
  mockedApi.uploadRecordingChunk.mockResolvedValue({ bytes: 10 });
  mockedApi.pauseRecording.mockResolvedValue(undefined);
  mockedApi.resumeRecording.mockResolvedValue(undefined);
  mockedApi.finishRecording.mockResolvedValue({
    video_id: 7,
    title: 'Recording',
    duration_ms: 3000,
    size_bytes: 1_234_567,
    path: '/tmp/rec-1.webm',
    playback_mode: 'direct',
  });
  mockedApi.cancelRecording.mockResolvedValue(undefined);

  seedStore();
});

afterEach(async () => {
  await useRecordStore.getState().cancel();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  if (originalMediaDevicesDescriptor) {
    Object.defineProperty(navigator, 'mediaDevices', originalMediaDevicesDescriptor);
  } else {
    delete (navigator as unknown as Record<string, unknown>).mediaDevices;
  }
  window.localStorage.clear();
});

describe('recordStore: loadSources', () => {
  it('загружает источники, capabilities и аудиоустройства', async () => {
    useRecordStore.setState({ selectedSourceId: null });
    await useRecordStore.getState().loadSources();
    const state = useRecordStore.getState();
    expect(mockedGetCaptureSources).toHaveBeenCalled();
    expect(mockedApi.recordingCapabilities).toHaveBeenCalled();
    expect(state.sources).toEqual([SOURCE]);
    expect(state.capabilities).toEqual(CAPABILITIES);
    expect(state.audioInputs).toEqual([{ device_id: 'mic-1', label: 'Built-in Microphone' }]);
    expect(state.sourcesLoading).toBe(false);
    expect(state.error).toBeNull();
  });

  it('не падает без Electron API/бэкенда (пустые источники + error)', async () => {
    mockedGetCaptureSources.mockRejectedValue(new Error('no desktopCapturer'));
    mockedApi.recordingCapabilities.mockRejectedValue(new Error('backend down'));
    await useRecordStore.getState().loadSources();
    const state = useRecordStore.getState();
    expect(state.sourcesLoading).toBe(false);
    expect(state.sources).toEqual([]);
    expect(state.status).toBe('idle');
    expect(state.error).toContain('capture sources');
  });

  it('openDialog открывает диалог и перезагружает данные', async () => {
    useRecordStore.getState().openDialog();
    expect(useRecordStore.getState().dialogOpen).toBe(true);
    await flushAsync();
    expect(mockedGetCaptureSources).toHaveBeenCalled();
    expect(useRecordStore.getState().sources).toEqual([SOURCE]);
  });
});

describe('recordStore: успешный цикл', () => {
  it('start → чанки → stop: finish вызван, lastVideoId, cleanup треков', async () => {
    await useRecordStore.getState().start();
    const recording = useRecordStore.getState();
    expect(recording.status).toBe('recording');
    expect(recording.recordingId).toBe(RECORDING_ID);
    // Живой предпросмотр в панели видео: отдан desktop-поток (video-дорожка).
    expect(recording.previewStream).toBeInstanceOf(FakeMediaStream);
    expect(recording.previewStream?.getVideoTracks()).toHaveLength(1);
    expect(recording.previewStream?.getAudioTracks()).toHaveLength(0);
    expect(mockedApi.startRecording).toHaveBeenCalledWith({
      source_kind: 'screen',
      source_title: SOURCE.name,
      title: undefined,
      mime_type: 'video/webm;codecs=vp9,opus',
      system_audio: false,
    });

    const recorder = currentRecorder();
    expect(recorder.start).toHaveBeenCalledWith(1000);
    expect(recorder.options.videoBitsPerSecond).toBe(3_000_000);
    expect(recorder.options.audioBitsPerSecond).toBe(128_000);
    expect(mediaDevices.getUserMedia).toHaveBeenCalledTimes(2);
    expect(mediaDevices.getUserMedia.mock.calls[0]?.[0]).toMatchObject({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: SOURCE.id,
          maxWidth: 1920,
          maxHeight: 1080,
        },
      },
    });
    expect(mediaDevices.getUserMedia.mock.calls[1]?.[0]).toMatchObject({
      audio: { echoCancellation: false },
      video: false,
    });

    vi.advanceTimersByTime(1_500);
    expect(useRecordStore.getState().elapsedMs).toBe(1_500);

    recorder.emit(new Blob(['chunk-1']));
    recorder.emit(new Blob(['chunk-2']));
    await flushAsync();
    expect(mockedApi.uploadRecordingChunk).toHaveBeenCalledTimes(2);
    expect(useRecordStore.getState().bytesSent).toBe(20);

    const result = await useRecordStore.getState().stop();
    expect(mockedApi.finishRecording).toHaveBeenCalledWith(RECORDING_ID, { duration_ms: 1_500 });
    expect(result).toEqual({
      videoId: 7,
      title: 'Recording',
      durationMs: 3000,
      sizeBytes: 1_234_567,
      playbackMode: 'direct',
    });
    const after = useRecordStore.getState();
    expect(after.status).toBe('idle');
    expect(after.lastVideoId).toBe(7);
    expect(after.recordingId).toBeNull();
    expect(after.elapsedMs).toBe(1_500);
    expect(after.previewStream).toBeNull();
    expect(mediaDevices.desktopTrack.stop).toHaveBeenCalled();
    expect(mediaDevices.micTrack.stop).toHaveBeenCalled();
  });

  it('загружает чанки строго последовательно (порядок байт)', async () => {
    await useRecordStore.getState().start();
    const recorder = currentRecorder();
    const first = deferred<{ bytes: number }>();
    mockedApi.uploadRecordingChunk
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue({ bytes: 5 });

    recorder.emit(new Blob(['first']));
    recorder.emit(new Blob(['second']));
    await flushAsync();
    expect(mockedApi.uploadRecordingChunk).toHaveBeenCalledTimes(1);

    first.resolve({ bytes: 3 });
    await flushAsync();
    expect(mockedApi.uploadRecordingChunk).toHaveBeenCalledTimes(2);
    expect(useRecordStore.getState().bytesSent).toBe(8);
    await useRecordStore.getState().cancel();
  });

  it('pause/resume синхронизирует MediaRecorder и backend, таймер без пауз', async () => {
    await useRecordStore.getState().start();
    const recorder = currentRecorder();

    vi.advanceTimersByTime(2_000);
    await useRecordStore.getState().pause();
    expect(recorder.pause).toHaveBeenCalled();
    expect(mockedApi.pauseRecording).toHaveBeenCalledWith(RECORDING_ID);
    expect(useRecordStore.getState().status).toBe('paused');
    expect(useRecordStore.getState().elapsedMs).toBe(2_000);

    vi.advanceTimersByTime(1_000);
    expect(useRecordStore.getState().elapsedMs).toBe(2_000);

    await useRecordStore.getState().resume();
    expect(recorder.resume).toHaveBeenCalled();
    expect(mockedApi.resumeRecording).toHaveBeenCalledWith(RECORDING_ID);
    expect(useRecordStore.getState().status).toBe('recording');

    vi.advanceTimersByTime(1_000);
    const result = await useRecordStore.getState().stop();
    expect(result).not.toBeNull();
    expect(mockedApi.finishRecording).toHaveBeenCalledWith(RECORDING_ID, { duration_ms: 3_000 });
  });

  it('stop() без активной записи возвращает null', async () => {
    expect(await useRecordStore.getState().stop()).toBeNull();
  });

  it('не стартует без выбранного источника', async () => {
    seedStore({ selectedSourceId: null });
    await useRecordStore.getState().start();
    expect(useRecordStore.getState().status).toBe('error');
    expect(useRecordStore.getState().error).toContain('screen or window');
    expect(mockedApi.startRecording).not.toHaveBeenCalled();
  });

  it('не стартует в режиме "system", если системный звук недоступен', async () => {
    seedStore({
      audioMode: 'system',
      capabilities: {
        system_audio: { available: false, detail: 'pactl not found' },
        max_chunk_bytes: 33_554_432,
      },
    });
    await useRecordStore.getState().start();
    expect(useRecordStore.getState().status).toBe('error');
    expect(useRecordStore.getState().error).toContain('pactl');
    expect(mockedApi.startRecording).not.toHaveBeenCalled();
  });

  it('mic_system продолжает запись без системного звука', async () => {
    seedStore({
      audioMode: 'mic_system',
      capabilities: {
        system_audio: { available: false, detail: 'pactl not found' },
        max_chunk_bytes: 33_554_432,
      },
    });
    mockedApi.startRecording.mockResolvedValue({
      recording_id: RECORDING_ID,
      system_audio: { active: false, detail: 'pactl not found' },
    });
    await useRecordStore.getState().start();
    expect(useRecordStore.getState().status).toBe('recording');
    expect(mockedApi.startRecording).toHaveBeenCalledWith(
      expect.objectContaining({ system_audio: true }),
    );
    await useRecordStore.getState().cancel();
  });
});

describe('recordStore: ошибки и отмена', () => {
  it('cancel() очищает треки и отменяет backend-сессию без finish', async () => {
    await useRecordStore.getState().start();
    const recorder = currentRecorder();
    recorder.emit(new Blob(['chunk']));
    await flushAsync();

    await useRecordStore.getState().cancel();
    expect(mockedApi.cancelRecording).toHaveBeenCalledWith(RECORDING_ID);
    expect(mockedApi.finishRecording).not.toHaveBeenCalled();
    const state = useRecordStore.getState();
    expect(state.status).toBe('idle');
    expect(state.recordingId).toBeNull();
    expect(state.elapsedMs).toBe(0);
    expect(state.bytesSent).toBe(0);
    expect(state.previewStream).toBeNull();
    expect(mediaDevices.desktopTrack.stop).toHaveBeenCalled();
    expect(mediaDevices.micTrack.stop).toHaveBeenCalled();
  });

  it('ошибка getUserMedia: cleanup, отмена backend-сессии, status=error', async () => {
    mediaDevices.getUserMedia.mockRejectedValueOnce(new Error('NotAllowedError: Permission denied'));
    await useRecordStore.getState().start();
    const state = useRecordStore.getState();
    expect(state.status).toBe('error');
    expect(state.error).toContain('NotAllowedError');
    expect(state.recordingId).toBeNull();
    expect(mockedApi.cancelRecording).toHaveBeenCalledWith(RECORDING_ID);
    expect(FakeMediaRecorder.instances).toHaveLength(0);
  });

  it('ошибка микрофона останавливает desktop-поток и отменяет сессию', async () => {
    mediaDevices.getUserMedia
      .mockResolvedValueOnce(new FakeMediaStream([mediaDevices.desktopTrack]))
      .mockRejectedValueOnce(new Error('microphone denied'));
    await useRecordStore.getState().start();
    expect(mediaDevices.desktopTrack.stop).toHaveBeenCalled();
    expect(mockedApi.cancelRecording).toHaveBeenCalledWith(RECORDING_ID);
    expect(useRecordStore.getState().status).toBe('error');
    expect(useRecordStore.getState().error).toContain('microphone denied');
  });

  it('cancel() во время preparing отменяет запуск и backend-сессию', async () => {
    const pendingStart = deferred<StartRecordingResponse>();
    mockedApi.startRecording.mockImplementationOnce(() => pendingStart.promise);
    const startPromise = useRecordStore.getState().start();
    await flushAsync();
    expect(useRecordStore.getState().status).toBe('preparing');

    await useRecordStore.getState().cancel();
    pendingStart.resolve({ recording_id: RECORDING_ID, system_audio: { active: true, detail: null } });
    await startPromise;

    expect(useRecordStore.getState().status).toBe('idle');
    expect(FakeMediaRecorder.instances).toHaveLength(0);
    expect(mockedApi.cancelRecording).toHaveBeenCalledWith(RECORDING_ID);
    expect(mediaDevices.desktopTrack.stop).not.toHaveBeenCalled();
  });

  it('ошибка загрузки чанка: 3 попытки, аварийная отмена и cleanup', async () => {    await useRecordStore.getState().start();
    const recorder = currentRecorder();
    mockedApi.uploadRecordingChunk.mockRejectedValue(new Error('network down'));

    recorder.emit(new Blob(['chunk']));
    await flushAsync();

    expect(mockedApi.uploadRecordingChunk).toHaveBeenCalledTimes(3);
    expect(mockedApi.cancelRecording).toHaveBeenCalledWith(RECORDING_ID);
    const state = useRecordStore.getState();
    expect(state.status).toBe('error');
    expect(state.error).toContain('network down');
    expect(state.recordingId).toBeNull();
    expect(mediaDevices.desktopTrack.stop).toHaveBeenCalled();
    expect(mediaDevices.micTrack.stop).toHaveBeenCalled();
  });
});

describe('recordStore: настройки', () => {
  it('persist качества/режима/микрофона в localStorage и reset() их восстанавливает', () => {
    useRecordStore.getState().setQuality('low');
    useRecordStore.getState().setAudioMode('system');
    useRecordStore.getState().setMicDeviceId('mic-1');

    expect(window.localStorage.getItem('vl.recording.quality')).toBeTruthy();
    expect(window.localStorage.getItem('vl.recording.audioMode')).toBeTruthy();
    expect(window.localStorage.getItem('vl.recording.micDeviceId')).toBeTruthy();

    useRecordStore.getState().reset();
    const state = useRecordStore.getState();
    expect(state.quality).toBe('low');
    expect(state.audioMode).toBe('system');
    expect(state.micDeviceId).toBe('mic-1');
    expect(state.status).toBe('idle');
    expect(state.selectedSourceId).toBeNull();
    expect(state.dialogOpen).toBe(false);
  });

  it('понижает режим звука при недоступности устройств', async () => {
    // Нет микрофонов; системный звук доступен → 'mic' понижается до 'system'.
    mediaDevices.enumerateDevices.mockResolvedValue([] as unknown as MediaDeviceInfo[]);
    seedStore({ audioMode: 'mic', audioInputs: [] });
    await useRecordStore.getState().loadSources();
    expect(useRecordStore.getState().audioInputs).toEqual([]);
    expect(useRecordStore.getState().audioMode).toBe('system');

    // Нет и системного звука → 'none'.
    mockedApi.recordingCapabilities.mockResolvedValue({
      system_audio: { available: false, detail: null },
      max_chunk_bytes: 33_554_432,
    });
    await useRecordStore.getState().loadSources();
    expect(useRecordStore.getState().audioMode).toBe('none');
  });
});
