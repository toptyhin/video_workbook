/**
 * Геометрия таймлайна: перевод миллисекунд в пиксели и обратно.
 *
 * Контракт для M5/M7 (`plans/05-player-timings-m5.md` T-05.6, `plans/07-annotations-m7.md` D6):
 * чистые функции без DOM; round-trip `pxToMs(msToPx(ms))` не теряет миллисекунды.
 */

export const SNAP_GRID_MS = 1000;
export const SNAP_RADIUS_PX = 8;

export interface TimeRange {
  start_ms: number;
  end_ms: number;
}

export interface SnapContext {
  durationMs: number;
  /** Ширина дорожки в px — нужна, чтобы перевести радиус привязки из px в ms. */
  width: number;
  segments: readonly TimeRange[];
  /** Сетка привязки в ms (по умолчанию 1 с). */
  gridMs?: number;
  /** Радиус привязки в px (по умолчанию 8 px). */
  radiusPx?: number;
  /**
   * @deprecated не используется; Alt обрабатывается вызывающим кодом.
   * Оставлено для совместимости с будущими вызовами.
   */
  disabled?: boolean;
}

/** Клампит миллисекунды в `[0, durationMs]`; при неизвестной длительности — только снизу. */
export function clampMs(ms: number, durationMs: number): number {
  if (!Number.isFinite(ms)) return 0;
  const rounded = Math.round(ms);
  if (!Number.isFinite(durationMs) || durationMs <= 0) return Math.max(0, rounded);
  return Math.min(Math.max(rounded, 0), Math.round(durationMs));
}

/** Позиция в px на дорожке шириной `width`; вне диапазона клампится. */
export function msToPx(ms: number, durationMs: number, width: number): number {
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(durationMs) || durationMs <= 0) return 0;
  return (clampMs(ms, durationMs) / durationMs) * width;
}

/** Координата x в px → миллисекунды; результат — целое число в `[0, durationMs]`. */
export function pxToMs(x: number, durationMs: number, width: number): number {
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(durationMs) || durationMs <= 0) return 0;
  return clampMs((x / width) * durationMs, durationMs);
}

/** Диапазон в проценты дорожки — удобно для `left`/`width` в CSS. */
export function rangeToPercent(startMs: number, endMs: number, durationMs: number): { left: number; width: number } {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return { left: 0, width: 0 };
  const start = clampMs(startMs, durationMs);
  const end = clampMs(endMs, durationMs);
  return {
    left: (start / durationMs) * 100,
    width: (Math.max(0, end - start) / durationMs) * 100,
  };
}

/** Одна точка в проценты дорожки. */
export function msToPercent(ms: number, durationMs: number): number {
  return rangeToPercent(ms, ms, durationMs).left;
}

/**
 * Привязка к сетке 1 с и к границам сегментов (`plans/07` D6).
 * Возвращает ближайший кандидат в пределах радиуса (в px), иначе — исходное значение.
 * Alt (отключение привязки) обрабатывает вызывающий код — здесь его нет.
 */
export function snapMs(ms: number, context: SnapContext): number {
  const { durationMs, width, segments } = context;
  const clamped = clampMs(ms, durationMs);
  if (durationMs <= 0 || width <= 0) return clamped;

  const gridMs = context.gridMs ?? SNAP_GRID_MS;
  const radiusPx = context.radiusPx ?? SNAP_RADIUS_PX;
  const radiusMs = (radiusPx / width) * durationMs;

  let candidate = clamped;
  let bestDistance = Number.POSITIVE_INFINITY;
  const consider = (value: number): void => {
    const snapped = clampMs(value, durationMs);
    const distance = Math.abs(snapped - clamped);
    if (distance <= radiusMs && distance < bestDistance) {
      bestDistance = distance;
      candidate = snapped;
    }
  };

  if (Number.isFinite(gridMs) && gridMs > 0) consider(Math.round(clamped / gridMs) * gridMs);
  for (const segment of segments) {
    consider(segment.start_ms);
    consider(segment.end_ms);
  }
  return candidate;
}
