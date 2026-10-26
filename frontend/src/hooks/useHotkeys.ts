import { useEffect } from 'react';

import { useAnnotationsStore } from '../state/annotationsStore';
import { usePlayerStore } from '../state/playerStore';

/**
 * Единый глобальный keydown-хук (подключается один раз на приложение):
 * плеер (Space/←/→/J/K/L), метки (Ctrl+M, Delete, Ctrl+Z/Ctrl+Shift+Z, Esc).
 * Клавиши не перехватываются в полях ввода и при открытом диалоге метки.
 */

const EDITABLE_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

let installedCount = 0;

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return EDITABLE_TAGS.has(target.tagName);
}

function isModifier(event: KeyboardEvent): boolean {
  return event.ctrlKey || event.metaKey;
}

function createFromKeyboard(): void {
  const annotations = useAnnotationsStore.getState();
  if (annotations.timingSelection.length > 0) {
    void annotations.createFromRanges(annotations.timingSelection);
    return;
  }
  annotations.createAtPlayhead();
}

export function useHotkeys(): void {
  useEffect(() => {
    if (installedCount > 0) return;
    installedCount += 1;

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) return;
      if (isEditableTarget(event.target)) return;
      const annotations = useAnnotationsStore.getState();
      // Диалог редактора обрабатывает клавиши сам (Enter/Esc/Ctrl+Enter/Shift+I/O).
      if (annotations.editor) return;
      const player = usePlayerStore.getState();
      const modifier = isModifier(event);

      if (modifier && !event.altKey) {
        switch (event.code) {
          case 'KeyZ':
            event.preventDefault();
            if (event.shiftKey) void annotations.redo();
            else void annotations.undo();
            return;
          case 'KeyY':
            event.preventDefault();
            void annotations.redo();
            return;
          case 'KeyM':
            event.preventDefault();
            createFromKeyboard();
            return;
          default:
            return;
        }
      }
      if (event.altKey) return;

      switch (event.code) {
        case 'Space':
          event.preventDefault();
          player.toggle();
          return;
        case 'ArrowLeft':
          event.preventDefault();
          player.step(-5000);
          return;
        case 'ArrowRight':
          event.preventDefault();
          player.step(5000);
          return;
        case 'KeyJ':
          player.step(-10000);
          return;
        case 'KeyK':
          player.toggle();
          return;
        case 'KeyL':
          player.step(10000);
          return;
        case 'Delete':
        case 'Backspace':
          if (annotations.selectedId !== null || annotations.multiSelected.length > 0) {
            event.preventDefault();
            void annotations.removeSelected();
          }
          return;
        case 'Escape':
          annotations.clearSelection();
          annotations.closeEditor();
          return;
        default:
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      installedCount = Math.max(0, installedCount - 1);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);
}
