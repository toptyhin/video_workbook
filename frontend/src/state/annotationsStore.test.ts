import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api/client', () => ({
  api: {
    annotations: vi.fn(),
    getAnnotation: vi.fn(),
    createAnnotation: vi.fn(),
    bulkCreateAnnotations: vi.fn(),
    patchAnnotation: vi.fn(),
    deleteAnnotation: vi.fn(),
  },
  mediaUrl: (videoId: number, kind: string) => `/api/videos/${videoId}/${kind}`,
}));

import { api } from '../api/client';
import type { Annotation } from '../api/types';
import { useAnnotationsStore, type AnnotationDraft } from './annotationsStore';
import { usePlayerStore } from './playerStore';

function makeAnnotation(overrides: Partial<Annotation> = {}): Annotation {
  return {
    id: 1,
    video_id: 3,
    start_ms: 1000,
    end_ms: 6000,
    label: 'Метка',
    color: '#3b82f6',
    note: null,
    tag_ids: [],
    created_at: '2026-01-01T00:00:00Z',
    updated_at: null,
    ...overrides,
  };
}

function makeDraft(overrides: Partial<AnnotationDraft> = {}): AnnotationDraft {
  return {
    start_ms: 1000,
    end_ms: 6000,
    label: 'Пример',
    color: '#3b82f6',
    note: '',
    tag_ids: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useAnnotationsStore.getState().reset();
  useAnnotationsStore.setState({ videoId: 3 });
  usePlayerStore.setState({ videoId: 3, segments: [], annotations: [] });
});

describe('annotationsStore', () => {
  it('создаёт метку и откатывает/повторяет создание', async () => {
    const created = makeAnnotation({ id: 10, label: 'Пример' });
    vi.mocked(api.createAnnotation).mockResolvedValueOnce(created);
    vi.mocked(api.deleteAnnotation).mockResolvedValue(undefined);
    vi.mocked(api.createAnnotation).mockResolvedValueOnce({ ...created, id: 11 });

    const result = await useAnnotationsStore.getState().create(makeDraft());
    expect(result?.id).toBe(10);
    expect(useAnnotationsStore.getState().items).toHaveLength(1);
    expect(useAnnotationsStore.getState().undoCount).toBe(1);
    expect(api.createAnnotation).toHaveBeenCalledWith(
      expect.objectContaining({ video_id: 3, label: 'Пример', start_ms: 1000, end_ms: 6000 }),
    );

    await useAnnotationsStore.getState().undo();
    expect(api.deleteAnnotation).toHaveBeenCalledWith(10);
    expect(useAnnotationsStore.getState().items).toHaveLength(0);
    expect(useAnnotationsStore.getState().undoCount).toBe(0);
    expect(useAnnotationsStore.getState().redoCount).toBe(1);

    await useAnnotationsStore.getState().redo();
    expect(api.createAnnotation).toHaveBeenCalledTimes(2);
    expect(useAnnotationsStore.getState().items[0]?.id).toBe(11);
    expect(useAnnotationsStore.getState().undoCount).toBe(1);
  });

  it('удаляет метку и восстанавливает её с полями и тегами', async () => {
    const annotation = makeAnnotation({ id: 5, label: 'Важное', note: 'заметка', tag_ids: [2, 4] });
    useAnnotationsStore.setState({ items: [annotation] });
    vi.mocked(api.deleteAnnotation).mockResolvedValue(undefined);
    const recreated = makeAnnotation({ id: 21, label: 'Важное', note: 'заметка', tag_ids: [2, 4] });
    vi.mocked(api.createAnnotation).mockResolvedValueOnce(recreated);

    const removed = await useAnnotationsStore.getState().remove(5);
    expect(removed).toBe(true);
    expect(api.deleteAnnotation).toHaveBeenCalledWith(5);
    expect(useAnnotationsStore.getState().items).toHaveLength(0);

    await useAnnotationsStore.getState().undo();
    expect(api.createAnnotation).toHaveBeenCalledWith(
      expect.objectContaining({
        video_id: 3,
        start_ms: 1000,
        end_ms: 6000,
        label: 'Важное',
        note: 'заметка',
        tag_ids: [2, 4],
      }),
    );
    expect(useAnnotationsStore.getState().items[0]?.id).toBe(21);

    await useAnnotationsStore.getState().redo();
    expect(api.deleteAnnotation).toHaveBeenLastCalledWith(21);
    expect(useAnnotationsStore.getState().items).toHaveLength(0);
  });

  it('откатывает правку полей на прежние значения', async () => {
    const before = makeAnnotation({ id: 7, label: 'Старое', start_ms: 2000, end_ms: 9000, note: 'n' });
    useAnnotationsStore.setState({ items: [before] });
    vi.mocked(api.patchAnnotation).mockResolvedValueOnce({ ...before, label: 'Новое' });

    const updated = await useAnnotationsStore.getState().update(7, { label: 'Новое' });
    expect(updated?.label).toBe('Новое');
    expect(api.patchAnnotation).toHaveBeenCalledWith(7, { label: 'Новое' });

    vi.mocked(api.patchAnnotation).mockResolvedValueOnce(before);
    await useAnnotationsStore.getState().undo();
    expect(api.patchAnnotation).toHaveBeenLastCalledWith(
      7,
      expect.objectContaining({ start_ms: 2000, end_ms: 9000, label: 'Старое', note: 'n', tag_ids: [] }),
    );
    expect(useAnnotationsStore.getState().items[0]?.label).toBe('Старое');
  });

  it('ограничивает стек 50 командами', async () => {
    let nextId = 1;
    vi.mocked(api.createAnnotation).mockImplementation(async () =>
      makeAnnotation({ id: nextId++, label: `Метка ${nextId}` }),
    );

    for (let index = 0; index < 51; index += 1) {
      await useAnnotationsStore.getState().create(makeDraft({ start_ms: index * 1000, end_ms: index * 1000 + 500 }));
    }
    expect(useAnnotationsStore.getState().undoCount).toBe(50);
    expect(useAnnotationsStore.getState().canUndo()).toBe(true);
  });

  it('сбрасывает историю при смене видео и при загрузке другого видео', async () => {
    vi.mocked(api.createAnnotation).mockResolvedValueOnce(makeAnnotation({ id: 30 }));
    await useAnnotationsStore.getState().create(makeDraft());
    expect(useAnnotationsStore.getState().undoCount).toBe(1);

    vi.mocked(api.annotations).mockResolvedValueOnce({ items: [makeAnnotation({ id: 31, video_id: 8 })], total: 1 });
    await useAnnotationsStore.getState().load(8);

    expect(useAnnotationsStore.getState().videoId).toBe(8);
    expect(useAnnotationsStore.getState().loadedVideoId).toBe(8);
    expect(useAnnotationsStore.getState().items).toHaveLength(1);
    expect(useAnnotationsStore.getState().undoCount).toBe(0);
    expect(useAnnotationsStore.getState().redoCount).toBe(0);
  });
});
