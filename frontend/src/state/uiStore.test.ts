import { beforeEach, describe, expect, it } from 'vitest';

import { STORAGE_KEYS } from '../lib/constants';
import { readStorage } from '../lib/storage';
import { useUIStore } from './uiStore';

const memory = new Map<string, string>();

function installMemoryStorage(): void {
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => {
        memory.set(key, String(value));
      },
      removeItem: (key: string) => {
        memory.delete(key);
      },
      clear: () => memory.clear(),
      key: (index: number) => Array.from(memory.keys())[index] ?? null,
      get length() {
        return memory.size;
      },
    },
  });
}

describe('uiStore previewHeight', () => {
  beforeEach(() => {
    installMemoryStorage();
    memory.clear();
    useUIStore.setState({ previewHeight: 380 });
  });

  it('клампит минимальную высоту', () => {
    useUIStore.getState().setPreviewHeight(10);
    expect(useUIStore.getState().previewHeight).toBe(200);
  });

  it('клампит максимальную высоту окном', () => {
    useUIStore.getState().setPreviewHeight(5000);
    const max = Math.max(320, window.innerHeight - 260);
    expect(useUIStore.getState().previewHeight).toBe(max);
  });

  it('сохраняет значение в localStorage', () => {
    useUIStore.getState().setPreviewHeight(333);
    expect(useUIStore.getState().previewHeight).toBe(333);
    expect(readStorage<number>(STORAGE_KEYS.previewHeight, 0)).toBe(333);
  });
});
