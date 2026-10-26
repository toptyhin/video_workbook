import { eventsUrl } from './client';

export interface SSEEvent<T = unknown> {
  type: string;
  ts: string;
  payload: T;
}

export type SSEStatus = 'open' | 'error';

const EVENT_TYPES = [
  'hello',
  'video.status',
  'video.progress',
  'queue.state',
  'folder.scanned',
  'tags.changed',
  'annotations.changed',
  'settings.changed',
  'external.state',
  'backend.error',
] as const;

export function connectEvents(
  onEvent: (event: SSEEvent) => void,
  onStatus?: (status: SSEStatus) => void,
): () => void {
  let source: EventSource | null = null;
  let closed = false;
  let attempt = 0;
  let reconnectTimer: number | undefined;

  const open = () => {
    if (closed) return;
    source = new EventSource(eventsUrl());
    source.onopen = () => {
      attempt = 0;
      onStatus?.('open');
    };
    source.onerror = () => {
      onStatus?.('error');
      source?.close();
      source = null;
      if (closed) return;
      attempt = Math.min(attempt + 1, 5);
      reconnectTimer = window.setTimeout(open, 500 * 2 ** (attempt - 1));
    };
    for (const type of EVENT_TYPES) {
      source.addEventListener(type, (message) => {
        try {
          onEvent(JSON.parse((message as MessageEvent<string>).data) as SSEEvent);
        } catch {
          /* ignore malformed event */
        }
      });
    }
  };

  open();
  return () => {
    closed = true;
    if (reconnectTimer) window.clearTimeout(reconnectTimer);
    source?.close();
    source = null;
  };
}
