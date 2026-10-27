import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('../../api/client', () => ({
  api: {
    recordingCapabilities: vi.fn(),
    startRecording: vi.fn(),
    uploadRecordingChunk: vi.fn(),
    pauseRecording: vi.fn(),
    resumeRecording: vi.fn(),
    finishRecording: vi.fn(),
    cancelRecording: vi.fn(),
    enqueue: vi.fn(),
  },
  getBaseUrl: () => '',
  getToken: () => '',
}));

import type { CaptureSource, RecordingCapabilities } from '../../api/types';
import { t } from '../../lib/i18n';
import { useRecordStore } from '../../state/recordStore';
import { RecordDialog } from './RecordDialog';

const SOURCES: CaptureSource[] = [
  {
    id: 'screen:0:0',
    name: 'Экран 1',
    type: 'screen',
    thumbnail_data_url: 'data:image/png;base64,AAAA',
  },
  {
    id: 'window:42',
    name: 'Терминал — bash',
    type: 'window',
    thumbnail_data_url: '',
  },
];

const CAPABILITIES: RecordingCapabilities = {
  system_audio: { available: true, detail: null },
  max_chunk_bytes: 1024,
};

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
  dialogOpen?: boolean;
  status?: string;
  error?: string | null;
  sources?: CaptureSource[];
  sourcesLoading?: boolean;
  capabilities?: RecordingCapabilities | null;
  audioInputs?: { device_id: string; label: string }[];
  selectedSourceId?: string | null;
  audioMode?: string;
  micDeviceId?: string | null;
  title?: string;
}

/** Диалог читает состояние из zustand — задаём его напрямую, действия мокаем. */
function setDialogState(overrides: StateOverrides = {}): void {
  useRecordStore.setState({
    dialogOpen: true,
    status: 'idle',
    error: null,
    sources: SOURCES,
    sourcesLoading: false,
    capabilities: CAPABILITIES,
    audioInputs: [{ device_id: 'mic-1', label: 'Микрофон USB' }],
    selectedSourceId: null,
    audioMode: 'mic',
    micDeviceId: null,
    quality: 'standard',
    title: '',
    elapsedMs: 0,
    bytesSent: 0,
    recordingId: null,
    lastVideoId: null,
    ...ACTIONS,
    ...overrides,
  } as never);
}

/** Радиокнопки режима звука ищем по `value`: подписи содержат пояснения. */
function audioRadio(value: string): HTMLInputElement {
  const nodes = screen.getAllByRole('radio') as HTMLInputElement[];
  const found = nodes.find((node) => node.tagName === 'INPUT' && node.value === value);
  if (!found) throw new Error(`audio radio "${value}" not found`);
  return found;
}

beforeEach(() => {
  vi.clearAllMocks();
  setDialogState();
});

describe('RecordDialog', () => {
  it('показывает источники на вкладках «Весь экран» и «Окно»', () => {
    render(<RecordDialog />);

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText(t('recording.dialogTitle'))).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: new RegExp(t('recording.tabScreen')) })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByText('Экран 1')).toBeInTheDocument();
    expect(screen.queryByText('Терминал — bash')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: new RegExp(t('recording.tabWindow')) }));

    expect(screen.getByText('Терминал — bash')).toBeInTheDocument();
  });

  it('выбирает источник кликом по карточке', () => {
    render(<RecordDialog />);

    fireEvent.click(screen.getByRole('radio', { name: /Экран 1/ }));

    expect(useRecordStore.getState().setSelectedSource).toHaveBeenCalledWith('screen:0:0');
  });

  it('блокирует старт без выбранного источника', () => {
    render(<RecordDialog />);

    const startButton = screen.getByRole('button', { name: t('recording.start') });
    expect(startButton).toBeDisabled();
    expect(screen.getByText(t('recording.needSource'))).toBeInTheDocument();

    act(() => {
      useRecordStore.setState({ selectedSourceId: 'screen:0:0' } as never);
    });

    expect(screen.getByRole('button', { name: t('recording.start') })).toBeEnabled();
  });

  it('запускает запись и закрывает диалог после успешного старта', async () => {
    setDialogState({ selectedSourceId: 'screen:0:0' });
    render(<RecordDialog />);

    fireEvent.click(screen.getByRole('button', { name: t('recording.start') }));

    await waitFor(() => expect(useRecordStore.getState().start).toHaveBeenCalledTimes(1));
    expect(useRecordStore.getState().closeDialog).not.toHaveBeenCalled();

    act(() => {
      useRecordStore.setState({ status: 'recording' } as never);
    });
    await waitFor(() => expect(useRecordStore.getState().closeDialog).toHaveBeenCalledTimes(1));
  });

  it('дизейблит системный звук и показывает причину из capabilities', () => {
    setDialogState({
      capabilities: {
        system_audio: { available: false, detail: 'pactl не найден' },
        max_chunk_bytes: 1024,
      },
    });

    render(<RecordDialog />);

    expect(audioRadio('system')).toBeDisabled();
    expect(audioRadio('mic_system')).toBeDisabled();
    expect(
      screen.getByText(t('recording.systemAudioUnavailable', { reason: 'pactl не найден' })),
    ).toBeInTheDocument();
  });

  it('по умолчанию предлагает системный звук, если микрофона нет', () => {
    setDialogState({ audioInputs: [], audioMode: 'mic' });

    render(<RecordDialog />);

    expect(audioRadio('mic')).toBeDisabled();
    expect(useRecordStore.getState().setAudioMode).toHaveBeenCalledWith('system');
  });

  it('переключает режим звука и устройство микрофона', () => {
    setDialogState({ audioMode: 'none' });
    render(<RecordDialog />);

    fireEvent.click(audioRadio('mic'));
    expect(useRecordStore.getState().setAudioMode).toHaveBeenCalledWith('mic');

    act(() => {
      useRecordStore.setState({ audioMode: 'mic' } as never);
    });
    fireEvent.change(screen.getByLabelText(t('recording.micDevice')), {
      target: { value: 'mic-1' },
    });
    expect(useRecordStore.getState().setMicDeviceId).toHaveBeenCalledWith('mic-1');
  });

  it('показывает оценку размера и формат WebM', () => {
    render(<RecordDialog />);

    expect(screen.getByText(t('recording.sizePerMin', { size: 22 }))).toBeInTheDocument();
    expect(screen.getByText(t('recording.formatNote'))).toBeInTheDocument();
  });

  it('закрывается по кнопке «Отмена» и по Esc', () => {
    render(<RecordDialog />);

    fireEvent.click(screen.getByRole('button', { name: t('common.cancel') }));
    expect(useRecordStore.getState().closeDialog).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(useRecordStore.getState().closeDialog).toHaveBeenCalledTimes(2);
  });

  it('показывает сообщение, когда Electron-API захвата недоступен', () => {
    setDialogState({ sources: [], sourcesLoading: false, capabilities: null });

    render(<RecordDialog />);

    expect(screen.getByText(t('recording.unavailable'))).toBeInTheDocument();
  });

  it('показывает ошибку запуска и блокирует повторный старт в preparing', () => {
    setDialogState({ status: 'error', error: 'NotAllowedError: permission denied' });

    render(<RecordDialog />);

    expect(
      screen.getByText(t('toast.error', { message: 'NotAllowedError: permission denied' })),
    ).toBeInTheDocument();
  });
});
