import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { IPC, type BackendInfo, type BackendStatus, type CaptureSourceInfo } from './ipc-channels';

const api = {
  getBackend: (): Promise<BackendInfo> => ipcRenderer.invoke(IPC.backendGet),
  openFiles: (): Promise<string[]> => ipcRenderer.invoke(IPC.openFiles),
  openFolder: (): Promise<string | null> => ipcRenderer.invoke(IPC.openFolder),
  getPathForFile: (file: File): string => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return (file as unknown as { path?: string }).path ?? '';
    }
  },
  revealInExplorer: (filePath: string): Promise<void> => ipcRenderer.invoke(IPC.reveal, filePath),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke(IPC.openExternal, url),
  getAppInfo: (): Promise<{ version: string; dataDir: string; logsDir: string }> =>
    ipcRenderer.invoke(IPC.appInfo),
  onBackendStatus: (callback: (status: BackendStatus) => void): (() => void) => {
    const handler = (_event: unknown, status: BackendStatus) => callback(status);
    ipcRenderer.on(IPC.backendStatus, handler);
    return () => ipcRenderer.removeListener(IPC.backendStatus, handler);
  },
  getCaptureSources: (): Promise<CaptureSourceInfo[]> => ipcRenderer.invoke(IPC.captureSources),
  log: (level: 'info' | 'warn' | 'error', message: string): void => {
    ipcRenderer.send(IPC.log, level, message);
  },
};

contextBridge.exposeInMainWorld('vl', api);
export type VLApi = typeof api;
