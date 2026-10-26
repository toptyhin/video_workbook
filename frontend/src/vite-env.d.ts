/// <reference types="vite/client" />
import type { VLApi } from './api/types';

declare global {
  interface Window {
    vl?: VLApi;
  }
}

export {};
