export const IPC = {
  backendGet: 'vl:backend:get',
  openFiles: 'vl:dialog:open-files',
  openFolder: 'vl:dialog:open-folder',
  reveal: 'vl:shell:reveal',
  openExternal: 'vl:shell:open-external',
  appInfo: 'vl:app:info',
  log: 'vl:log',
  backendStatus: 'vl:backend:status',
} as const;

export type BackendStatus = 'starting' | 'ready' | 'crashed' | 'stopped';

export interface BackendInfo {
  baseUrl: string;
  token: string;
}

export interface AppInfo {
  version: string;
  dataDir: string;
  logsDir: string;
}
