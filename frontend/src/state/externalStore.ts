import { create } from 'zustand';

import { api } from '../api/client';
import type { ExternalPlayer, ExternalStatus, SettingsValues } from '../api/types';

const POLL_INTERVAL_MS = 600;

export interface LaunchRequest {
  videoId: number;
  startMs: number;
}

export interface LaunchOptions {
  player?: string;
  startMs?: number;
  passMarks?: boolean;
  remember?: boolean;
}

type Policy = 'ask' | 'always' | 'never';

interface ExternalState {
  players: ExternalPlayer[];
  configured: string;
  policy: Policy;
  passMarks: boolean;
  status: ExternalStatus;
  ready: boolean;
  loading: boolean;
  error: string | null;
  launchRequest: LaunchRequest | null;
  init: () => Promise<void>;
  refreshPlayers: () => Promise<void>;
  refreshStatus: () => Promise<void>;
  openLaunch: (videoId: number, startMs?: number) => void;
  closeLaunch: () => void;
  setPolicy: (policy: Policy) => Promise<void>;
  launch: (options?: LaunchOptions) => Promise<boolean>;
  command: (action: string, value?: unknown) => Promise<void>;
  seek: (ms: number) => Promise<void>;
  toggle: () => Promise<void>;
  setVolume: (value: number) => Promise<void>;
  stop: () => Promise<void>;
  isActiveFor: (videoId: number | null) => boolean;
  syncPlayable: () => ExternalPlayer | null;
}

let pollTimer: number | undefined;

function stopPolling(): void {
  if (pollTimer !== undefined) {
    window.clearInterval(pollTimer);
    pollTimer = undefined;
  }
}

function startPolling(): void {
  if (pollTimer !== undefined) return;
  pollTimer = window.setInterval(() => {
    void useExternalStore.getState().refreshStatus();
  }, POLL_INTERVAL_MS);
}

const inactive: ExternalStatus = { active: false, session: null };

export const useExternalStore = create<ExternalState>((set, get) => ({
  players: [],
  configured: 'mpv',
  policy: 'ask',
  passMarks: true,
  status: inactive,
  ready: false,
  loading: false,
  error: null,
  launchRequest: null,

  init: async () => {
    set({ loading: true, error: null });
    try {
      const [players, status] = await Promise.all([api.externalPlayers(), api.externalStatus()]);
      set({
        players: players.items,
        configured: players.configured,
        policy: (players.policy as Policy) ?? 'ask',
        passMarks: players.pass_marks,
        status,
        ready: true,
        loading: false,
      });
      if (status.active) startPolling();
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : String(error) });
    }
  },

  refreshPlayers: async () => {
    try {
      const players = await api.externalPlayers();
      set({
        players: players.items,
        configured: players.configured,
        policy: (players.policy as Policy) ?? 'ask',
        passMarks: players.pass_marks,
      });
    } catch {
      /* плееры не критичны для запуска приложения */
    }
  },

  refreshStatus: async () => {
    try {
      const status = await api.externalStatus();
      set({ status });
      if (!status.active) stopPolling();
    } catch {
      stopPolling();
      set({ status: inactive });
    }
  },

  openLaunch: (videoId, startMs = 0) => set({ launchRequest: { videoId, startMs } }),
  closeLaunch: () => set({ launchRequest: null }),

  setPolicy: async (policy) => {
    const previous = get().policy;
    set({ policy });
    try {
      const settings: SettingsValues = { 'external.policy': policy };
      await api.patchSettings(settings);
    } catch {
      set({ policy: previous });
    }
  },

  launch: async (options = {}) => {
    const request = get().launchRequest;
    if (!request) return false;
    set({ loading: true, error: null });
    try {
      const response = await api.externalLaunch({
        video_id: request.videoId,
        start_ms: options.startMs ?? request.startMs,
        player: options.player,
        pass_marks: options.passMarks,
      });
      set({ status: response, loading: false, launchRequest: null });
      startPolling();
      if (options.remember) {
        const settings: SettingsValues = { 'external.pass_marks': options.passMarks ?? get().passMarks };
        if (options.player) settings['external.player'] = options.player;
        await api.patchSettings(settings).catch(() => undefined);
        await get().refreshPlayers();
      }
      return true;
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : String(error) });
      return false;
    }
  },

  command: async (action, value) => {
    try {
      const response = await api.externalCommand(action, value);
      set({ status: response });
      if (!response.active) stopPolling();
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },

  seek: async (ms) => {
    await get().command('seek', Math.max(0, Math.round(ms)));
  },

  toggle: async () => {
    await get().command('toggle');
  },

  setVolume: async (value) => {
    await get().command('volume', value);
  },

  stop: async () => {
    try {
      const response = await api.externalStop();
      set({ status: response });
    } catch {
      set({ status: inactive });
    }
    stopPolling();
  },

  isActiveFor: (videoId) => {
    if (videoId === null) return false;
    const status = get().status;
    return Boolean(status.active && status.session && status.session.video_id === videoId);
  },

  syncPlayable: () => get().players.find((player) => player.sync && player.available) ?? null,
}));
