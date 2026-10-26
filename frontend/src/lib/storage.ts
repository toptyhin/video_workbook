interface Envelope<T> {
  v: 1;
  value: T;
}

export function readStorage<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Envelope<T>;
    if (parsed && parsed.v === 1) return parsed.value;
    return fallback;
  } catch {
    return fallback;
  }
}

export function writeStorage<T>(key: string, value: T): void {
  try {
    const envelope: Envelope<T> = { v: 1, value };
    window.localStorage.setItem(key, JSON.stringify(envelope));
  } catch {
    /* квота/приватный режим — игнорируем */
  }
}

export function removeStorage(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}
