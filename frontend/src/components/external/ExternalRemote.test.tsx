import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as client from '../../api/client';
import type { ExternalStatus } from '../../api/types';
import { useExternalStore } from '../../state/externalStore';
import { ExternalRemote } from './ExternalRemote';

vi.mock('../../api/client', () => ({
  api: { externalCommand: vi.fn(), externalStop: vi.fn() },
  mediaUrl: () => '/api/videos/1/thumb?token=t',
}));

const mocked = client.api as unknown as {
  externalCommand: ReturnType<typeof vi.fn>;
  externalStop: ReturnType<typeof vi.fn>;
};

const session: ExternalStatus = {
  active: true,
  session: {
    session_id: 's1',
    player: 'mpv',
    player_label: 'mpv',
    sync: true,
    video_id: 1,
    title: 'lesson',
    start_ms: 0,
    position_ms: 12_000,
    duration_ms: 60_000,
    paused: false,
    volume: 80,
    active: true,
    ended: false,
    chapters: true,
    subtitles: true,
  },
};

describe('ExternalRemote', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocked.externalCommand.mockResolvedValue(session);
    mocked.externalStop.mockResolvedValue({ active: false, session: null });
    useExternalStore.setState({ status: session });
  });

  it('показывает позицию и статус синхронизации', () => {
    render(<ExternalRemote videoId={1} title="lesson" />);
    expect(screen.getByText(/mpv · синхронизирован/)).toBeInTheDocument();
    expect(screen.getByText(/00:12/)).toBeInTheDocument();
  });

  it('переключает паузу и перематывает через mpv IPC', async () => {
    render(<ExternalRemote videoId={1} title="lesson" />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Пауза' }));
    expect(mocked.externalCommand).toHaveBeenCalledWith('toggle', undefined);
    await user.click(screen.getByRole('button', { name: '−5 с' }));
    expect(mocked.externalCommand).toHaveBeenCalledWith('seek', 7000);
    await user.click(screen.getByRole('button', { name: '+5 с' }));
    expect(mocked.externalCommand).toHaveBeenCalledWith('seek', 17000);
  });

  it('закрывает внешний плеер', async () => {
    render(<ExternalRemote videoId={1} title="lesson" />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Закрыть плеер' }));
    expect(mocked.externalStop).toHaveBeenCalled();
  });
});
