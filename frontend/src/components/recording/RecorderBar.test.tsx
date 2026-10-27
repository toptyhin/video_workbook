import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

const { enqueue } = vi.hoisted(() => ({
  enqueue: vi.fn(async () => ({ queued: [42], skipped: [] })),
}));

vi.mock('../../api/client', () => ({
  api: { enqueue },
  getBaseUrl: () => '',
  getToken: () => '',
}));

import type { CaptureSource } from '../../api/types';
import { formatBytes } from '../../lib/format';
import { t } from '../../lib/i18n';
import { useLibraryStore } from '../../state/libraryStore';
import { useRecordStore } from '../../state/recordStore';
import { useUIStore } from '../../state/uiStore';
import { RecorderBar } from './RecorderBar';

const SOURCES: CaptureSource[] = [
  {
    id: 'screen:0:0',
    name: 'Экран 1',
    type: 'screen',
    thumbnail_data_url: '',
  },
];

const refresh = vi.fn(async () => undefined);

const ACTIONS = {
  openDialog: vi.fn(),
  closeDialog: vi.fn(),
  loadSources: vi.fn(async () => undefined),
  setSelectedSource: vi.fn(),
  setAudioMode: vi.fn(),
  setMicDeviceId: vi.fn(),
  setQuality: vi.fn(),
  setTitle: vi.fn(),
  start: vi.fn(async () => undefined),
  pause: vi.fn(async () => undefined),
  resume: vi.fn(async () => undefined),
  stop: vi.fn(async () => null),
  cancel: vi.fn(async () => undefined),
  reset: vi.fn(),
};

interface StateOverrides {
  status?: string;
  error?: string | null;
  elapsedMs?: number;
  bytesSent?: number;
  sources?: CaptureSource[];
  selectedSourceId?: string | null;
  audioMode?: string;
  capabilities?: { system_audio: { available: boolean; detail: string | null }; max_chunk_bytes: number } | null;
}

function setBarState(overrides: StateOverrides = {}): void {
  useRecordStore.setState({
    dialogOpen: false,
    status: 'recording',
    error: null,
    sources: SOURCES,
    sourcesLoading: false,
    capabilities: null,
    audioInputs: [],
    selectedSourceId: 'screen:0:0',
    audioMode: 'none',
    micDeviceId: null,
    quality: 'standard',
    title: '',
    elapsedMs: 0,
    bytesSent: 0,
    recordingId: 'a'.repeat(32),
    lastVideoId: null,
    ...ACTIONS,
    ...overrides,
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  refresh.mockClear();
  useUIStore.setState({ toasts: [] });
  useLibraryStore.setState({ refresh } as never);
  setBarState();
});

describe('RecorderBar', () => {
  it('не рендерится в состоянии idle', () => {
    setBarState({ status: 'idle' });

    render(<RecorderBar />);

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByText(t('recording.barRecording'))).not.toBeInTheDocument();
  });

  it('показывает таймер HH:MM:SS, источник и размер', () => {
    setBarState({ status: 'recording', elapsedMs: 3_723_000, bytesSent: 5_242_880 });

    render(<RecorderBar />);

    expect(screen.getByText('01:02:03')).toBeInTheDocument();
    expect(screen.getByText(t('recording.barRecording'))).toBeInTheDocument();
    expect(screen.getByText('Экран 1')).toBeInTheDocument();
    expect(screen.getByText(formatBytes(5_242_880))).toBeInTheDocument();
  });

  it('ставит на паузу и продолжает запись', () => {
    render(<RecorderBar />);

    fireEvent.click(screen.getByRole('button', { name: t('recording.pause') }));
    expect(useRecordStore.getState().pause).toHaveBeenCalledTimes(1);

    act(() => setBarState({ status: 'paused' }));
    fireEvent.click(screen.getByRole('button', { name: t('recording.resume') }));
    expect(useRecordStore.getState().resume).toHaveBeenCalledTimes(1);
  });

  it('сохраняет запись: refresh библиотеки, toast, vl:open и enqueue по действию', async () => {
    const stop = vi.fn(async () => ({
      videoId: 42,
      title: 'Разбор задачи',
      durationMs: 61_000,
      sizeBytes: 2048,
      playbackMode: 'direct',
    }));
    useRecordStore.setState({ stop } as never);
    const onOpen = vi.fn();
    window.addEventListener('vl:open', onOpen);

    render(<RecorderBar />);
    fireEvent.click(screen.getByRole('button', { name: t('recording.save') }));

    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    const toasts = useUIStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.kind).toBe('success');
    expect(toasts[0]?.message).toBe(t('recording.saved', { title: 'Разбор задачи' }));
    expect(onOpen).toHaveBeenCalledTimes(1);
    const event = onOpen.mock.calls[0]?.[0] as CustomEvent<{ videoId: number }>;
    expect(event.detail.videoId).toBe(42);

    const action = toasts[0]?.action;
    expect(action?.label).toBe(t('recording.process'));
    action?.run();
    await waitFor(() => expect(enqueue).toHaveBeenCalledWith([42]));
    window.removeEventListener('vl:open', onOpen);
  });

  it('отменяет запись только после подтверждения', async () => {
    render(<RecorderBar />);

    fireEvent.click(screen.getByRole('button', { name: t('recording.cancel') }));
    expect(screen.getByText(t('recording.cancelConfirm'))).toBeInTheDocument();
    expect(useRecordStore.getState().cancel).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: t('recording.keep') }));
    expect(screen.queryByText(t('recording.cancelConfirm'))).not.toBeInTheDocument();
    expect(useRecordStore.getState().cancel).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: t('recording.cancel') }));
    fireEvent.click(screen.getByRole('button', { name: t('recording.discard') }));
    await waitFor(() => expect(useRecordStore.getState().cancel).toHaveBeenCalledTimes(1));
  });

  it('в состоянии ошибки показывает текст и кнопку отмены', async () => {
    setBarState({ status: 'error', error: 'finalize_failed: ffmpeg error' });

    render(<RecorderBar />);

    expect(screen.getByText(t('recording.barError'))).toBeInTheDocument();
    expect(screen.getByText('finalize_failed: ffmpeg error')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: t('recording.cancel') }));
    await waitFor(() => expect(useRecordStore.getState().cancel).toHaveBeenCalledTimes(1));
  });

  it('в состоянии finalizing показывает спиннер и не даёт сохранять повторно', () => {
    setBarState({ status: 'finalizing', elapsedMs: 12_000 });

    render(<RecorderBar />);

    expect(screen.getAllByText(t('recording.barFinalizing')).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: t('recording.save') })).not.toBeInTheDocument();
  });

  it('предупреждает о недоступном системном звуке в режиме mic_system', () => {
    setBarState({
      status: 'recording',
      audioMode: 'mic_system',
      capabilities: { system_audio: { available: false, detail: 'pactl не найден' }, max_chunk_bytes: 1 },
    });

    render(<RecorderBar />);

    expect(screen.getByText(t('recording.systemAudioFallback'))).toBeInTheDocument();
  });
});
