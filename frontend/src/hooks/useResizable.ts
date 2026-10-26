import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';

/**
 * Ресайз панели за сплиттер (pointer events).
 * `invert: true` — панель справа, поэтому движение влево увеличивает ширину.
 */
export interface UseResizableOptions {
  initialSize: number;
  min: number;
  max: number;
  axis?: 'x' | 'y';
  invert?: boolean;
  onChange?: (size: number) => void;
  onCommit?: (size: number) => void;
}

export interface UseResizableResult {
  size: number;
  dragging: boolean;
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
}

function clampSize(value: number, min: number, max: number): number {
  return Math.min(Math.max(Math.round(value), min), max);
}

export function useResizable(options: UseResizableOptions): UseResizableResult {
  const { initialSize, min, max, axis = 'x', invert = false, onChange, onCommit } = options;
  const [size, setSize] = useState(() => clampSize(initialSize, min, max));
  const [dragging, setDragging] = useState(false);
  const sizeRef = useRef(size);
  const draggingRef = useRef(false);
  const cleanupRef = useRef<(() => void) | null>(null);

  sizeRef.current = size;

  useEffect(() => {
    if (!draggingRef.current) {
      setSize(clampSize(initialSize, min, max));
    }
  }, [initialSize, min, max]);

  useEffect(
    () => () => {
      cleanupRef.current?.();
      cleanupRef.current = null;
    },
    [],
  );

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const startCoord = axis === 'x' ? event.clientX : event.clientY;
      const startSize = sizeRef.current;
      draggingRef.current = true;
      setDragging(true);

      const move = (moveEvent: PointerEvent): void => {
        if (!draggingRef.current) return;
        const coord = axis === 'x' ? moveEvent.clientX : moveEvent.clientY;
        const delta = (coord - startCoord) * (invert ? -1 : 1);
        const next = clampSize(startSize + delta, min, max);
        if (next !== sizeRef.current) {
          sizeRef.current = next;
          setSize(next);
          onChange?.(next);
        }
      };

      const finish = (): void => {
        if (!draggingRef.current) return;
        draggingRef.current = false;
        setDragging(false);
        cleanup();
        onCommit?.(sizeRef.current);
      };

      const cleanup = (): void => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', finish);
        window.removeEventListener('pointercancel', finish);
        cleanupRef.current = null;
      };

      cleanupRef.current?.();
      cleanupRef.current = cleanup;
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', finish);
      window.addEventListener('pointercancel', finish);
    },
    [axis, invert, max, min, onChange, onCommit],
  );

  return { size, dragging, onPointerDown };
}
