import { useEffect, useRef } from 'react';
import { connectEvents, type SSEEvent } from '../api/sse';

/** Подписка на SSE-события бэкенда с актуальным обработчиком. */
export function useSSE(onEvent: (event: SSEEvent) => void): void {
  const handlerRef = useRef(onEvent);
  handlerRef.current = onEvent;
  useEffect(() => {
    const disconnect = connectEvents((event) => handlerRef.current(event));
    return disconnect;
  }, []);
}
