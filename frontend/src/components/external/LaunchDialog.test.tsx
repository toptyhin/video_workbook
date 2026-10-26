import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as client from '../../api/client';
import { useExternalStore } from '../../state/externalStore';
import { usePlayerStore } from '../../state/playerStore';
import { LaunchDialog } from './LaunchDialog';

vi.mock('../../api/client', () => ({
  api: {
    externalLaunch: vi.fn(),
    externalPlayers: vi.fn(),
    externalStatus: vi.fn(),
    patchSettings: vi.fn(),
  },
}));

const mocked = client.api as unknown as {
  externalLaunch: ReturnType<typeof vi.fn>;
  patchSettings: ReturnType<typeof vi.fn>;
};

describe('LaunchDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocked.externalLaunch.mockResolvedValue({ active: true, session: null });
    mocked.patchSettings.mockResolvedValue({});
    useExternalStore.setState({
      players: [
        { id: 'mpv', label: 'mpv', path: '/usr/bin/mpv', available: true, sync: true },
        { id: 'vlc', label: 'VLC', path: null, available: false, sync: false },
        { id: 'system', label: 'Системный плеер', path: '/usr/bin/xdg-open', available: true, sync: false },
      ],
      configured: 'mpv',
      policy: 'ask',
      passMarks: true,
      launchRequest: { videoId: 7, startMs: 0 },
      loading: false,
      error: null,
    });
    usePlayerStore.setState({ annotations: [], positionMs: 0 });
  });

  it('запускает выбранный плеер с выбранной позицией', async () => {
    render(<LaunchDialog />);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole('radio', { name: /С начала/ }));
    await user.click(screen.getByRole('button', { name: 'Смотреть' }));
    expect(mocked.externalLaunch).toHaveBeenCalledWith(
      expect.objectContaining({ video_id: 7, start_ms: 0, player: 'mpv' }),
    );
  });

  it('закрывается по Отмена', async () => {
    render(<LaunchDialog />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Отмена' }));
    expect(useExternalStore.getState().launchRequest).toBeNull();
  });
});
