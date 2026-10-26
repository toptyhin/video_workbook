import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as client from '../api/client';
import type { ExternalPlayersResponse, ExternalStatus } from '../api/types';
import { useExternalStore } from './externalStore';

vi.mock('../api/client', () => ({
  api: {
    externalPlayers: vi.fn(),
    externalStatus: vi.fn(),
    externalLaunch: vi.fn(),
    externalCommand: vi.fn(),
    externalStop: vi.fn(),
    patchSettings: vi.fn(),
  },
}));

const mocked = client.api as unknown as {
  externalPlayers: ReturnType<typeof vi.fn>;
  externalStatus: ReturnType<typeof vi.fn>;
  externalLaunch: ReturnType<typeof vi.fn>;
  externalCommand: ReturnType<typeof vi.fn>;
  externalStop: ReturnType<typeof vi.fn>;
  patchSettings: ReturnType<typeof vi.fn>;
};

const playersResponse: ExternalPlayersResponse = {
  items: [
    { id: 'mpv', label: 'mpv', path: '/usr/bin/mpv', available: true, sync: true },
    { id: 'vlc', label: 'VLC', path: null, available: false, sync: false },
    { id: 'system', label: 'Системный плеер', path: '/usr/bin/xdg-open', available: true, sync: false },
  ],
  configured: 'mpv',
  policy: 'ask',
  pass_marks: true,
};

const inactive: ExternalStatus = { active: false, session: null };
const active: ExternalStatus = {
  active: true,
  session: {
    session_id: 's1',
    player: 'mpv',
    player_label: 'mpv',
    sync: true,
    video_id: 5,
    title: 'lesson',
    start_ms: 1000,
    position_ms: 1200,
    duration_ms: 60_000,
    paused: false,
    volume: 100,
    active: true,
    ended: false,
    chapters: true,
    subtitles: true,
  },
};

describe('externalStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocked.externalPlayers.mockResolvedValue(playersResponse);
    mocked.externalStatus.mockResolvedValue(inactive);
    useExternalStore.setState({
      players: [],
      configured: 'mpv',
      policy: 'ask',
      passMarks: true,
      status: inactive,
      ready: false,
      loading: false,
      error: null,
      launchRequest: null,
    });
  });

  it('инициализирует плееры из API', async () => {
    await useExternalStore.getState().init();
    const state = useExternalStore.getState();
    expect(state.ready).toBe(true);
    expect(state.policy).toBe('ask');
    expect(state.players.find((item) => item.id === 'mpv')?.sync).toBe(true);
    expect(state.syncPlayable()?.id).toBe('mpv');
  });

  it('запускает внешний плеер и запоминает выбор', async () => {
    mocked.externalLaunch.mockResolvedValue(active);
    mocked.patchSettings.mockResolvedValue({});
    await useExternalStore.getState().init();
    useExternalStore.getState().openLaunch(5, 1000);
    const ok = await useExternalStore.getState().launch({ player: 'mpv', startMs: 1500, passMarks: true, remember: true });
    expect(ok).toBe(true);
    expect(mocked.externalLaunch).toHaveBeenCalledWith({
      video_id: 5,
      start_ms: 1500,
      player: 'mpv',
      pass_marks: true,
    });
    expect(mocked.patchSettings).toHaveBeenCalled();
    expect(useExternalStore.getState().status.active).toBe(true);
    expect(useExternalStore.getState().isActiveFor(5)).toBe(true);
    expect(useExternalStore.getState().isActiveFor(6)).toBe(false);
  });

  it('делегирует команды и обновляет состояние', async () => {
    mocked.externalCommand.mockResolvedValue(active);
    mocked.externalStatus.mockResolvedValue(active);
    useExternalStore.setState({ status: active });
    await useExternalStore.getState().seek(4200);
    expect(mocked.externalCommand).toHaveBeenCalledWith('seek', 4200);
    await useExternalStore.getState().toggle();
    expect(mocked.externalCommand).toHaveBeenCalledWith('toggle', undefined);
  });

  it('останавливает сессию', async () => {
    mocked.externalStop.mockResolvedValue(inactive);
    useExternalStore.setState({ status: active });
    await useExternalStore.getState().stop();
    expect(useExternalStore.getState().status.active).toBe(false);
  });
});
