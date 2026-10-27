/**
 * Mocked-захват экрана/окна для e2e (plans/11-screen-recording.md §7.3).
 *
 * Playwright-браузер не умеет `desktopCapturer`, поэтому до загрузки приложения:
 *  - `window.vl` получает все методы VLApi, включая getCaptureSources с двумя источниками;
 *  - `navigator.mediaDevices.getUserMedia`/`enumerateDevices` отдают фейковые потоки/треки;
 *  - `MediaRecorder` эмитит настоящий WebM (VP9+Opus), переданный base64 из
 *    `.tmp/e2e-videos/recording-fixture.webm`.
 *
 * Всё остальное (backend, chunked upload, ffmpeg-финализация, библиотека, плеер) — реальное.
 */

/** 1×1 PNG (валидный data URL для миниатюр источников). */
export const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

export interface RecordingSource {
  id: string;
  name: string;
  type: 'screen' | 'window';
  display_id?: string;
  thumbnail_data_url: string;
}

export const RECORDING_SOURCES: ReadonlyArray<RecordingSource> = [
  { id: 'screen:0:0', name: 'Экран e2e', type: 'screen', display_id: '0', thumbnail_data_url: TINY_PNG },
  { id: 'window:4242', name: 'Окно e2e', type: 'window', thumbnail_data_url: TINY_PNG },
];

export interface RecordingMockArg {
  fixtureB64: string;
  sources: ReadonlyArray<RecordingSource>;
}

/** Выполняется в браузере до загрузки приложения: mocked capture + MediaRecorder + window.vl. */
export function installRecordingMock(arg: RecordingMockArg): void {
  const fixtureBytes = Uint8Array.from(atob(arg.fixtureB64), (ch) => ch.charCodeAt(0));
  const events: string[] = [];
  const record = (name: string): void => {
    events.push(name);
  };
  // Отладочный след для теста (см. assertMockUsed): события mocked-слоя.
  (window as unknown as { __vlRecordingMock?: { events: string[] } }).__vlRecordingMock = { events };

  const makeTrack = (kind: 'audio' | 'video'): unknown => ({
    kind,
    id: `${kind}-1`,
    label: kind === 'video' ? 'Fake screen capture' : 'Fake microphone',
    enabled: true,
    muted: false,
    readyState: 'live',
    contentHint: '',
    onended: null,
    getSettings: () =>
      kind === 'video' ? { width: 320, height: 180, frameRate: 15 } : { sampleRate: 48000, channelCount: 1 },
    getCapabilities: () => ({}),
    getConstraints: () => ({}),
    applyConstraints: async () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => true,
    clone: () => makeTrack(kind),
    stop: () => {
      record(`track.stop:${kind}`);
    },
  });

  // Нативный MediaStream — база для фейкового: <video srcObject> принимает только
  // настоящий MediaStream (в т.ч. подкласс), поэтому предпросмотр записи в e2e
  // работает с реальным DOM-объектом, а треки остаются фейковыми.
  const RealMediaStream = window.MediaStream;
  class FakeMediaStream extends RealMediaStream {
    private tracks: unknown[];

    constructor(tracks?: unknown[]) {
      super();
      this.tracks = tracks ? [...tracks] : [];
    }

    // id/active у нативного MediaStream — getter'ы без сеттеров,
    // поэтому переопределяем их именно геттерами.
    override get id(): string {
      return 'vl-fake-stream';
    }

    override get active(): boolean {
      return true;
    }

    getTracks(): unknown[] {
      return [...this.tracks];
    }

    getVideoTracks(): unknown[] {
      return this.tracks.filter((track) => (track as { kind?: string }).kind === 'video');
    }

    getAudioTracks(): unknown[] {
      return this.tracks.filter((track) => (track as { kind?: string }).kind === 'audio');
    }

    getTrackById(id: string): unknown {
      return this.tracks.find((track) => (track as { id?: string }).id === id) ?? null;
    }

    addTrack(track: unknown): void {
      this.tracks.push(track);
    }

    removeTrack(track: unknown): void {
      this.tracks = this.tracks.filter((item) => item !== track);
    }

    clone(): FakeMediaStream {
      return new FakeMediaStream(this.tracks);
    }

    addEventListener(): void {
      /* noop */
    }

    removeEventListener(): void {
      /* noop */
    }

    dispatchEvent(): boolean {
      return true;
    }
  }

  const fakeGetUserMedia = async (constraints?: { video?: unknown; audio?: unknown }): Promise<unknown> => {
    record('getUserMedia');
    const wantsVideo = Boolean(constraints && constraints.video);
    const wantsAudio = Boolean(constraints && constraints.audio);
    if (!wantsVideo && !wantsAudio) throw new Error('getUserMedia: пустые constraints');
    const kinds: Array<'audio' | 'video'> = [];
    if (wantsVideo) kinds.push('video');
    if (wantsAudio) kinds.push('audio');
    return new FakeMediaStream(kinds.map((kind) => makeTrack(kind)));
  };

  const fakeDevices = {
    getUserMedia: fakeGetUserMedia,
    enumerateDevices: async () => [
      { deviceId: 'default', groupId: 'vl-e2e', kind: 'audioinput', label: 'Микрофон e2e' },
      { deviceId: 'vl-screen', groupId: 'vl-e2e', kind: 'videoinput', label: 'Экран e2e' },
      { deviceId: 'default', groupId: 'vl-e2e', kind: 'audiooutput', label: 'Выход e2e' },
    ],
    getDisplayMedia: async () => new FakeMediaStream([makeTrack('video')]),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };

  try {
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, get: () => fakeDevices });
  } catch {
    try {
      (navigator as unknown as { mediaDevices: unknown }).mediaDevices = fakeDevices;
    } catch {
      /* среда не позволяет подменить mediaDevices */
    }
  }

  class FakeMediaRecorder {
    static isTypeSupported(mimeType: string): boolean {
      return typeof mimeType === 'string' && mimeType.startsWith('video/webm');
    }

    stream: unknown;
    mimeType: string;
    state: 'inactive' | 'recording' | 'paused' = 'inactive';
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    onstart: (() => void) | null = null;
    onpause: (() => void) | null = null;
    onresume: (() => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;

    private emittedData = false;
    private dataTimer: number | undefined;

    constructor(stream: unknown, options?: { mimeType?: string }) {
      this.stream = stream;
      this.mimeType = options?.mimeType ?? 'video/webm';
      record('recorder:new');
    }

    start(_timeslice?: number): void {
      if (this.state !== 'inactive') throw new Error('MediaRecorder already started');
      this.state = 'recording';
      record('recorder:start');
      if (this.onstart) this.onstart();
      // Реальный MediaRecorder с timeslice отдаёт чанки периодически; одного чанка
      // с полным WebM достаточно, чтобы проверить upload→finish→playback.
      this.dataTimer = window.setTimeout(() => this.emitData(), 300);
    }

    private emitData(): void {
      if (this.emittedData) return;
      this.emittedData = true;
      record('recorder:data');
      const blob = new Blob([fixtureBytes], { type: this.mimeType });
      if (this.ondataavailable) this.ondataavailable({ data: blob });
    }

    pause(): void {
      if (this.state !== 'recording') return;
      this.state = 'paused';
      record('recorder:pause');
      if (this.onpause) this.onpause();
    }

    resume(): void {
      if (this.state !== 'paused') return;
      this.state = 'recording';
      record('recorder:resume');
      if (this.onresume) this.onresume();
    }

    requestData(): void {
      this.emitData();
    }

    stop(): void {
      if (this.state === 'inactive') throw new Error('MediaRecorder is inactive');
      if (this.dataTimer !== undefined) {
        window.clearTimeout(this.dataTimer);
        this.dataTimer = undefined;
      }
      this.state = 'inactive';
      record('recorder:stop');
      // Чанк до onstop: очередь загрузки стартует раньше, чем store ждёт onstop.
      this.emitData();
      window.setTimeout(() => {
        if (this.onstop) this.onstop();
      }, 150);
    }

    addEventListener(type: string, listener: (event?: unknown) => void): void {
      if (type === 'dataavailable') this.ondataavailable = (event) => listener(event);
      else if (type === 'stop') this.onstop = () => listener();
      else if (type === 'pause') this.onpause = () => listener();
      else if (type === 'resume') this.onresume = () => listener();
      else if (type === 'start') this.onstart = () => listener();
    }

    removeEventListener(): void {
      /* noop */
    }

    dispatchEvent(): boolean {
      return true;
    }
  }

  try {
    Object.defineProperty(window, 'MediaStream', { configurable: true, writable: true, value: FakeMediaStream });
  } catch {
    /* noop */
  }
  try {
    Object.defineProperty(window, 'MediaRecorder', { configurable: true, writable: true, value: FakeMediaRecorder });
  } catch {
    /* noop */
  }

  // window.vl: Electron-API недоступен в браузере, но UI записи требует
  // getCaptureSources; остальные методы — минимальные заглушки.
  const vlApi = {
    getBackend: async () => ({ baseUrl: '', token: 'e2e-token' }),
    openFiles: async () => [],
    openFolder: async () => null,
    getPathForFile: () => '',
    revealInExplorer: async () => undefined,
    openExternal: async () => undefined,
    getAppInfo: async () => ({ version: 'e2e', dataDir: '', logsDir: '' }),
    onBackendStatus: () => () => undefined,
    log: () => undefined,
    getCaptureSources: async () => arg.sources.map((source) => ({ ...source })),
  };
  try {
    Object.defineProperty(window, 'vl', { configurable: true, writable: true, value: vlApi });
  } catch {
    (window as unknown as { vl: unknown }).vl = vlApi;
  }
}
