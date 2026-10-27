import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent as ReactPointerEvent, WheelEvent } from 'react';

import { t } from '../../lib/i18n';
import { DETAIL_LEVEL_MIN, clampDetailLevel } from '../../state/summaryStore';
import './DetailScale.css';

/**
 * Вертикальная шкала детализации в правой части панели таймингов (M14 rev2).
 *
 * Число детентов = `maxLevel + 1`: позиция 0 — «Дословно» (сегменты), позиции
 * 1..maxLevel — уровни смыслового дерева этого видео (подписи берутся из
 * `response.levels[level].label`, при отсутствии — «Уровень N из M»).
 * Сверху — «лупа +» (к уровню 0), снизу — «лупа −» (к maxLevel).
 * Уровень 0 = максимум детализации, поэтому визуально он наверху,
 * а `aria-valuemin=0`/`aria-valuemax=maxLevel` сохраняют контракт ARIA-слайдера.
 */
export interface DetailScaleProps {
  /** Текущий уровень детализации 0…maxLevel (значение клампится по maxLevel). */
  value: number;
  /** Фактическая глубина дерева саммари конкретного видео (0 — только дословно). */
  maxLevel: number;
  /** Метки уровней (0…maxLevel) из дерева; отсутствующие заменяются fallback-текстом. */
  labels?: Record<number, string>;
  /** Нет видео/транскрипции или глубина 0 — шкала неактивна, но остаётся в DOM. */
  disabled?: boolean;
  /** Идёт генерация саммари — пульсация индикатора. */
  generating?: boolean;
  onChange: (level: number) => void;
}

const WHEEL_STEP = 24;

export function DetailScale({
  value,
  maxLevel,
  labels,
  disabled = false,
  generating = false,
  onChange,
}: DetailScaleProps): JSX.Element {
  const actualMax = Math.max(DETAIL_LEVEL_MIN, Math.floor(Number.isFinite(maxLevel) ? maxLevel : 0));
  // Пока дерева нет (maxLevel=0), показываем провизорную позицию «Саммари» (1),
  // чтобы можно было открыть CTA «Сгенерировать» при выключенной автогенерации.
  const max = actualMax > 0 ? actualMax : 1;
  const detents = useMemo(
    () => Array.from({ length: max + 1 }, (_, index) => index),
    [max],
  );
  const current = clampDetailLevel(value, max);
  const inactive = disabled;

  const trackRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef(false);
  const wheelRef = useRef(0);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const currentRef = useRef(current);
  currentRef.current = current;
  const maxRef = useRef(max);
  maxRef.current = max;
  const inactiveRef = useRef(inactive);
  inactiveRef.current = inactive;
  const [dragging, setDragging] = useState(false);

  const levelLabel = useCallback(
    (level: number): string => {
      if (level <= DETAIL_LEVEL_MIN) {
        return labels?.[DETAIL_LEVEL_MIN] ?? t('summary.levelTranscript');
      }
      return (
        labels?.[level] ??
        (actualMax === DETAIL_LEVEL_MIN
          ? t('summary.levelProvisional')
          : t('summary.levelDynamic', { level: Math.round(level), max: Math.max(max, level) }))
      );
    },
    [actualMax, labels, max],
  );

  const positionOf = (level: number): string =>
    max === DETAIL_LEVEL_MIN ? '0%' : `${(level / max) * 100}%`;

  const commit = useCallback((next: number) => {
    if (inactiveRef.current) return;
    const clamped = clampDetailLevel(next, maxRef.current);
    if (clamped !== currentRef.current) onChangeRef.current(clamped);
  }, []);

  // Сбрасываем накопление колеса, если пользователь ушёл со шкалы.
  useEffect(() => {
    wheelRef.current = 0;
  }, [value, max, disabled]);

  const levelFromPointer = useCallback((clientY: number): number => {
    const track = trackRef.current;
    if (!track) return currentRef.current;
    const rect = track.getBoundingClientRect();
    if (rect.height <= 0) return currentRef.current;
    const ratio = (clientY - rect.top) / rect.height;
    return clampDetailLevel(ratio * maxRef.current, maxRef.current);
  }, []);

  const capture = (element: HTMLElement, pointerId: number): void => {
    try {
      element.setPointerCapture(pointerId);
    } catch {
      /* jsdom/не Pointer Events — работаем без capture */
    }
  };

  const release = (element: HTMLElement, pointerId: number): void => {
    try {
      if (typeof element.hasPointerCapture === 'function' && element.hasPointerCapture(pointerId)) {
        element.releasePointerCapture(pointerId);
      }
    } catch {
      /* capture уже снят */
    }
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (inactiveRef.current || (event.button !== undefined && event.button !== 0)) return;
    event.preventDefault();
    event.currentTarget.focus();
    dragRef.current = true;
    setDragging(true);
    capture(event.currentTarget, event.pointerId);
    commit(levelFromPointer(event.clientY));
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!dragRef.current) return;
    commit(levelFromPointer(event.clientY));
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!dragRef.current) return;
    dragRef.current = false;
    setDragging(false);
    release(event.currentTarget, event.pointerId);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (inactiveRef.current) return;
    let next: number | null = null;
    switch (event.key) {
      // Уровень 0 сверху: ArrowUp/PageUp ведут к более подробному тексту.
      case 'ArrowUp':
      case 'PageUp':
        next = currentRef.current - 1;
        break;
      case 'ArrowDown':
      case 'PageDown':
        next = currentRef.current + 1;
        break;
      case 'Home':
        next = DETAIL_LEVEL_MIN;
        break;
      case 'End':
        next = maxRef.current;
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (next !== null) commit(next);
  };

  // Колесо мыши/тачпада: накапливаем дельту, чтобы не проскакивать детенты.
  // preventDefault не вызываем — React слушает wheel пассивно; секция под курсором
  // не скроллится, так что событие ничему не мешает.
  const handleWheel = (event: WheelEvent<HTMLDivElement>): void => {
    if (inactiveRef.current || Math.abs(event.deltaY) < 1) return;
    event.stopPropagation();
    wheelRef.current += event.deltaY;
    if (Math.abs(wheelRef.current) < WHEEL_STEP) return;
    const direction = wheelRef.current > 0 ? 1 : -1;
    wheelRef.current = 0;
    commit(currentRef.current + direction);
  };

  const stepToDetail = (): void => commit(currentRef.current - 1);
  const stepToSummary = (): void => commit(currentRef.current + 1);
  const levelText = levelLabel(current);

  return (
    <div
      className={`vl-detail-scale${inactive ? ' is-disabled' : ''}${generating ? ' is-generating' : ''}${
        dragging ? ' is-dragging' : ''
      }`}
      data-testid="detail-scale"
      data-max-level={actualMax}
      data-effective-max={max}
    >
      <button
        type="button"
        className="vl-detail-scale__zoom"
        aria-label={t('summary.moreDetail')}
        title={t('summary.moreDetail')}
        disabled={inactive || current === DETAIL_LEVEL_MIN}
        onClick={stepToDetail}
      >
        <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
          <circle cx="8.5" cy="8.5" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
          <line x1="12.6" y1="12.6" x2="17" y2="17" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          <line x1="8.5" y1="5.7" x2="8.5" y2="11.3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          <line x1="5.7" y1="8.5" x2="11.3" y2="8.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </button>

      <div
        ref={trackRef}
        className="vl-detail-scale__track"
        role="slider"
        aria-label={t('summary.detail')}
        aria-orientation="vertical"
        aria-valuemin={DETAIL_LEVEL_MIN}
        aria-valuemax={max}
        aria-valuenow={current}
        aria-valuetext={levelText}
        aria-disabled={inactive || undefined}
        aria-busy={generating || undefined}
        tabIndex={0}
        data-level={current}
        data-max-level={actualMax}
        data-effective-max={max}
        title={`${t('summary.detail')}: ${levelText}`}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onKeyDown={handleKeyDown}
        onWheel={handleWheel}
      >
        <div className="vl-detail-scale__lane" aria-hidden="true">
          <div className="vl-detail-scale__rail" />
          {detents.map((level) => (
            <div
              key={level}
              className={`vl-detail-scale__detent${level === current ? ' is-active' : ''}${
                level < current ? ' is-passed' : ''
              }`}
              style={{ top: positionOf(level) }}
              data-detent={level}
            >
              <span className="vl-detail-scale__dot" />
              <span className="vl-detail-scale__number">{level}</span>
            </div>
          ))}
          <div className="vl-detail-scale__thumb" style={{ top: positionOf(current) }} />
        </div>
      </div>

      <button
        type="button"
        className="vl-detail-scale__zoom"
        aria-label={t('summary.lessDetail')}
        title={t('summary.lessDetail')}
        disabled={inactive || current === max}
        onClick={stepToSummary}
      >
        <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
          <circle cx="8.5" cy="8.5" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
          <line x1="12.6" y1="12.6" x2="17" y2="17" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          <line x1="5.7" y1="8.5" x2="11.3" y2="8.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </button>

      <span className="sr-only" aria-live="polite">
        {t('summary.levelAnnounce', { name: levelText })}
      </span>
    </div>
  );
}
