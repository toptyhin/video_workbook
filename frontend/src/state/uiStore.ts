import { create } from 'zustand';
import { STORAGE_KEYS } from '../lib/constants';
import { readStorage, writeStorage } from '../lib/storage';

export type Theme = 'light' | 'dark' | 'system';
export type SidebarTab = 'files' | 'tags';
export type ToastKind = 'info' | 'success' | 'warn' | 'error';

export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
  action?: { label: string; run: () => void };
}

interface UIState {
  theme: Theme;
  sidebarTab: SidebarTab;
  sidebarWidth: number;
  timingsWidth: number;
  timingsCollapsed: boolean;
  selectedVideoId: number | null;
  settingsOpen: boolean;
  hotkeysOpen: boolean;
  toasts: Toast[];
  backendReady: boolean;
  setTheme: (theme: Theme) => void;
  setSidebarTab: (tab: SidebarTab) => void;
  setSidebarWidth: (width: number) => void;
  setTimingsWidth: (width: number) => void;
  toggleTimings: () => void;
  selectVideo: (id: number | null) => void;
  setSettingsOpen: (open: boolean) => void;
  setHotkeysOpen: (open: boolean) => void;
  setBackendReady: (ready: boolean) => void;
  pushToast: (toast: Omit<Toast, 'id'>) => number;
  dismissToast: (id: number) => void;
}

let toastSeq = 0;

export const useUIStore = create<UIState>((set, get) => ({
  theme: readStorage<Theme>(STORAGE_KEYS.theme, 'system'),
  sidebarTab: readStorage<SidebarTab>(STORAGE_KEYS.sidebarTab, 'files'),
  sidebarWidth: readStorage<number>(STORAGE_KEYS.sidebarWidth, 260),
  timingsWidth: readStorage<number>(STORAGE_KEYS.timingsWidth, 320),
  timingsCollapsed: readStorage<boolean>(STORAGE_KEYS.timingsCollapsed, false),
  selectedVideoId: null,
  settingsOpen: false,
  hotkeysOpen: false,
  toasts: [],
  backendReady: false,

  setTheme: (theme) => {
    writeStorage(STORAGE_KEYS.theme, theme);
    set({ theme });
  },
  setSidebarTab: (sidebarTab) => {
    writeStorage(STORAGE_KEYS.sidebarTab, sidebarTab);
    set({ sidebarTab });
  },
  setSidebarWidth: (sidebarWidth) => {
    const width = Math.min(Math.max(sidebarWidth, 200), 520);
    writeStorage(STORAGE_KEYS.sidebarWidth, width);
    set({ sidebarWidth: width });
  },
  setTimingsWidth: (timingsWidth) => {
    const width = Math.min(Math.max(timingsWidth, 280), 560);
    writeStorage(STORAGE_KEYS.timingsWidth, width);
    set({ timingsWidth: width });
  },
  toggleTimings: () => {
    const timingsCollapsed = !get().timingsCollapsed;
    writeStorage(STORAGE_KEYS.timingsCollapsed, timingsCollapsed);
    set({ timingsCollapsed });
  },
  selectVideo: (selectedVideoId) => set({ selectedVideoId }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setHotkeysOpen: (hotkeysOpen) => set({ hotkeysOpen }),
  setBackendReady: (backendReady) => set({ backendReady }),

  pushToast: (toast) => {
    const id = ++toastSeq;
    set((state) => ({ toasts: [...state.toasts, { ...toast, id }] }));
    const timeout = toast.action ? 7000 : 4500;
    window.setTimeout(() => get().dismissToast(id), timeout);
    return id;
  },
  dismissToast: (id) => set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) })),
}));

export function applyTheme(theme: Theme): void {
  const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
  const resolved = theme === 'system' ? (prefersDark ? 'dark' : 'light') : theme;
  document.documentElement.setAttribute('data-theme', resolved);
}

export function pushError(error: unknown, prefix = 'Ошибка'): void {
  const message = error instanceof Error ? error.message : String(error);
  useUIStore.getState().pushToast({ kind: 'error', message: `${prefix}: ${message}` });
}
