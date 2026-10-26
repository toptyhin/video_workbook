import { create } from 'zustand';

import { api } from '../api/client';
import type { Annotation, AnnotationInput, AnnotationPatch } from '../api/types';
import {
  ANNOTATION_COLORS,
  MIN_ANNOTATION_MS,
} from '../lib/constants';
import { t } from '../lib/i18n';
import { clampMs } from '../lib/timelineGeometry';
import { usePlayerStore, errorMessage } from './playerStore';
import { useUIStore } from './uiStore';
import type { ToastKind } from './uiStore';

/**
 * Метки текущего видео: CRUD, undo/redo (стек 50, только метки) и состояние диалога редактора.
 *
 * Интеграция:
 * - панель таймингов/таймлайн вызывают `createAtPlayhead`, `createFromRange`, `createFromRanges`,
 *   `openEditEditor`, `update`, `remove`;
 * - `<AnnotationEditor />` монтируется один раз на уровне приложения и читает `editor`;
 * - SSE-слой Lead'а вызывает `refresh(videoId)` после события `annotations.changed`.
 */

export interface AnnotationRange {
  start_ms: number;
  end_ms: number;
}

export interface AnnotationDraft {
  start_ms: number;
  end_ms: number;
  label: string;
  color: string;
  note: string;
  tag_ids: number[];
}

export type AnnotationEditorMode = 'create' | 'edit';

export interface AnnotationEditorState {
  mode: AnnotationEditorMode;
  /** id редактируемой метки; для режима create — null. */
  annotationId: number | null;
  draft: AnnotationDraft;
}

type AnnotationFields = Pick<
  Annotation,
  'start_ms' | 'end_ms' | 'label' | 'color' | 'note' | 'tag_ids'
>;

type UndoCommand =
  | { kind: 'create'; annotation: Annotation }
  | { kind: 'delete'; annotation: Annotation }
  | { kind: 'update'; id: number; before: AnnotationFields; after: AnnotationFields };

export interface AnnotationsState {
  videoId: number | null;
  loadedVideoId: number | null;
  items: Annotation[];
  selectedId: number | null;
  multiSelected: number[];
  /** Выделенные строки таймингов (диапазоны) — для Ctrl+M и bulk-создания. */
  timingSelection: AnnotationRange[];
  loading: boolean;
  error: string | null;
  editor: AnnotationEditorState | null;
  undoCount: number;
  redoCount: number;

  load: (videoId: number, force?: boolean) => Promise<void>;
  hydrate: (videoId: number, items: readonly Annotation[]) => void;
  refresh: (videoId?: number) => Promise<void>;
  reset: () => void;

  create: (draft: AnnotationDraft) => Promise<Annotation | null>;
  createFromRange: (range: AnnotationRange) => Promise<Annotation | null>;
  bulkCreate: (drafts: readonly AnnotationDraft[]) => Promise<Annotation[]>;
  createAtPlayhead: () => void;
  createFromRanges: (ranges: readonly AnnotationRange[]) => Promise<Annotation[]>;
  update: (id: number, patch: AnnotationPatch) => Promise<Annotation | null>;
  remove: (id: number, options?: { silent?: boolean }) => Promise<boolean>;
  removeSelected: () => Promise<void>;

  select: (id: number | null) => void;
  selectMulti: (ids: readonly number[]) => void;
  toggleMulti: (id: number) => void;
  clearSelection: () => void;
  setTimingSelection: (ranges: readonly AnnotationRange[]) => void;

  openCreateEditor: (partial?: Partial<AnnotationDraft>) => void;
  openEditEditor: (target: number | Annotation) => void;
  updateDraft: (patch: Partial<AnnotationDraft>) => void;
  saveEditor: (draft: AnnotationDraft) => Promise<boolean>;
  closeEditor: () => void;

  undo: () => Promise<void>;
  redo: () => Promise<void>;
  canUndo: () => boolean;
  canRedo: () => boolean;
}

const UNDO_LIMIT = 50;
const ANNOTATIONS_FETCH_LIMIT = 500;

let undoStack: UndoCommand[] = [];
let redoStack: UndoCommand[] = [];
let loadToken = 0;

function sortItems(items: readonly Annotation[]): Annotation[] {
  return [...items].sort(
    (a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms || a.id - b.id,
  );
}

function fieldsOf(annotation: Annotation): AnnotationFields {
  return {
    start_ms: annotation.start_ms,
    end_ms: annotation.end_ms,
    label: annotation.label,
    color: annotation.color,
    note: annotation.note,
    tag_ids: [...annotation.tag_ids],
  };
}

function fieldsToInput(videoId: number, fields: AnnotationFields): AnnotationInput {
  return { video_id: videoId, ...fields, tag_ids: [...fields.tag_ids] };
}

function fieldsToPatch(fields: AnnotationFields): AnnotationPatch {
  return {
    start_ms: fields.start_ms,
    end_ms: fields.end_ms,
    label: fields.label,
    color: fields.color,
    note: fields.note,
    tag_ids: [...fields.tag_ids],
  };
}

function draftFromAnnotation(annotation: Annotation): AnnotationDraft {
  return {
    start_ms: annotation.start_ms,
    end_ms: annotation.end_ms,
    label: annotation.label,
    color: annotation.color,
    note: annotation.note ?? '',
    tag_ids: [...annotation.tag_ids],
  };
}

function draftToInput(videoId: number, draft: AnnotationDraft): AnnotationInput {
  return { video_id: videoId, ...draftToBulkInput(draft) };
}

function draftToBulkInput(draft: AnnotationDraft): Omit<AnnotationInput, 'video_id'> {
  const note = draft.note.trim();
  return {
    start_ms: Math.round(draft.start_ms),
    end_ms: Math.round(draft.end_ms),
    label: draft.label.trim(),
    color: draft.color,
    note: note.length > 0 ? note : null,
    tag_ids: [...draft.tag_ids],
  };
}

function currentVideoId(): number | null {
  return useAnnotationsStore.getState().videoId ?? usePlayerStore.getState().videoId;
}

function syncPlayerUpsert(annotation: Annotation): void {
  const player = usePlayerStore.getState();
  if (player.videoId === annotation.video_id) player.upsertAnnotation(annotation);
}

function syncPlayerRemove(annotation: Annotation): void {
  const player = usePlayerStore.getState();
  if (player.videoId === annotation.video_id) player.removeAnnotation(annotation.id);
}

function notifyChanged(videoId: number | null, ids: readonly number[]): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent('vl:annotations:changed', {
      detail: { videoId, ids: [...ids] },
    }),
  );
}

function toast(kind: ToastKind, message: string): void {
  useUIStore.getState().pushToast({ kind, message });
}

function reportError(error: unknown): void {
  const message = errorMessage(error);
  useAnnotationsStore.setState({ error: message });
  toast('error', t('annotations.saveFailed', { message }));
}

function syncCounts(): void {
  useAnnotationsStore.setState({ undoCount: undoStack.length, redoCount: redoStack.length });
}

function pushUndo(command: UndoCommand): void {
  undoStack.push(command);
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  redoStack = [];
  syncCounts();
}

function resetHistory(): void {
  undoStack = [];
  redoStack = [];
  syncCounts();
}

function applyLocalUpsert(annotation: Annotation): void {
  useAnnotationsStore.setState((state) => {
    const exists = state.items.some((item) => item.id === annotation.id);
    const items = exists
      ? state.items.map((item) => (item.id === annotation.id ? annotation : item))
      : [...state.items, annotation];
    return { items: sortItems(items) };
  });
  syncPlayerUpsert(annotation);
}

function applyLocalRemove(annotation: Annotation): void {
  useAnnotationsStore.setState((state) => ({
    items: state.items.filter((item) => item.id !== annotation.id),
    selectedId: state.selectedId === annotation.id ? null : state.selectedId,
    multiSelected: state.multiSelected.filter((id) => id !== annotation.id),
  }));
  syncPlayerRemove(annotation);
}

async function resolveAnnotation(id: number): Promise<Annotation | null> {
  const local = useAnnotationsStore.getState().items.find((item) => item.id === id);
  if (local) return local;
  try {
    return await api.getAnnotation(id);
  } catch (error) {
    reportError(error);
    return null;
  }
}

async function revertCommand(command: UndoCommand): Promise<void> {
  if (command.kind === 'create') {
    await api.deleteAnnotation(command.annotation.id);
    applyLocalRemove(command.annotation);
    return;
  }
  if (command.kind === 'delete') {
    const created = await api.createAnnotation(fieldsToInput(command.annotation.video_id, fieldsOf(command.annotation)));
    command.annotation = created;
    applyLocalUpsert(created);
    useAnnotationsStore.setState({ selectedId: created.id });
    return;
  }
  const reverted = await api.patchAnnotation(command.id, fieldsToPatch(command.before));
  applyLocalUpsert(reverted);
}

async function applyCommand(command: UndoCommand): Promise<void> {
  if (command.kind === 'create') {
    const created = await api.createAnnotation(fieldsToInput(command.annotation.video_id, fieldsOf(command.annotation)));
    command.annotation = created;
    applyLocalUpsert(created);
    return;
  }
  if (command.kind === 'delete') {
    await api.deleteAnnotation(command.annotation.id);
    applyLocalRemove(command.annotation);
    return;
  }
  const applied = await api.patchAnnotation(command.id, fieldsToPatch(command.after));
  applyLocalUpsert(applied);
}

function defaultLabelForRange(range: AnnotationRange): string {
  const { segments } = usePlayerStore.getState();
  const overlap = segments.find(
    (segment) => segment.start_ms < range.end_ms && segment.end_ms > range.start_ms,
  );
  const text = overlap?.text.trim() ?? '';
  if (text.length > 0) return text.length > 80 ? `${text.slice(0, 80)}…` : text;
  return t('annotations.editorTitleCreate');
}

function draftAtPlayhead(): AnnotationDraft {
  const player = usePlayerStore.getState();
  const position = Math.max(0, player.positionMs);
  const duration = player.durationMs;
  let start = position;
  let end = position + 5000;
  if (duration > 0) end = Math.min(end, duration);
  if (end - start < MIN_ANNOTATION_MS) {
    if (duration > 0) {
      start = Math.max(0, duration - MIN_ANNOTATION_MS);
    }
    end = start + MIN_ANNOTATION_MS;
  }
  return {
    start_ms: Math.round(start),
    end_ms: Math.round(end),
    label: t('annotations.editorTitleCreate'),
    color: ANNOTATION_COLORS[0],
    note: '',
    tag_ids: [],
  };
}

export const useAnnotationsStore = create<AnnotationsState>((set, get) => ({
  videoId: null,
  loadedVideoId: null,
  items: [],
  selectedId: null,
  multiSelected: [],
  timingSelection: [],
  loading: false,
  error: null,
  editor: null,
  undoCount: 0,
  redoCount: 0,

  load: async (videoId, force = false) => {
    if (!force && get().loadedVideoId === videoId) return;
    const token = ++loadToken;
    if (get().videoId !== videoId) resetHistory();
    set({
      videoId,
      loading: true,
      error: null,
      ...(get().videoId !== videoId
        ? { items: [], selectedId: null, multiSelected: [], timingSelection: [], editor: null }
        : {}),
    });
    try {
      const response = await api.annotations({ video_id: videoId, limit: ANNOTATIONS_FETCH_LIMIT });
      if (token !== loadToken) return;
      const items = sortItems(response.items);
      set({ items, loading: false, loadedVideoId: videoId });
      if (usePlayerStore.getState().videoId === videoId) {
        usePlayerStore.getState().setAnnotations(items);
      }
    } catch (error) {
      if (token !== loadToken) return;
      set({ loading: false, error: errorMessage(error) });
    }
  },

  hydrate: (videoId, items) => {
    if (get().videoId !== videoId) resetHistory();
    const sorted = sortItems(items);
    set({
      videoId,
      loadedVideoId: videoId,
      items: sorted,
      loading: false,
      error: null,
    });
    if (usePlayerStore.getState().videoId === videoId) {
      usePlayerStore.getState().setAnnotations(sorted);
    }
  },

  refresh: async (videoId) => {
    const target = videoId ?? get().videoId;
    if (target === null) return;
    await get().load(target, true);
  },

  reset: () => {
    loadToken += 1;
    resetHistory();
    set({
      videoId: null,
      loadedVideoId: null,
      items: [],
      selectedId: null,
      multiSelected: [],
      timingSelection: [],
      loading: false,
      error: null,
      editor: null,
    });
  },

  create: async (draft) => {
    const videoId = currentVideoId();
    if (videoId === null) {
      reportError(new Error(t('annotations.noVideo')));
      return null;
    }
    try {
      const created = await api.createAnnotation(draftToInput(videoId, draft));
      pushUndo({ kind: 'create', annotation: created });
      applyLocalUpsert(created);
      set({ videoId, selectedId: created.id, error: null });
      toast('success', t('annotations.created'));
      notifyChanged(videoId, [created.id]);
      return created;
    } catch (error) {
      reportError(error);
      return null;
    }
  },

  createFromRange: async (range) => {
    const created = await get().create({
      start_ms: range.start_ms,
      end_ms: range.end_ms,
      label: defaultLabelForRange(range),
      color: ANNOTATION_COLORS[0],
      note: '',
      tag_ids: [],
    });
    if (created) get().openEditEditor(created);
    return created;
  },

  bulkCreate: async (drafts) => {
    const videoId = currentVideoId();
    if (videoId === null || drafts.length === 0) return [];
    try {
      const response = await api.bulkCreateAnnotations(
        videoId,
        drafts.map((draft) => draftToBulkInput(draft)),
      );
      for (const created of response.items) {
        pushUndo({ kind: 'create', annotation: created });
        applyLocalUpsert(created);
      }
      set({ videoId, error: null });
      toast('success', t('annotations.created'));
      notifyChanged(videoId, response.items.map((item) => item.id));
      return response.items;
    } catch (error) {
      reportError(error);
      return [];
    }
  },

  createAtPlayhead: () => {
    if (currentVideoId() === null) {
      reportError(new Error(t('annotations.noVideo')));
      return;
    }
    get().openCreateEditor();
  },

  createFromRanges: async (ranges) => {
    const duration = usePlayerStore.getState().durationMs;
    const prepared: AnnotationRange[] = [];
    for (const range of ranges) {
      const start = clampMs(range.start_ms, duration);
      const end = clampMs(range.end_ms, duration);
      const preparedRange = { start_ms: Math.min(start, end), end_ms: Math.max(start, end) };
      if (preparedRange.end_ms - preparedRange.start_ms >= MIN_ANNOTATION_MS) prepared.push(preparedRange);
    }
    if (prepared.length === 0) return [];
    return get().bulkCreate(
      prepared.map((range) => ({
        start_ms: range.start_ms,
        end_ms: range.end_ms,
        label: defaultLabelForRange(range),
        color: ANNOTATION_COLORS[0],
        note: '',
        tag_ids: [],
      })),
    );
  },

  update: async (id, patch) => {
    const before = await resolveAnnotation(id);
    if (!before) return null;
    try {
      const updated = await api.patchAnnotation(id, patch);
      pushUndo({ kind: 'update', id, before: fieldsOf(before), after: fieldsOf(updated) });
      applyLocalUpsert(updated);
      set({ error: null });
      notifyChanged(updated.video_id, [updated.id]);
      return updated;
    } catch (error) {
      reportError(error);
      return null;
    }
  },

  remove: async (id, options) => {
    const annotation = await resolveAnnotation(id);
    if (!annotation) return false;
    try {
      await api.deleteAnnotation(id);
      pushUndo({ kind: 'delete', annotation });
      applyLocalRemove(annotation);
      set({ error: null });
      if (!options?.silent) toast('info', t('annotations.deleted'));
      notifyChanged(annotation.video_id, [annotation.id]);
      return true;
    } catch (error) {
      reportError(error);
      return false;
    }
  },

  removeSelected: async () => {
    const state = get();
    const ids = state.multiSelected.length > 0
      ? [...state.multiSelected]
      : state.selectedId !== null
        ? [state.selectedId]
        : [];
    if (ids.length === 0) return;
    const removed: number[] = [];
    for (const id of ids) {
      const ok = await get().remove(id, { silent: true });
      if (ok) removed.push(id);
    }
    set({ selectedId: null, multiSelected: [] });
    if (removed.length > 0) toast('info', t('annotations.deleted'));
  },

  select: (id) => set({ selectedId: id }),

  selectMulti: (ids) => set({ multiSelected: [...ids] }),

  toggleMulti: (id) =>
    set((state) => ({
      multiSelected: state.multiSelected.includes(id)
        ? state.multiSelected.filter((item) => item !== id)
        : [...state.multiSelected, id],
    })),

  clearSelection: () => set({ selectedId: null, multiSelected: [], timingSelection: [] }),

  setTimingSelection: (ranges) =>
    set({ timingSelection: ranges.map((range) => ({ start_ms: range.start_ms, end_ms: range.end_ms })) }),

  openCreateEditor: (partial) => {
    const base = draftAtPlayhead();
    set({
      editor: {
        mode: 'create',
        annotationId: null,
        draft: { ...base, ...partial, tag_ids: partial?.tag_ids ? [...partial.tag_ids] : base.tag_ids },
      },
    });
  },

  openEditEditor: (target) => {
    const open = (annotation: Annotation): void => {
      set({ editor: { mode: 'edit', annotationId: annotation.id, draft: draftFromAnnotation(annotation) } });
    };
    if (typeof target !== 'number') {
      open(target);
      return;
    }
    const local = get().items.find((item) => item.id === target);
    if (local) {
      open(local);
      return;
    }
    void api
      .getAnnotation(target)
      .then(open)
      .catch((error: unknown) => reportError(error));
  },

  updateDraft: (patch) =>
    set((state) => {
      if (!state.editor) return state;
      const draft: AnnotationDraft = { ...state.editor.draft, ...patch };
      if (patch.tag_ids) draft.tag_ids = [...patch.tag_ids];
      return { editor: { ...state.editor, draft } };
    }),

  saveEditor: async (draft) => {
    const editor = get().editor;
    if (!editor) return false;
    if (editor.mode === 'create') {
      const created = await get().create(draft);
      if (!created) return false;
      set({ selectedId: created.id, editor: null });
      return true;
    }
    if (editor.annotationId === null) return false;
    const updated = await get().update(editor.annotationId, {
      start_ms: Math.round(draft.start_ms),
      end_ms: Math.round(draft.end_ms),
      label: draft.label.trim(),
      color: draft.color,
      note: draft.note.trim().length > 0 ? draft.note.trim() : null,
      tag_ids: [...draft.tag_ids],
    });
    if (!updated) return false;
    set({ editor: null });
    return true;
  },

  closeEditor: () => set({ editor: null }),

  undo: async () => {
    const command = undoStack.pop();
    if (!command) return;
    try {
      await revertCommand(command);
      redoStack.push(command);
      syncCounts();
      notifyChanged(useAnnotationsStore.getState().videoId, []);
    } catch (error) {
      undoStack.push(command);
      syncCounts();
      reportError(error);
    }
  },

  redo: async () => {
    const command = redoStack.pop();
    if (!command) return;
    try {
      await applyCommand(command);
      undoStack.push(command);
      syncCounts();
      notifyChanged(useAnnotationsStore.getState().videoId, []);
    } catch (error) {
      redoStack.push(command);
      syncCounts();
      reportError(error);
    }
  },

  canUndo: () => get().undoCount > 0,
  canRedo: () => get().redoCount > 0,
}));
