import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';

import { MAX_LABEL_LENGTH, MAX_NOTE_LENGTH, MIN_ANNOTATION_MS } from '../../lib/constants';
import { t } from '../../lib/i18n';
import { formatTimecodeWithMs, parseTimecode } from '../../lib/time';
import { useAnnotationsStore } from '../../state/annotationsStore';
import type { AnnotationDraft, AnnotationEditorMode } from '../../state/annotationsStore';
import { usePlayerStore } from '../../state/playerStore';
import { ColorSwatchPicker, HEX_COLOR_RE } from './ColorSwatchPicker';
import { TagPicker } from './TagPicker';
import './AnnotationEditor.css';

interface EditorDialogProps {
  mode: AnnotationEditorMode;
  annotationId: number | null;
  initialDraft: AnnotationDraft;
}

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'textarea:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function EditorDialog({ mode, annotationId, initialDraft }: EditorDialogProps): JSX.Element {
  const titleId = useId();
  const labelFieldId = useId();
  const startFieldId = useId();
  const endFieldId = useId();
  const noteFieldId = useId();

  const dialogRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLInputElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  const [startText, setStartText] = useState(() => formatTimecodeWithMs(initialDraft.start_ms));
  const [endText, setEndText] = useState(() => formatTimecodeWithMs(initialDraft.end_ms));
  const [label, setLabel] = useState(initialDraft.label);
  const [color, setColor] = useState(initialDraft.color);
  const [note, setNote] = useState(initialDraft.note);
  const [tagIds, setTagIds] = useState<number[]>(initialDraft.tag_ids);
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const durationMs = usePlayerStore((state) => state.durationMs);

  useEffect(() => {
    restoreFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    labelRef.current?.focus();
    return () => {
      const element = restoreFocusRef.current;
      if (element && element.isConnected) element.focus();
    };
  }, []);

  const startMs = parseTimecode(startText);
  const endMs = parseTimecode(endText);

  const rangeError =
    startMs === null || endMs === null
      ? t('annotations.invalidRange')
      : startMs < 0 || endMs <= startMs || endMs - startMs < MIN_ANNOTATION_MS
        ? t('annotations.invalidRange')
        : durationMs > 0 && endMs > durationMs
          ? t('annotations.invalidRange')
          : null;
  const labelError =
    label.trim().length === 0 || label.trim().length > MAX_LABEL_LENGTH
      ? t('annotations.invalidLabel')
      : null;
  const colorError = HEX_COLOR_RE.test(color) ? null : t('annotations.invalidColor');
  const noteError = note.length > MAX_NOTE_LENGTH ? t('annotations.invalidLabel') : null;
  const valid = rangeError === null && labelError === null && colorError === null && noteError === null;

  const close = useCallback(() => {
    useAnnotationsStore.getState().closeEditor();
  }, []);

  const save = useCallback(async () => {
    if (!valid || saving || startMs === null || endMs === null) return;
    setSaving(true);
    setServerError(null);
    const draft: AnnotationDraft = {
      start_ms: startMs,
      end_ms: endMs,
      label: label.trim(),
      color: color.toLowerCase(),
      note,
      tag_ids: [...tagIds],
    };
    const saved = await useAnnotationsStore.getState().saveEditor(draft);
    setSaving(false);
    if (!saved) {
      setServerError(useAnnotationsStore.getState().error ?? t('annotations.saveFailed', { message: '' }));
    }
  }, [color, endMs, label, note, saving, startMs, tagIds, valid]);

  const handleDelete = useCallback(() => {
    if (annotationId === null) return;
    void useAnnotationsStore.getState().remove(annotationId).then((removed) => {
      if (removed) close();
    });
  }, [annotationId, close]);

  const takeFromPlayer = (field: 'start' | 'end'): void => {
    const position = Math.round(usePlayerStore.getState().positionMs);
    const text = formatTimecodeWithMs(position);
    if (field === 'start') setStartText(text);
    else setEndText(text);
  };

  const trapFocus = (event: KeyboardEvent<HTMLDivElement>): void => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key === 'Tab') {
      trapFocus(event);
      return;
    }
    if (event.code === 'KeyI' && event.shiftKey) {
      event.preventDefault();
      setStartText(formatTimecodeWithMs(Math.round(usePlayerStore.getState().positionMs)));
      return;
    }
    if (event.code === 'KeyO' && event.shiftKey) {
      event.preventDefault();
      setEndText(formatTimecodeWithMs(Math.round(usePlayerStore.getState().positionMs)));
      return;
    }
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void save();
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      const target = event.target as HTMLElement;
      if (target.tagName === 'TEXTAREA' || target.tagName === 'BUTTON' || target.tagName === 'SELECT') return;
      event.preventDefault();
      void save();
    }
  };

  const title = mode === 'create' ? t('annotations.editorTitleCreate') : t('annotations.editorTitleEdit');

  return (
    <div
      className="vl-editor-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div
        className="vl-editor"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={dialogRef}
        onKeyDown={handleKeyDown}
      >
        <h2 className="vl-editor__title" id={titleId}>
          {title}
        </h2>
        <div className="vl-editor__grid">
          <div className="vl-editor__field">
            <label htmlFor={startFieldId}>{t('annotations.start')}</label>
            <div className="vl-editor__time-row">
              <input
                id={startFieldId}
                className="vl-editor__time"
                value={startText}
                spellCheck={false}
                aria-invalid={rangeError !== null}
                onChange={(event) => setStartText(event.target.value)}
              />
              <button type="button" className="vl-editor__take" onClick={() => takeFromPlayer('start')}>
                {t('annotations.takeFromPlayer')}
              </button>
            </div>
          </div>
          <div className="vl-editor__field">
            <label htmlFor={endFieldId}>{t('annotations.end')}</label>
            <div className="vl-editor__time-row">
              <input
                id={endFieldId}
                className="vl-editor__time"
                value={endText}
                spellCheck={false}
                aria-invalid={rangeError !== null}
                onChange={(event) => setEndText(event.target.value)}
              />
              <button type="button" className="vl-editor__take" onClick={() => takeFromPlayer('end')}>
                {t('annotations.takeFromPlayer')}
              </button>
            </div>
          </div>
        </div>
        {rangeError && (
          <p className="vl-editor__error" role="alert">
            {rangeError}
          </p>
        )}

        <div className="vl-editor__field">
          <label htmlFor={labelFieldId}>{t('annotations.label')}</label>
          <input
            id={labelFieldId}
            ref={labelRef}
            value={label}
            maxLength={MAX_LABEL_LENGTH}
            aria-invalid={labelError !== null}
            onChange={(event) => setLabel(event.target.value)}
          />
        </div>
        {labelError && (
          <p className="vl-editor__error" role="alert">
            {labelError}
          </p>
        )}

        <div className="vl-editor__field">
          <span className="vl-editor__field-label">{t('annotations.color')}</span>
          <ColorSwatchPicker value={color} onChange={setColor} />
        </div>
        {colorError && (
          <p className="vl-editor__error" role="alert">
            {colorError}
          </p>
        )}

        <div className="vl-editor__field">
          <span className="vl-editor__field-label">{t('annotations.tags')}</span>
          <TagPicker selected={tagIds} onChange={setTagIds} />
        </div>

        <div className="vl-editor__field">
          <label htmlFor={noteFieldId}>{t('annotations.note')}</label>
          <textarea
            id={noteFieldId}
            rows={3}
            value={note}
            maxLength={MAX_NOTE_LENGTH}
            onChange={(event) => setNote(event.target.value)}
          />
          <span className="vl-editor__counter">
            {note.length}/{MAX_NOTE_LENGTH}
          </span>
        </div>

        {serverError && (
          <p className="vl-editor__error" role="alert">
            {serverError}
          </p>
        )}

        <footer className="vl-editor__footer">
          {mode === 'edit' && (
            <button type="button" className="vl-editor__delete" onClick={handleDelete}>
              {t('common.delete')}
            </button>
          )}
          <span className="vl-editor__footer-spacer" />
          <button type="button" onClick={close}>
            {t('common.cancel')}
          </button>
          <button type="button" className="primary" disabled={!valid || saving} onClick={() => void save()}>
            {t('common.save')}
          </button>
        </footer>
      </div>
    </div>
  );
}

/**
 * Диалог метки, управляемый annotationsStore. Монтируется один раз на уровне приложения:
 * `openCreateEditor` / `openEditEditor` открывают его (в т.ч. из таймлайна и панели «Метки»).
 */
export function AnnotationEditor(): JSX.Element | null {
  const editor = useAnnotationsStore((state) => state.editor);
  if (!editor) return null;
  return (
    <EditorDialog
      key={`${editor.mode}:${editor.annotationId ?? 'new'}:${editor.draft.start_ms}:${editor.draft.end_ms}`}
      mode={editor.mode}
      annotationId={editor.annotationId}
      initialDraft={editor.draft}
    />
  );
}
