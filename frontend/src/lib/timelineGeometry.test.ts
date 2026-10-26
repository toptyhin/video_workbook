import { describe, expect, it } from 'vitest';

import {
  SNAP_GRID_MS,
  clampMs,
  msToPercent,
  msToPx,
  pxToMs,
  rangeToPercent,
  snapMs,
} from './timelineGeometry';

const DURATION = 600_000;
const WIDTH = 1000;

describe('timelineGeometry', () => {
  it('переводит ms в px и обратно без потерь', () => {
    const values = [0, 1, 999, 30_000, 75_123, 123_456, 599_999, 600_000];
    for (const ms of values) {
      const px = msToPx(ms, DURATION, WIDTH);
      expect(pxToMs(px, DURATION, WIDTH)).toBe(ms);
    }
  });

  it('бережёт границы и неизвестную длительность', () => {
    expect(msToPx(-500, DURATION, WIDTH)).toBe(0);
    expect(msToPx(DURATION + 5000, DURATION, WIDTH)).toBe(WIDTH);
    expect(pxToMs(-10, DURATION, WIDTH)).toBe(0);
    expect(pxToMs(WIDTH + 10, DURATION, WIDTH)).toBe(DURATION);
    expect(msToPx(1000, 0, WIDTH)).toBe(0);
    expect(pxToMs(100, DURATION, 0)).toBe(0);
    expect(clampMs(-10, 0)).toBe(0);
    expect(clampMs(12.6, 0)).toBe(13);
    expect(clampMs(Number.NaN, DURATION)).toBe(0);
  });

  it('считает проценты дорожки', () => {
    expect(rangeToPercent(60_000, 180_000, DURATION)).toEqual({ left: 10, width: 20 });
    expect(rangeToPercent(-1, 0, 0)).toEqual({ left: 0, width: 0 });
    expect(msToPercent(300_000, DURATION)).toBe(50);
  });

  it('привязывается к сетке и границам сегментов', () => {
    const segments = [
      { start_ms: 12_200, end_ms: 20_000 },
      { start_ms: 40_000, end_ms: 45_000 },
    ];
    // Близко к секундной сетке (10 050 → 10 000).
    expect(snapMs(10_050, { durationMs: DURATION, width: WIDTH, segments })).toBe(10_000);
    // Сегментная граница побеждает сетку, если она ближе (12 200 при радиусе 8px = 4800ms).
    expect(snapMs(12_350, { durationMs: DURATION, width: WIDTH, segments })).toBe(12_200);
    // Вне радиуса — значение не меняется.
    expect(snapMs(25_400, { durationMs: DURATION, width: WIDTH, segments, radiusPx: 0.5 })).toBe(25_400);
    // Своя сетка.
    expect(snapMs(25_100, { durationMs: DURATION, width: WIDTH, segments, gridMs: 500 })).toBe(25_000);
    // Неизвестная длительность/ширина — без изменений.
    expect(snapMs(25_100, { durationMs: 0, width: 0, segments })).toBe(25_100);
    expect(SNAP_GRID_MS).toBe(1000);
  });
});
