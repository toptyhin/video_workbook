import { create } from 'zustand';

import { api } from '../api/client';
import { getCaptureSources } from '../api/electron';
import type {
  CaptureSource,
  FinishRecordingResponse,
  RecordingCapabilities,
} from '../api/types';
import {
  DEFAULT_RECORDING_QUALITY,
  RECORDING_QUALITY_PRESETS,
  desktopVideoConstraints,
  isRecordingAudioMode,
  isRecordingQuality,
  microphoneConstraints,
  pickMimeType,
  type RecordingAudioMode,
  type RecordingQuality,
} from '../lib/recording';
import { readStorage, writeStorage } from '../lib/storage';

/**
 * M11: конечный автомат записи экрана/окна (plans/11-screen-recording.md §6.2).
 *
 * Поток: capabilities → startRecording (backend-сессия) → desktop getUserMedia →
 * mic getUserMedia (если нужен) → MediaRecorder(combined, timeslice=1 c).
 * Чанки уходят на backend строго последовательно; ошибка загрузки/финализации
 * аварийно завершает запись (cleanup + отмена backend-сессии).
 *
 * Стор не содержит UI-строк (i18n — у компонентов) и не импортирует uiStore.
 */

export type RecordStatus = 'idle' | 'preparing' | 'recording' | 'paused' | 'finalizing' | 'error';

export interface RecordingAudioInput {
  device_id: string;
  label: string;
}

export interface RecordingResult {
  videoId: number;
  title: string;
  durationMs: number;
  sizeBytes: number;
  playbackMode: string;
}

export interface RecordStoreState {
  dialogOpen: boolean;
  status: RecordStatus;
  error: string | null;
  sources: CaptureSource[];
  sourcesLoading: boolean;
  capabilities: RecordingCapabilities | null;
  audioInputs: RecordingAudioInput[];
  selectedSourceId: string | null;
  audioMode: RecordingAudioMode;
  micDeviceId: string | null;
  quality: RecordingQuality;
  title: string;
  /** Активное время записи (без пауз), мс. */
  elapsedMs: number;
  bytesSent: number;
  recordingId: string | null;
  lastVideoId: number | null;
  /** Живой поток захвата для предпросмотра в панели видео (video-дорожка). */
  previewStream: MediaStream | null;

  openDialog: () => void;
  closeDialog: () => void;
  loadSources: () => Promise<void>;
  setSelectedSource: (id: string) => void;
  setAudioMode: (mode: RecordingAudioMode) => void;
  setMicDeviceId: (id: string | null) => void;
  setQuality: (quality: RecordingQuality) => void;
  setTitle: (title: string) => void;
  start: () => Promise<void>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  stop: () => Promise<RecordingResult | null>;
  cancel: () => Promise<void>;
  reset: () => void;
}

// Ключи localStorage заданы локально: lib/constants.ts вне write-scope M11.
const STORAGE_KEYS = {
  quality: 'vl.recording.quality',
  audioMode: 'vl.recording.audioMode',
  micDeviceId: 'vl.recording.micDeviceId',
} as const;

const CHUNK_TIMESLICE_MS = 1000;
/** Повторов загрузки чанка после первой попытки (всего ≤ 3 запросов). */
const CHUNK_UPLOAD_RETRIES = 2;
const CHUNK_UPLOAD_ATTEMPTS = CHUNK_UPLOAD_RETRIES + 1;
const ELAPSED_TICK_MS = 250;

const ACTIVE_STATUSES: ReadonlySet<RecordStatus> = new Set<RecordStatus>([
  'preparing',
  'recording',
  'paused',
  'finalizing',
]);

interface RecordingSession {
  recorder: MediaRecorder;
  streams: MediaStream[];
  recordingId: string;
  sourceKind: 'screen' | 'window';
  sourceName: string;
  mimeType: string;
  systemAudio: boolean;
  /** Последовательная очередь загрузки чанков. */
  chunkChain: Promise<void>;
  uploadError: string | null;
  aborted: boolean;
  stopped: Promise<void>;
  resolveStopped: () => void;
  elapsedAccumMs: number;
  activeSince: number | null;
  elapsedMs: number;
}

let session: RecordingSession | null = null;
let elapsedTimerId: number | undefined;
/** Поколение start(): cancel()/reset() во время preparing отменяют запуск. */
let startGeneration = 0;

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return String(error);
}

function nowMs(): number {
  return Date.now();
}

function measureElapsed(current: RecordingSession): number {
  const active = current.activeSince === null ? 0 : nowMs() - current.activeSince;
  return Math.max(0, Math.round(current.elapsedAccumMs + active));
}

function pauseElapsed(current: RecordingSession): void {
  if (current.activeSince !== null) {
    current.elapsedAccumMs += nowMs() - current.activeSince;
    current.activeSince = null;
  }
  current.elapsedMs = measureElapsed(current);
}

function resumeElapsed(current: RecordingSession): void {
  if (current.activeSince === null) current.activeSince = nowMs();
}

function stopElapsedTimer(): void {
  if (elapsedTimerId !== undefined) {
    window.clearInterval(elapsedTimerId);
    elapsedTimerId = undefined;
  }
}

function startElapsedTimer(): void {
  stopElapsedTimer();
  elapsedTimerId = window.setInterval(() => {
    const current = session;
    if (!current) return;
    const elapsedMs = measureElapsed(current);
    useRecordStore.setState({ elapsedMs });
  }, ELAPSED_TICK_MS);
}

function stopStreams(streams: readonly MediaStream[]): void {
  for (const stream of streams) {
    for (const track of stream.getTracks()) {
      try {
        track.stop();
      } catch {
        /* трек уже остановлен */
      }
    }
  }
}

function detachRecorder(recorder: MediaRecorder): void {
  try {
    recorder.ondataavailable = null;
    recorder.onstop = null;
    recorder.onerror = null;
  } catch {
    /* fake/уже уничтоженный recorder */
  }
}

function stopRecorder(recorder: MediaRecorder): void {
  try {
    if (recorder.state !== 'inactive') recorder.stop();
  } catch {
    /* stop() может бросить, если запись уже завершена */
  }
}

function supportsMimeType(mimeType: string): boolean {
  return (
    typeof MediaRecorder !== 'undefined' &&
    typeof MediaRecorder.isTypeSupported === 'function' &&
    MediaRecorder.isTypeSupported(mimeType)
  );
}

async function uploadChunk(recordingId: string, chunk: Blob): Promise<number> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < CHUNK_UPLOAD_ATTEMPTS; attempt += 1) {
    try {
      const response = await api.uploadRecordingChunk(recordingId, chunk);
      return typeof response?.bytes === 'number' ? response.bytes : chunk.size;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function enqueueChunk(chunk: Blob): void {
  const current = session;
  if (!current || current.aborted || chunk.size === 0) return;
  current.chunkChain = current.chunkChain
    .then(async () => {
      if (current.aborted || session !== current) return;
      const bytes = await uploadChunk(current.recordingId, chunk);
      if (current.aborted || session !== current) return;
      useRecordStore.setState((state) => ({ bytesSent: state.bytesSent + bytes }));
    })
    .catch((error) => {
      if (current.aborted || session !== current) return;
      current.uploadError = errorMessage(error);
      abortSession(`Failed to upload recording chunk: ${current.uploadError}`);
    });
}

/** Аварийное завершение: без finish, отмена backend-сессии, cleanup, status='error'. */
function abortSession(message: string): void {
  const current = session;
  if (!current || current.aborted) return;
  current.aborted = true;
  current.uploadError = message;
  pauseElapsed(current);
  stopElapsedTimer();
  detachRecorder(current.recorder);
  stopRecorder(current.recorder);
  stopStreams(current.streams);
  session = null;
  void api.cancelRecording(current.recordingId).catch(() => undefined);
  useRecordStore.setState({
    status: 'error',
    error: message,
    recordingId: null,
    elapsedMs: current.elapsedMs,
    previewStream: null,
  });
}

async function loadAudioInputs(): Promise<RecordingAudioInput[]> {
  const mediaDevices = navigator.mediaDevices;
  if (!mediaDevices || typeof mediaDevices.enumerateDevices !== 'function') return [];
  let devices = await mediaDevices.enumerateDevices();
  const needsUnlock = devices.some((device) => device.kind === 'audioinput' && !device.label);
  if (needsUnlock && typeof mediaDevices.getUserMedia === 'function') {
    // Короткий запрос разблокирует подписи устройств; отказ пользователя — не ошибка.
    try {
      const stream = await mediaDevices.getUserMedia({ audio: true });
      for (const track of stream.getTracks()) track.stop();
      devices = await mediaDevices.enumerateDevices();
    } catch {
      /* permission denied: остаются устройства без подписей */
    }
  }
  return devices
    .filter((device) => device.kind === 'audioinput')
    .map((device, index) => ({
      device_id: device.deviceId,
      label: device.label || `Microphone ${index + 1}`,
    }));
}

function normalizeAudioMode(
  mode: RecordingAudioMode,
  hasMic: boolean,
  hasSystem: boolean,
): RecordingAudioMode {
  switch (mode) {
    case 'mic':
      return hasMic ? 'mic' : hasSystem ? 'system' : 'none';
    case 'system':
      return hasSystem ? 'system' : hasMic ? 'mic' : 'none';
    case 'mic_system':
      if (hasMic && hasSystem) return 'mic_system';
      return hasMic ? 'mic' : hasSystem ? 'system' : 'none';
    default:
      return 'none';
  }
}

function readStoredQuality(): RecordingQuality {
  const value = readStorage<unknown>(STORAGE_KEYS.quality, DEFAULT_RECORDING_QUALITY);
  return isRecordingQuality(value) ? value : DEFAULT_RECORDING_QUALITY;
}

function readStoredAudioMode(): RecordingAudioMode {
  const value = readStorage<unknown>(STORAGE_KEYS.audioMode, 'mic');
  return isRecordingAudioMode(value) ? value : 'mic';
}

function readStoredMicDeviceId(): string | null {
  const value = readStorage<unknown>(STORAGE_KEYS.micDeviceId, null);
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export const useRecordStore = create<RecordStoreState>((set, get) => ({
  dialogOpen: false,
  status: 'idle',
  error: null,
  sources: [],
  sourcesLoading: false,
  capabilities: null,
  audioInputs: [],
  selectedSourceId: null,
  audioMode: readStoredAudioMode(),
  micDeviceId: readStoredMicDeviceId(),
  quality: readStoredQuality(),
  title: '',
  elapsedMs: 0,
  bytesSent: 0,
  recordingId: null,
  lastVideoId: null,
  previewStream: null,

  openDialog: () => {
    set({ dialogOpen: true, error: null });
    void get().loadSources();
  },

  closeDialog: () => set({ dialogOpen: false }),

  loadSources: async () => {
    set({ sourcesLoading: true, error: null });
    const [sourcesResult, capabilitiesResult, audioResult] = await Promise.allSettled([
      getCaptureSources(),
      api.recordingCapabilities(),
      loadAudioInputs(),
    ]);
    const state = get();
    const sources = sourcesResult.status === 'fulfilled' ? sourcesResult.value : [];
    const capabilities =
      capabilitiesResult.status === 'fulfilled' ? capabilitiesResult.value : state.capabilities;
    const audioInputs = audioResult.status === 'fulfilled' ? audioResult.value : state.audioInputs;

    let error: string | null = null;
    if (sourcesResult.status === 'rejected') {
      error = `Failed to load capture sources: ${errorMessage(sourcesResult.reason)}`;
    } else if (capabilitiesResult.status === 'rejected') {
      error = `Failed to load recording capabilities: ${errorMessage(capabilitiesResult.reason)}`;
    }

    const hasMic = audioInputs.length > 0;
    const hasSystem = capabilities?.system_audio.available === true;
    const selectedSourceId =
      state.selectedSourceId && sources.some((source) => source.id === state.selectedSourceId)
        ? state.selectedSourceId
        : null;
    const audioMode = normalizeAudioMode(state.audioMode, hasMic, hasSystem);
    const micDeviceId =
      state.micDeviceId && audioInputs.some((input) => input.device_id === state.micDeviceId)
        ? state.micDeviceId
        : null;

    set({
      sources,
      sourcesLoading: false,
      capabilities,
      audioInputs,
      selectedSourceId,
      audioMode,
      micDeviceId,
      error,
    });
  },

  setSelectedSource: (id) => set({ selectedSourceId: id }),

  setAudioMode: (mode) => {
    writeStorage(STORAGE_KEYS.audioMode, mode);
    set({ audioMode: mode });
  },

  setMicDeviceId: (id) => {
    writeStorage(STORAGE_KEYS.micDeviceId, id);
    set({ micDeviceId: id });
  },

  setQuality: (quality) => {
    writeStorage(STORAGE_KEYS.quality, quality);
    set({ quality });
  },

  setTitle: (title) => set({ title }),

  start: async () => {
    const state = get();
    if (ACTIVE_STATUSES.has(state.status)) return;
    const source = state.sources.find((item) => item.id === state.selectedSourceId) ?? null;
    if (!source) {
      set({ status: 'error', error: 'Select a screen or window to record' });
      return;
    }

    set({
      status: 'preparing',
      error: null,
      elapsedMs: 0,
      bytesSent: 0,
      recordingId: null,
      lastVideoId: null,
      previewStream: null,
    });

    const generation = (startGeneration += 1);
    const streams: MediaStream[] = [];
    let recordingId: string | null = null;
    let createdSession: RecordingSession | null = null;
    const isStale = (): boolean => generation !== startGeneration;
    const cleanupAttempt = async (): Promise<void> => {
      stopElapsedTimer();
      stopStreams(streams);
      if (createdSession) {
        detachRecorder(createdSession.recorder);
        if (session === createdSession) session = null;
        createdSession = null;
      }
      if (recordingId) await api.cancelRecording(recordingId).catch(() => undefined);
    };

    try {
      let capabilities = state.capabilities;
      if (!capabilities) {
        capabilities = await api.recordingCapabilities();
        if (isStale()) {
          await cleanupAttempt();
          return;
        }
        set({ capabilities });
      }

      const audioMode = state.audioMode;
      const wantsMic = audioMode === 'mic' || audioMode === 'mic_system';
      const wantsSystem = audioMode === 'system' || audioMode === 'mic_system';
      const systemAudio = capabilities.system_audio;
      if (wantsSystem && !systemAudio.available && audioMode === 'system') {
        throw new Error(systemAudio.detail || 'System audio capture is unavailable');
      }

      const mimeType = pickMimeType(wantsMic, supportsMimeType);
      const started = await api.startRecording({
        source_kind: source.type,
        source_title: source.name,
        title: state.title.trim() || undefined,
        mime_type: mimeType,
        system_audio: wantsSystem,
      });
      recordingId = started.recording_id;
      if (isStale()) {
        await cleanupAttempt();
        return;
      }
      set({ recordingId });

      if (wantsSystem && !started.system_audio?.active && audioMode === 'system') {
        throw new Error(started.system_audio?.detail || 'System audio capture is unavailable');
      }

      const desktopStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: desktopVideoConstraints(source.id, state.quality),
      });
      streams.push(desktopStream);
      if (isStale()) {
        await cleanupAttempt();
        return;
      }

      let micStream: MediaStream | null = null;
      if (wantsMic) {
        micStream = await navigator.mediaDevices.getUserMedia({
          audio: microphoneConstraints(state.micDeviceId),
          video: false,
        });
        streams.push(micStream);
      }

      // Пользователь мог нажать «Отменить», пока шёл getUserMedia.
      if (isStale() || get().recordingId !== recordingId) {
        await cleanupAttempt();
        return;
      }

      const combined = new MediaStream([
        ...desktopStream.getVideoTracks(),
        ...(micStream ? micStream.getAudioTracks() : []),
      ]);
      const preset = RECORDING_QUALITY_PRESETS[state.quality];
      const recorderOptions: MediaRecorderOptions = {
        mimeType,
        videoBitsPerSecond: preset.videoBitsPerSecond,
      };
      if (wantsMic) recorderOptions.audioBitsPerSecond = preset.audioBitsPerSecond;
      const recorder = new MediaRecorder(combined, recorderOptions);

      let resolveStopped: () => void = () => undefined;
      const stopped = new Promise<void>((resolve) => {
        resolveStopped = resolve;
      });

      const current: RecordingSession = {
        recorder,
        streams,
        recordingId,
        sourceKind: source.type,
        sourceName: source.name,
        mimeType,
        systemAudio: wantsSystem,
        chunkChain: Promise.resolve(),
        uploadError: null,
        aborted: false,
        stopped,
        resolveStopped,
        elapsedAccumMs: 0,
        activeSince: nowMs(),
        elapsedMs: 0,
      };

      recorder.ondataavailable = (event: BlobEvent) => {
        enqueueChunk(event.data);
      };
      recorder.onstop = () => {
        current.resolveStopped();
      };
      recorder.onerror = () => {
        abortSession('MediaRecorder error');
      };

      session = current;
      createdSession = current;
      recorder.start(CHUNK_TIMESLICE_MS);
      startElapsedTimer();
      set({ status: 'recording', elapsedMs: 0, previewStream: desktopStream });
    } catch (error) {
      await cleanupAttempt();
      if (isStale()) return;
      set({ status: 'error', error: errorMessage(error), recordingId: null, previewStream: null });
    }
  },

  pause: async () => {
    const current = session;
    if (!current || get().status !== 'recording') return;
    try {
      current.recorder.pause();
    } catch {
      /* recorder уже не активен — состояние всё равно обновим */
    }
    pauseElapsed(current);
    stopElapsedTimer();
    set({ status: 'paused', elapsedMs: current.elapsedMs });
    try {
      await api.pauseRecording(current.recordingId);
    } catch (error) {
      set({ error: `Failed to pause system audio: ${errorMessage(error)}` });
    }
  },

  resume: async () => {
    const current = session;
    if (!current || get().status !== 'paused') return;
    try {
      current.recorder.resume();
    } catch {
      /* recorder уже не активен */
    }
    resumeElapsed(current);
    startElapsedTimer();
    set({ status: 'recording', elapsedMs: measureElapsed(current) });
    try {
      await api.resumeRecording(current.recordingId);
    } catch (error) {
      set({ error: `Failed to resume system audio: ${errorMessage(error)}` });
    }
  },

  stop: async () => {
    const current = session;
    if (!current || current.aborted) return null;
    const { status } = get();
    if (status !== 'recording' && status !== 'paused') return null;

    pauseElapsed(current);
    stopElapsedTimer();
    set({ status: 'finalizing', elapsedMs: current.elapsedMs });

    try {
      stopRecorder(current.recorder);
      await current.stopped;
      // ondataavailable вызывается до onstop — дожидаемся всех поставленных чанков.
      await current.chunkChain;
      if (current.aborted) return null;

      const response: FinishRecordingResponse = await api.finishRecording(current.recordingId, {
        duration_ms: current.elapsedMs,
      });
      detachRecorder(current.recorder);
      stopStreams(current.streams);
      session = null;
      set({
        status: 'idle',
        error: null,
        recordingId: null,
        lastVideoId: response.video_id,
        elapsedMs: current.elapsedMs,
        previewStream: null,
      });
      return {
        videoId: response.video_id,
        title: response.title,
        durationMs: Number.isFinite(response.duration_ms)
          ? response.duration_ms
          : current.elapsedMs,
        sizeBytes: response.size_bytes,
        playbackMode: response.playback_mode,
      };
    } catch (error) {
      const message = `Failed to finalize recording: ${errorMessage(error)}`;
      detachRecorder(current.recorder);
      stopStreams(current.streams);
      if (session === current) session = null;
      await api.cancelRecording(current.recordingId).catch(() => undefined);
      set({
        status: 'error',
        error: message,
        recordingId: null,
        elapsedMs: current.elapsedMs,
        previewStream: null,
      });
      return null;
    }
  },

  cancel: async () => {
    startGeneration += 1;
    const current = session;
    if (!current) {
      const recordingId = get().recordingId;
      if (recordingId) await api.cancelRecording(recordingId).catch(() => undefined);
      set({
        status: 'idle',
        error: null,
        recordingId: null,
        elapsedMs: 0,
        bytesSent: 0,
        previewStream: null,
      });
      return;
    }
    current.aborted = true;
    pauseElapsed(current);
    stopElapsedTimer();
    detachRecorder(current.recorder);
    stopRecorder(current.recorder);
    stopStreams(current.streams);
    session = null;
    await api.cancelRecording(current.recordingId).catch(() => undefined);
    set({
      status: 'idle',
      error: null,
      recordingId: null,
      elapsedMs: 0,
      bytesSent: 0,
      previewStream: null,
    });
  },

  reset: () => {
    startGeneration += 1;
    const current = session;
    if (current) {
      current.aborted = true;
      pauseElapsed(current);
      detachRecorder(current.recorder);
      stopRecorder(current.recorder);
      stopStreams(current.streams);
      session = null;
      void api.cancelRecording(current.recordingId).catch(() => undefined);
    }
    stopElapsedTimer();

    const state = get();
    const hasMic = state.audioInputs.length > 0;
    const hasSystem = state.capabilities?.system_audio.available === true;
    const storedMicDeviceId = readStoredMicDeviceId();

    set({
      dialogOpen: false,
      status: 'idle',
      error: null,
      sourcesLoading: false,
      selectedSourceId: null,
      audioMode: normalizeAudioMode(readStoredAudioMode(), hasMic, hasSystem),
      micDeviceId:
        storedMicDeviceId &&
        state.audioInputs.some((input) => input.device_id === storedMicDeviceId)
          ? storedMicDeviceId
          : null,
      quality: readStoredQuality(),
      title: '',
      elapsedMs: 0,
      bytesSent: 0,
      recordingId: null,
      lastVideoId: null,
      previewStream: null,
    });
  },
}));
