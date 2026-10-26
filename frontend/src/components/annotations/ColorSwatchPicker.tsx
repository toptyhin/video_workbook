import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';

import { ANNOTATION_COLORS } from '../../lib/constants';
import { t } from '../../lib/i18n';
import './ColorSwatchPicker.css';

export interface ColorSwatchPickerProps {
  value: string;
  onChange: (color: string) => void;
  id?: string;
}

export const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

const FALLBACK_COLOR = ANNOTATION_COLORS[0];

export function ColorSwatchPicker({ value, onChange, id }: ColorSwatchPickerProps): JSX.Element {
  const [text, setText] = useState(value);
  const swatchRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const selected = HEX_COLOR_RE.test(value) ? value.toLowerCase() : '';

  useEffect(() => {
    setText(value);
  }, [value]);

  const focusSwatch = (index: number): void => {
    const count = ANNOTATION_COLORS.length;
    const next = ((index % count) + count) % count;
    swatchRefs.current[next]?.focus();
    onChange(ANNOTATION_COLORS[next]);
  };

  const handleSwatchKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        event.preventDefault();
        focusSwatch(index + 1);
        return;
      case 'ArrowLeft':
      case 'ArrowUp':
        event.preventDefault();
        focusSwatch(index - 1);
        return;
      case 'Home':
        event.preventDefault();
        focusSwatch(0);
        return;
      case 'End':
        event.preventDefault();
        focusSwatch(ANNOTATION_COLORS.length - 1);
        return;
      default:
    }
  };

  const handleHexChange = (next: string): void => {
    setText(next);
    if (HEX_COLOR_RE.test(next)) onChange(next.toLowerCase());
  };

  return (
    <div className="vl-colors">
      <div className="vl-colors__swatches" role="radiogroup" aria-label={t('annotations.color')} id={id}>
        {ANNOTATION_COLORS.map((color, index) => (
          <button
            key={color}
            ref={(element) => {
              swatchRefs.current[index] = element;
            }}
            type="button"
            role="radio"
            aria-checked={selected === color}
            aria-label={color}
            title={color}
            tabIndex={selected === color || (selected === '' && index === 0) ? 0 : -1}
            className={`vl-colors__swatch${selected === color ? ' is-selected' : ''}`}
            style={{ backgroundColor: color }}
            onClick={() => onChange(color)}
            onKeyDown={(event) => handleSwatchKeyDown(event, index)}
          />
        ))}
      </div>
      <label className="vl-colors__custom">
        <span className="sr-only">{t('annotations.customColor')}</span>
        <input
          type="color"
          value={selected === '' ? FALLBACK_COLOR : selected}
          aria-label={t('annotations.customColor')}
          onChange={(event) => onChange(event.target.value.toLowerCase())}
        />
      </label>
      <input
        type="text"
        className="vl-colors__hex"
        value={text}
        aria-label={t('annotations.colorHex')}
        placeholder="#rrggbb"
        spellCheck={false}
        onChange={(event) => handleHexChange(event.target.value)}
        onBlur={() => setText(value)}
      />
    </div>
  );
}
