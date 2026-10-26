import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../api/client', () => ({
  api: {
    annotations: vi.fn(),
    getAnnotation: vi.fn(),
    createAnnotation: vi.fn(),
    bulkCreateAnnotations: vi.fn(),
    patchAnnotation: vi.fn(),
    deleteAnnotation: vi.fn(),
    tags: vi.fn(),
  },
  mediaUrl: (videoId: number, kind: string) => `/api/videos/${videoId}/${kind}`,
}));

import { api } from '../../api/client';
import type { Annotation, TagTreeResponse } from '../../api/types';
import { t } from '../../lib/i18n';
import { useAnnotationsStore, type AnnotationDraft } from '../../state/annotationsStore';
import { usePlayerStore } from '../../state/playerStore';
import { AnnotationEditor } from './AnnotationEditor';

function makeAnnotation(overrides: Partial<Annotation> = {}): Annotation {
  return {
    id: 7,
    video_id: 3,
    start_ms: 10_000,
    end_ms: 15_000,
    label: 'Важный фрагмент',
    color: '#3b82f6',
    note: null,
    tag_ids: [],
    created_at: '2026-01-01T00:00:00Z',
    updated_at: null,
    ...overrides,
  };
}

function openCreateEditor(draftOverrides: Partial<AnnotationDraft> = {}): void {
  const draft: AnnotationDraft = {
    start_ms: 10_000,
    end_ms: 15_000,
    label: '',
    color: '#3b82f6',
    note: '',
    tag_ids: [],
    ...draftOverrides,
  };
  useAnnotationsStore.setState({
    videoId: 3,
    editor: { mode: 'create', annotationId: null, draft },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  useAnnotationsStore.getState().reset();
  usePlayerStore.setState({ videoId: 3, durationMs: 60_000, positionMs: 12_000 });
  vi.mocked(api.tags).mockReturnValue(new Promise<TagTreeResponse>(() => undefined));
});

describe('AnnotationEditor', () => {
  it('блокирует сохранение без названия и показывает диалог', () => {
    openCreateEditor();
    render(<AnnotationEditor />);

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: t('common.save') })).toBeDisabled();
  });

  it('сохраняет валидную метку и закрывает диалог', async () => {
    openCreateEditor();
    vi.mocked(api.createAnnotation).mockResolvedValueOnce(makeAnnotation({ id: 12 }));
    render(<AnnotationEditor />);

    fireEvent.change(screen.getByLabelText(t('annotations.label')), {
      target: { value: 'Важный фрагмент' },
    });
    const save = screen.getByRole('button', { name: t('common.save') });
    expect(save).toBeEnabled();
    fireEvent.click(save);

    await waitFor(() => {
      expect(api.createAnnotation).toHaveBeenCalledTimes(1);
    });
    expect(api.createAnnotation).toHaveBeenCalledWith(
      expect.objectContaining({
        video_id: 3,
        start_ms: 10_000,
        end_ms: 15_000,
        label: 'Важный фрагмент',
        color: '#3b82f6',
      }),
    );
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  it('показывает ошибку диапазона и блокирует сохранение', () => {
    openCreateEditor();
    render(<AnnotationEditor />);

    fireEvent.change(screen.getByLabelText(t('annotations.start')), { target: { value: '00:20.000' } });

    expect(screen.getByText(t('annotations.invalidRange'))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: t('common.save') })).toBeDisabled();
  });

  it('закрывается по Esc без сохранения', () => {
    openCreateEditor();
    render(<AnnotationEditor />);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });

    expect(useAnnotationsStore.getState().editor).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.createAnnotation).not.toHaveBeenCalled();
  });
});
