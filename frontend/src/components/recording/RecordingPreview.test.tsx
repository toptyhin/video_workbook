import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import type { CaptureSource } from '../../api/types';
import { t } from '../../lib/i18n';
import { useRecordStore } from '../../state/recordStore';
import { RecordingPreview } from './RecordingPreview';

const SOURCES: CaptureSource[] = [
  { id: 'screen:0:0', name: 'Экран 1', type: 'screen', thumbnail_data_url: '' },
];

/** В jsdom нет настоящего MediaStream — компоненту достаточно объекта-заглушки. */
const STREAM = {} as MediaStream;

interface PreviewOverrides {
  status?: 'preparing' | 'recording' | 'paused' | 'finalizing';
  elapsedMs?: number;
  previewStream?: MediaStream | null;
  selectedSourceId?: string | null;
}

function setPreviewState(overrides: PreviewOverrides = {}): void {
  useRecordStore.setState({
    status: 'recording',
    sources: SOURCES,
    selectedSourceId: 'screen:0:0',
    elapsedMs: 0,
    previewStream: STREAM,
    ...overrides,
  } as never);
}

function previewVideo(): HTMLVideoElement {
  const video = document.querySelector<HTMLVideoElement>('video.vl-rec-preview__video');
  if (!video) throw new Error('video предпросмотра не найден');
  return video;
}

beforeEach(() => {
  // jsdom не реализует play(); без заглушки он пишет «Not implemented» в stderr.
  vi.spyOn(window.HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  setPreviewState();
});

describe('RecordingPreview', () => {
  it('показывает живой поток, REC-бейдж, таймер и имя источника', () => {
    setPreviewState({ elapsedMs: 3_723_000 });

    render(<RecordingPreview />);

    expect(screen.getByRole('region', { name: t('recording.previewLabel') })).toBeInTheDocument();
    expect(screen.getByText(t('recording.barRecording'))).toBeInTheDocument();
    expect(screen.getByText('01:02:03')).toBeInTheDocument();
    expect(screen.getByText('Экран 1')).toBeInTheDocument();

    const video = previewVideo();
    expect(video.muted).toBe(true);
    expect(video.autoplay).toBe(true);
    expect(video.srcObject).toBe(STREAM);
  });

  it('в паузе помечает бейдж и не анимирует точку', () => {
    setPreviewState({ status: 'paused', elapsedMs: 5_000 });

    render(<RecordingPreview />);

    const badge = document.querySelector('.vl-rec-preview__badge');
    expect(badge).toHaveClass('is-paused');
    expect(badge).toHaveTextContent(t('recording.barPaused'));
    expect(document.querySelector('.vl-rec-preview__overlay')).not.toBeInTheDocument();
  });

  it('до появления потока показывает ожидание захвата', () => {
    setPreviewState({ status: 'preparing', previewStream: null });

    render(<RecordingPreview />);

    expect(screen.getByText(t('recording.barPreparing'))).toBeInTheDocument();
    expect(document.querySelector('.vl-rec-preview__overlay')).not.toBeInTheDocument();
  });

  it('во время финализации показывает оверлей сохранения', () => {
    setPreviewState({ status: 'finalizing' });

    render(<RecordingPreview />);

    expect(screen.getByText(t('recording.barFinalizing'))).toBeInTheDocument();
  });

  it('без выбранного источника подставляет нейтральную подпись', () => {
    setPreviewState({ selectedSourceId: null });

    render(<RecordingPreview />);

    expect(screen.getByText(t('recording.sourceUnknown'))).toBeInTheDocument();
  });
});
