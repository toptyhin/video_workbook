import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useSummaryStore } from '../../state/summaryStore';
import { DetailScale } from './DetailScale';

// jsdom не реализует PointerEvent; RTL/React ожидают его для pointer-событий.
if (typeof window.PointerEvent === 'undefined') {
  class PointerEventPolyfill extends MouseEvent {
    readonly pointerId: number;

    constructor(type: string, params: PointerEventInit = {}) {
      super(type, params);
      this.pointerId = params.pointerId ?? 1;
    }
  }
  (window as unknown as { PointerEvent: typeof PointerEventPolyfill }).PointerEvent = PointerEventPolyfill;
}

// jsdom в этом окружении не даёт localStorage (Node experimental) — подменяем in-memory Storage.
function installMemoryStorage(): void {
  const data = new Map<string, string>();
  const storage: Storage = {
    get length(): number {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key: string) => data.get(key) ?? null,
    key: (index: number) => Array.from(data.keys())[index] ?? null,
    removeItem: (key: string) => {
      data.delete(key);
    },
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
  Object.defineProperty(window, 'localStorage', { value: storage, configurable: true, writable: true });
}

interface HarnessProps {
  initial?: number;
  maxLevel: number;
  labels?: Record<number, string>;
  disabled?: boolean;
  generating?: boolean;
  onChange?: (level: number) => void;
}

function Harness({
  initial = 0,
  maxLevel,
  labels,
  disabled = false,
  generating = false,
  onChange,
}: HarnessProps): JSX.Element {
  const [value, setValue] = useState(initial);
  return (
    <DetailScale
      value={value}
      maxLevel={maxLevel}
      labels={labels}
      disabled={disabled}
      generating={generating}
      onChange={(level) => {
        setValue(level);
        onChange?.(level);
      }}
    />
  );
}

function trackRect(): void {
  const track = document.querySelector<HTMLElement>('.vl-detail-scale__track');
  if (!track) throw new Error('track not found');
  track.getBoundingClientRect = () =>
    ({
      top: 0,
      bottom: 200,
      left: 0,
      right: 44,
      width: 44,
      height: 200,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
}

function slider(): HTMLElement {
  return screen.getByRole('slider');
}

function detents(): NodeListOf<Element> {
  return document.querySelectorAll('[data-detent]');
}

beforeEach(() => {
  installMemoryStorage();
  window.localStorage.clear();
  useSummaryStore.setState({
    videoId: null,
    response: null,
    level: 0,
    maxLevel: 0,
    loading: false,
    generating: false,
    error: null,
    errorCode: null,
    modelMissing: false,
    enabled: true,
    settingsLoaded: true,
  });
});

describe('DetailScale (rev2, динамическая глубина)', () => {
  it('число детентов = maxLevel+1 и ARIA-контракт вертикального слайдера', () => {
    render(<Harness initial={2} maxLevel={3} labels={{ 0: 'Дословно', 1: 'Подробно', 2: 'Средне', 3: 'Кратко' }} />);
    expect(detents()).toHaveLength(4);
    const scale = slider();
    expect(scale).toHaveAttribute('aria-orientation', 'vertical');
    expect(scale).toHaveAttribute('aria-valuemin', '0');
    expect(scale).toHaveAttribute('aria-valuemax', '3');
    expect(scale).toHaveAttribute('aria-valuenow', '2');
    expect(scale).toHaveAttribute('aria-valuetext', 'Средне');
    expect(scale).toHaveAttribute('aria-label', 'Детализация');
    expect(scale).toHaveAttribute('tabindex', '0');
    expect(scale).toHaveAttribute('data-level', '2');
    expect(scale).toHaveAttribute('data-max-level', '3');
    expect(screen.getByTestId('detail-scale')).toHaveAttribute('data-max-level', '3');
  });

  it.each([1, 3, 5])('строит maxLevel+1 детентов для глубины %i', (maxLevel) => {
    render(<Harness initial={0} maxLevel={maxLevel} />);
    expect(detents()).toHaveLength(maxLevel + 1);
    expect(slider()).toHaveAttribute('aria-valuemax', String(maxLevel));
  });

  it('клампит значение по фактической глубине (value > maxLevel)', () => {
    render(<Harness initial={5} maxLevel={2} />);
    const scale = slider();
    expect(scale).toHaveAttribute('aria-valuenow', '2');
    expect(scale).toHaveAttribute('data-level', '2');
  });

  it('maxLevel=0: «Дословно» + провизорная «Саммари», шкала активна', () => {
    render(<Harness initial={3} maxLevel={0} />);
    expect(detents()).toHaveLength(2);
    const scale = slider();
    expect(scale).toHaveAttribute('aria-valuemax', '1');
    expect(scale).toHaveAttribute('aria-valuenow', '1');
    expect(scale).toHaveAttribute('data-max-level', '0');
    expect(scale).toHaveAttribute('data-effective-max', '1');
    expect(scale).toHaveAttribute('aria-valuetext', 'Саммари');
    expect(scale).not.toHaveAttribute('aria-disabled');
    expect(screen.getByRole('button', { name: 'Подробнее' })).toBeEnabled();
    fireEvent.keyDown(scale, { key: 'Home' });
    expect(slider()).toHaveAttribute('aria-valuenow', '0');
    expect(slider()).toHaveAttribute('aria-valuetext', 'Дословно');
    fireEvent.keyDown(slider(), { key: 'End' });
    expect(slider()).toHaveAttribute('aria-valuenow', '1');
  });

  it('берёт метки уровней из labels, иначе — динамический fallback', () => {
    render(<Harness initial={2} maxLevel={4} labels={{ 2: 'Своя метка' }} />);
    expect(slider()).toHaveAttribute('aria-valuetext', 'Своя метка');
    fireEvent.keyDown(slider(), { key: 'Home' });
    expect(slider()).toHaveAttribute('aria-valuetext', 'Дословно');
    fireEvent.keyDown(slider(), { key: 'End' });
    expect(slider()).toHaveAttribute('aria-valuetext', 'Уровень 4 из 4');
  });

  it('переключает уровень клавишами ↑/↓/PageUp/PageDown/Home/End в пределах maxLevel', () => {
    render(<Harness initial={2} maxLevel={4} />);
    const scale = slider();
    fireEvent.keyDown(scale, { key: 'ArrowUp' });
    expect(slider()).toHaveAttribute('aria-valuenow', '1');
    fireEvent.keyDown(scale, { key: 'ArrowDown' });
    expect(slider()).toHaveAttribute('aria-valuenow', '2');
    fireEvent.keyDown(scale, { key: 'PageUp' });
    expect(slider()).toHaveAttribute('aria-valuenow', '1');
    fireEvent.keyDown(scale, { key: 'PageDown' });
    expect(slider()).toHaveAttribute('aria-valuenow', '2');
    fireEvent.keyDown(scale, { key: 'End' });
    expect(slider()).toHaveAttribute('aria-valuenow', '4');
    fireEvent.keyDown(scale, { key: 'End' });
    expect(slider()).toHaveAttribute('aria-valuenow', '4');
    fireEvent.keyDown(scale, { key: 'Home' });
    expect(slider()).toHaveAttribute('aria-valuenow', '0');
  });

  it('не перехватывает клавиши, не относящиеся к шкале', () => {
    const onChange = vi.fn();
    render(<Harness initial={2} maxLevel={4} onChange={onChange} />);
    fireEvent.keyDown(slider(), { key: ' ' });
    fireEvent.keyDown(slider(), { key: 'ArrowLeft' });
    fireEvent.keyDown(slider(), { key: 'ArrowRight' });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('снапит к ближайшему детенту по pointer-событиям (maxLevel=3)', () => {
    render(<Harness initial={0} maxLevel={3} />);
    trackRect();
    const scale = slider();
    fireEvent.pointerDown(scale, { clientY: 150, pointerId: 1 });
    // 150/200 * 3 = 2.25 → 2
    expect(slider()).toHaveAttribute('aria-valuenow', '2');
    fireEvent.pointerMove(scale, { clientY: 40, pointerId: 1 });
    // 40/200 * 3 = 0.6 → 1
    expect(slider()).toHaveAttribute('aria-valuenow', '1');
    fireEvent.pointerUp(scale, { clientY: 40, pointerId: 1 });
  });

  it('лупы ведут к более/менее подробному и отключаются на границах', () => {
    render(<Harness initial={2} maxLevel={3} />);
    fireEvent.click(screen.getByRole('button', { name: 'Подробнее' }));
    expect(slider()).toHaveAttribute('aria-valuenow', '1');
    fireEvent.click(screen.getByRole('button', { name: 'Кратко' }));
    fireEvent.click(screen.getByRole('button', { name: 'Кратко' }));
    expect(slider()).toHaveAttribute('aria-valuenow', '3');
    expect(screen.getByRole('button', { name: 'Кратко' })).toBeDisabled();
  });

  it('disabled не реагирует на клавиши/pointer и кнопки', () => {
    render(<Harness initial={2} maxLevel={4} disabled />);
    const scale = slider();
    expect(scale).toHaveAttribute('aria-disabled', 'true');
    fireEvent.keyDown(scale, { key: 'ArrowUp' });
    trackRect();
    fireEvent.pointerDown(scale, { clientY: 150, pointerId: 1 });
    expect(slider()).toHaveAttribute('aria-valuenow', '2');
    expect(screen.getByRole('button', { name: 'Подробнее' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Кратко' })).toBeDisabled();
  });

  it('показывает пульсацию генерации (aria-busy)', () => {
    render(<Harness initial={2} maxLevel={4} generating />);
    expect(slider()).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByTestId('detail-scale').className).toContain('is-generating');
  });

  it('изменяет уровень колесом мыши в пределах maxLevel', () => {
    render(<Harness initial={3} maxLevel={4} />);
    fireEvent.wheel(slider(), { deltaY: 100 });
    expect(slider()).toHaveAttribute('aria-valuenow', '4');
    fireEvent.wheel(slider(), { deltaY: -100 });
    expect(slider()).toHaveAttribute('aria-valuenow', '3');
  });

  it('объявляет уровень через aria-live', () => {
    render(<Harness initial={2} maxLevel={4} labels={{ 2: 'Средне' }} />);
    expect(screen.getByText('Уровень: Средне')).toBeInTheDocument();
  });

  it('персистит выбранный уровень через summaryStore', () => {
    function StoreHarness(): JSX.Element {
      const level = useSummaryStore((state) => state.level);
      const maxLevel = useSummaryStore((state) => state.maxLevel);
      const setLevel = useSummaryStore((state) => state.setLevel);
      return <DetailScale value={level} maxLevel={maxLevel} onChange={setLevel} />;
    }
    useSummaryStore.setState({ maxLevel: 3, level: 0 });
    render(<StoreHarness />);
    fireEvent.keyDown(slider(), { key: 'End' });
    expect(useSummaryStore.getState().level).toBe(3);
    expect(document.querySelector('.vl-detail-scale__track')).toHaveAttribute('data-level', '3');
    const raw = window.localStorage.getItem('vl.ui.detailLevel');
    expect(raw ? (JSON.parse(raw) as { value: number }).value : null).toBe(3);
  });
});
