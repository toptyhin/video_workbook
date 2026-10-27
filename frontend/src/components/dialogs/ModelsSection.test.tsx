import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const vlMock = vi.hoisted(() => ({
  openFolder: vi.fn(),
  revealInExplorer: vi.fn(),
  openExternal: vi.fn(),
}));

vi.mock('../../api/client', () => ({
  api: {
    models: vi.fn(),
    downloadModel: vi.fn(),
    cancelModel: vi.fn(),
    deleteModel: vi.fn(),
    importModel: vi.fn(),
    patchSettings: vi.fn(),
    getSettings: vi.fn(),
  },
}));

vi.mock('../../api/electron', () => ({
  vl: () => vlMock,
}));

import { api } from '../../api/client';
import type { ModelInfo, ModelListResponse } from '../../api/types';
import { useModelsStore } from '../../state/modelsStore';
import { ModelsSection } from './ModelsSection';

const MODELS_DIR = '/home/user/.local/share/videolessons/models';
const MODELS = {
  whisperSmall: 'whisper-small',
  whisperTiny: 'whisper-tiny',
  embedding: 'embedding-e5-small',
  summaryLfm: 'summary-lfm2.5-350m',
  summaryQwen: 'summary-qwen2.5-0.5b',
} as const;

function makeModel(overrides: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id: MODELS.whisperSmall,
    kind: 'transcription',
    label: 'Whisper small (CTranslate2, INT8)',
    installed: false,
    bundled: false,
    status: 'absent',
    revision: null,
    update_available: false,
    size_bytes: 488_079_201,
    progress: null,
    license: { name: 'MIT', url: 'https://huggingface.co/Systran/faster-whisper-small' },
    recommended: true,
    default: true,
    meta: {},
    path: null,
    error: null,
    error_code: null,
    ...overrides,
  };
}

const WHISPER_SMALL = makeModel({
  id: MODELS.whisperSmall,
  status: 'ready',
  installed: true,
});

const WHISPER_TINY = makeModel({
  id: MODELS.whisperTiny,
  label: 'Whisper tiny (CTranslate2, INT8)',
  recommended: false,
  default: false,
  size_bytes: 78_007_379,
});

const EMBEDDING = makeModel({
  id: MODELS.embedding,
  kind: 'embedding',
  label: 'Multilingual E5 small (ONNX)',
  recommended: false,
  default: false,
  status: 'bundled',
  bundled: true,
  installed: true,
  size_bytes: 118_000_000,
  license: { name: 'MIT', url: 'https://huggingface.co/intfloat/multilingual-e5-small' },
});

const SUMMARY_LFM = makeModel({
  id: MODELS.summaryLfm,
  kind: 'summary',
  label: 'LFM2.5-350M-Thinking (GGUF Q4_K_M)',
  status: 'downloading',
  progress: { bytes_received: 96_000_000, total_bytes: 229_314_528, percent: 42 },
  size_bytes: 229_314_528,
  license: { name: 'LFM Open License v1.0', url: 'https://www.liquid.ai/lfm-license' },
});

const SUMMARY_QWEN = makeModel({
  id: MODELS.summaryQwen,
  kind: 'summary',
  label: 'Qwen2.5-0.5B-Instruct (GGUF Q4_K_M)',
  recommended: false,
  default: false,
  size_bytes: 491_000_000,
  license: { name: 'Apache-2.0', url: 'https://www.apache.org/licenses/LICENSE-2.0' },
});

function makeResponse(
  items: ModelInfo[] = [WHISPER_SMALL, WHISPER_TINY, EMBEDDING, SUMMARY_LFM, SUMMARY_QWEN],
): ModelListResponse {
  return {
    items,
    total_installed_bytes: 488_079_201 + 118_000_000,
    total_available_bytes: 1_900_000_000,
    models_dir: MODELS_DIR,
    offline: false,
  };
}

function row(id: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(`[data-model-id="${id}"]`);
  if (!element) throw new Error(`row ${id} not found`);
  return element;
}

async function renderSection(): Promise<void> {
  render(<ModelsSection />);
  // Ждём завершения mount-загрузки (GET /api/models), не привязываясь к конкретной строке.
  await waitFor(() => {
    const state = useModelsStore.getState();
    expect(state.loading).toBe(false);
    expect(state.items.length > 0 || state.error !== null).toBe(true);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  useModelsStore.getState().reset();
  vi.mocked(api.models).mockResolvedValue(makeResponse());
  vi.mocked(api.getSettings).mockResolvedValue({ 'models.endpoint': '' });
  vi.mocked(api.downloadModel).mockResolvedValue({ id: MODELS.whisperTiny, status: 'queued' });
  vi.mocked(api.cancelModel).mockResolvedValue({ id: MODELS.summaryLfm, status: 'absent' });
  vi.mocked(api.deleteModel).mockResolvedValue(undefined);
  vi.mocked(api.importModel).mockResolvedValue({ id: MODELS.whisperTiny, status: 'verifying' });
  vi.mocked(api.patchSettings).mockResolvedValue({});
  vlMock.openFolder.mockResolvedValue('/tmp/models/whisper-tiny');
  vlMock.revealInExplorer.mockResolvedValue(undefined);
  vlMock.openExternal.mockResolvedValue(undefined);
});

describe('ModelsSection: группы и значки', () => {
  it('показывает обе summary-модели с бейджами «Рекомендованная» и «Альтернатива»', async () => {
    await renderSection();

    const summaryGroup = document.querySelector<HTMLElement>('[data-kind="summary"]');
    expect(summaryGroup).not.toBeNull();
    if (!summaryGroup) return;

    expect(within(summaryGroup).getByText(SUMMARY_LFM.label)).toBeInTheDocument();
    expect(within(summaryGroup).getByText(SUMMARY_QWEN.label)).toBeInTheDocument();
    expect(within(summaryGroup).getByText('Рекомендованная')).toBeInTheDocument();
    expect(within(summaryGroup).getByText('Альтернатива')).toBeInTheDocument();

    expect(within(row(MODELS.summaryLfm)).getByText('Рекомендованная')).toBeInTheDocument();
    expect(within(row(MODELS.summaryLfm)).queryByText('Альтернатива')).toBeNull();
    expect(within(row(MODELS.summaryQwen)).getByText('Альтернатива')).toBeInTheDocument();
    expect(within(row(MODELS.summaryQwen)).queryByText('Рекомендованная')).toBeNull();

    // Группы — по kind, все три заголовка на месте.
    expect(screen.getByText('Распознавание речи')).toBeInTheDocument();
    expect(screen.getByText('Семантический поиск')).toBeInTheDocument();
    expect(screen.getByText('Саммари')).toBeInTheDocument();
  });

  it('обе summary-модели можно устанавливать одновременно (две строки с «Скачать»)', async () => {
    vi.mocked(api.models).mockResolvedValue(
      makeResponse([
        makeModel({ ...SUMMARY_LFM, status: 'absent', progress: null }),
        makeModel({ ...SUMMARY_QWEN, status: 'absent', progress: null }),
      ]),
    );
    await renderSection();

    expect(within(row(MODELS.summaryLfm)).getByRole('button', { name: 'Скачать' })).toBeEnabled();
    expect(within(row(MODELS.summaryQwen)).getByRole('button', { name: 'Скачать' })).toBeEnabled();
  });
});

describe('ModelsSection: статусы', () => {
  it('ready → «Удалить», absent → «Скачать»/«Импорт», bundled → «Встроена»', async () => {
    await renderSection();

    expect(within(row(MODELS.whisperSmall)).getByRole('button', { name: 'Удалить' })).toBeInTheDocument();
    expect(within(row(MODELS.whisperSmall)).getByText('Установлена')).toBeInTheDocument();
    expect(within(row(MODELS.whisperTiny)).getByRole('button', { name: 'Скачать' })).toBeInTheDocument();
    expect(within(row(MODELS.whisperTiny)).getByRole('button', { name: 'Импорт из файла…' })).toBeInTheDocument();
    expect(within(row(MODELS.embedding)).getByText('Встроена')).toBeInTheDocument();
    expect(within(row(MODELS.embedding)).queryByRole('button')).toBeNull();
  });

  it('downloading → прогресс-бар с процентом и «Отмена»', async () => {
    await renderSection();

    const target = row(MODELS.summaryLfm);
    const bar = within(target).getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '42');
    expect(bar).toHaveAttribute('aria-valuemin', '0');
    expect(bar).toHaveAttribute('aria-valuemax', '100');
    expect(target.querySelector('.vl-models__progress-text')?.textContent).toContain('42%');
    expect(within(target).getByRole('button', { name: 'Отмена' })).toBeInTheDocument();
  });

  it('queued/verifying показывают подписи и «Отмена»', async () => {
    vi.mocked(api.models).mockResolvedValue(
      makeResponse([
        makeModel({ id: MODELS.whisperTiny, status: 'queued' }),
        makeModel({ id: MODELS.summaryLfm, kind: 'summary', status: 'verifying', recommended: true }),
      ]),
    );
    await renderSection();

    expect(within(row(MODELS.whisperTiny)).getByText('В очереди')).toBeInTheDocument();
    expect(within(row(MODELS.summaryLfm)).getByText('Проверка')).toBeInTheDocument();
    expect(within(row(MODELS.summaryLfm)).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
    expect(within(row(MODELS.whisperTiny)).getByRole('button', { name: 'Отмена' })).toBeInTheDocument();
  });

  it('ready с обновлением показывает «Обновить»', async () => {
    vi.mocked(api.models).mockResolvedValue(
      makeResponse([makeModel({ status: 'ready', installed: true, update_available: true })]),
    );
    await renderSection();

    fireEvent.click(within(row(MODELS.whisperSmall)).getByRole('button', { name: 'Обновить' }));
    await waitFor(() => {
      expect(api.downloadModel).toHaveBeenCalledWith(MODELS.whisperSmall);
    });
  });

  it('error показывает текст ошибки и «Повторить»', async () => {
    vi.mocked(api.models).mockResolvedValue(
      makeResponse([
        makeModel({
          status: 'error',
          error: 'Контрольная сумма не совпала',
          error_code: 'checksum_mismatch',
        }),
      ]),
    );
    await renderSection();

    const target = row(MODELS.whisperSmall);
    expect(within(target).getByText('Ошибка: Контрольная сумма не совпала')).toBeInTheDocument();
    fireEvent.click(within(target).getByRole('button', { name: 'Повторить' }));

    await waitFor(() => {
      expect(api.downloadModel).toHaveBeenCalledWith(MODELS.whisperSmall);
    });
  });

  it('insufficient_disk показывает «Освободите место» вместо сырого текста', async () => {
    vi.mocked(api.models).mockResolvedValue(
      makeResponse([
        makeModel({
          status: 'error',
          error: 'Недостаточно места на диске',
          error_code: 'insufficient_disk',
        }),
      ]),
    );
    await renderSection();

    expect(within(row(MODELS.whisperSmall)).getByText(/Недостаточно места/)).toBeInTheDocument();
  });
});

describe('ModelsSection: действия вызывают API', () => {
  it('«Скачать» → api.downloadModel + refresh списка', async () => {
    await renderSection();
    fireEvent.click(within(row(MODELS.whisperTiny)).getByRole('button', { name: 'Скачать' }));

    await waitFor(() => {
      expect(api.downloadModel).toHaveBeenCalledWith(MODELS.whisperTiny);
    });
    expect(api.models).toHaveBeenCalledTimes(2);
  });

  it('«Отмена» → api.cancelModel', async () => {
    await renderSection();
    fireEvent.click(within(row(MODELS.summaryLfm)).getByRole('button', { name: 'Отмена' }));

    await waitFor(() => {
      expect(api.cancelModel).toHaveBeenCalledWith(MODELS.summaryLfm);
    });
  });

  it('«Удалить» → подтверждение с размером → api.deleteModel', async () => {
    await renderSection();
    fireEvent.click(within(row(MODELS.whisperSmall)).getByRole('button', { name: 'Удалить' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Удалить модель «Whisper small/)).toBeInTheDocument();
    expect(within(dialog).getByText(/465 МБ/)).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Удалить' }));
    await waitFor(() => {
      expect(api.deleteModel).toHaveBeenCalledWith(MODELS.whisperSmall);
    });
  });

  it('«Импорт из файла…» → openFolder + importModel', async () => {
    await renderSection();
    fireEvent.click(within(row(MODELS.whisperTiny)).getByRole('button', { name: 'Импорт из файла…' }));

    await waitFor(() => {
      expect(vlMock.openFolder).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(api.importModel).toHaveBeenCalledWith(MODELS.whisperTiny, '/tmp/models/whisper-tiny');
    });
    expect(
      screen.getByText('Выберите папку с файлами модели или архив .zip/.tar.gz'),
    ).toBeInTheDocument();
  });

  it('«Открыть папку моделей» → revealInExplorer(modelsDir)', async () => {
    await renderSection();
    fireEvent.click(screen.getByRole('button', { name: 'Открыть папку моделей' }));

    expect(vlMock.revealInExplorer).toHaveBeenCalledWith(MODELS_DIR);
  });

  it('ссылка лицензии открывается через openExternal', async () => {
    await renderSection();
    fireEvent.click(within(row(MODELS.summaryQwen)).getByRole('link', { name: 'Apache-2.0' }));

    expect(vlMock.openExternal).toHaveBeenCalledWith('https://www.apache.org/licenses/LICENSE-2.0');
  });
});

describe('ModelsSection: зеркало и офлайн-режим', () => {
  it('офлайн-чекбокс патчит models.offline и блокирует «Скачать» с подсказкой', async () => {
    await renderSection();
    const checkbox = screen.getByLabelText('Офлайн-режим (запретить сеть)');
    expect(checkbox).not.toBeChecked();

    fireEvent.click(checkbox);

    await waitFor(() => {
      expect(api.patchSettings).toHaveBeenCalledWith({ 'models.offline': true });
    });
    const downloadButton = within(row(MODELS.whisperTiny)).getByRole('button', { name: 'Скачать' });
    await waitFor(() => {
      expect(downloadButton).toBeDisabled();
    });
    expect(downloadButton).toHaveAttribute('title', 'Офлайн-режим (запретить сеть)');
    expect(checkbox).toBeChecked();
  });

  it('поле «Зеркало моделей (URL)» сохраняет models.endpoint по blur', async () => {
    await renderSection();
    const input = screen.getByLabelText('Зеркало моделей (URL)');
    await waitFor(() => {
      expect(input).not.toBeDisabled();
    });

    fireEvent.change(input, { target: { value: 'https://hf-mirror.com' } });
    fireEvent.blur(input);

    await waitFor(() => {
      expect(api.patchSettings).toHaveBeenCalledWith({ 'models.endpoint': 'https://hf-mirror.com' });
    });
  });
});

describe('ModelsSection: загрузка', () => {
  it('ошибка загрузки списка → текст и «Повторить»', async () => {
    vi.mocked(api.models).mockRejectedValue(new Error('backend unavailable'));
    render(<ModelsSection />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Ошибка: backend unavailable');
    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));

    await waitFor(() => {
      expect(api.models).toHaveBeenCalledTimes(2);
    });
  });
});
