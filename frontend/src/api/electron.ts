import type { AppInfo, BackendInfo, BackendStatus, VLApi } from './types';

const BROWSER_TOKEN = import.meta.env.VITE_VL_TOKEN as string | undefined;

const browserFallback: VLApi = {
  getBackend: async () => ({ baseUrl: '', token: BROWSER_TOKEN ?? '' }),
  openFiles: async () => [],
  openFolder: async () => null,
  getPathForFile: (file: File) => (file as unknown as { path?: string }).path ?? '',
  revealInExplorer: async () => undefined,
  openExternal: async (url: string) => {
    window.open(url, '_blank', 'noopener');
  },
  getAppInfo: async (): Promise<AppInfo> => ({ version: 'dev', dataDir: '', logsDir: '' }),
  onBackendStatus: (_cb: (status: BackendStatus) => void) => () => undefined,
  log: (level, message) => {
    // eslint-disable-next-line no-console
    console[level === 'info' ? 'log' : level](`[vl] ${message}`);
  },
};

export function vl(): VLApi {
  return window.vl ?? browserFallback;
}

export async function backend(): Promise<BackendInfo> {
  return vl().getBackend();
}
