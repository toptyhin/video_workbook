export const IPC = {
  backendGet: 'vl:backend:get',
  openFiles: 'vl:dialog:open-files',
  openFolder: 'vl:dialog:open-folder',
  reveal: 'vl:shell:reveal',
  openExternal: 'vl:shell:open-external',
  appInfo: 'vl:app:info',
  log: 'vl:log',
  backendStatus: 'vl:backend:status',
  captureSources: 'vl:capture:sources',
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

/** M11: экран/окно для захвата (дублируется в frontend/src/api/types.ts). */
export interface CaptureSourceInfo {
  /** `screen:0:0` | `window:12345` — годится как `chromeMediaSourceId`. */
  id: string;
  name: string;
  type: 'screen' | 'window';
  display_id?: string;
  /** PNG data URL (320×180). */
  thumbnail_data_url: string;
}
