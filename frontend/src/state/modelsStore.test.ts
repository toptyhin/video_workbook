import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api/client', () => ({
  api: {
    models: vi.fn(),
    downloadModel: vi.fn(),
    cancelModel: vi.fn(),
    deleteModel: vi.fn(),
    importModel: vi.fn(),
    patchSettings: vi.fn(),
  },
}));

import { api } from '../api/client';
import type { ModelInfo, ModelListResponse } from '../api/types';
import { useModelsStore } from './modelsStore';

const listModels = vi.mocked(api.models);
const downloadModel = vi.mocked(api.downloadModel);
const cancelModel = vi.mocked(api.cancelModel);
const deleteModel = vi.mocked(api.deleteModel);
const importModel = vi.mocked(api.importModel);
const patchSettings = vi.mocked(api.patchSettings);

const SUMMARY_LFM = 'summary-lfm2.5-350m';

function makeModel(overrides: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id: 'whisper-small',
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

function makeResponse(
  items: ModelInfo[],
  overrides: Partial<ModelListResponse> = {},
): ModelListResponse {
  return {
    items,
    total_installed_bytes: 488_079_201,
    total_available_bytes: 1_500_000_000,
    models_dir: '/home/user/.local/share/videolessons/models',
    offline: false,
    ...overrides,
  };
}

function codedError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

beforeEach(() => {
  vi.clearAllMocks();
  useModelsStore.getState().reset();
});

describe('modelsStore.load', () => {
  it('заполняет список, суммы, каталог и офлайн-флаг', async () => {
    listModels.mockResolvedValue(
      makeResponse([makeModel(), makeModel({ id: SUMMARY_LFM, kind: 'summary' })], {
        offline: true,
      }),
    );

    await useModelsStore.getState().load();

    const state = useModelsStore.getState();
    expect(state.loading).toBe(false);
    expect(state.error).toBeNull();
    expect(state.items).toHaveLength(2);
    expect(state.totalInstalledBytes).toBe(488_079_201);
    expect(state.totalAvailableBytes).toBe(1_500_000_000);
    expect(state.modelsDir).toBe('/home/user/.local/share/videolessons/models');
    expect(state.offline).toBe(true);
    expect(listModels).toHaveBeenCalledTimes(1);
  });

  it('сохраняет сообщение об ошибке, если бэкенд недоступен', async () => {
    listModels.mockRejectedValue(new Error('backend unavailable'));

    await useModelsStore.getState().load();

    const state = useModelsStore.getState();
    expect(state.loading).toBe(false);
    expect(state.error).toBe('backend unavailable');
    expect(state.items).toEqual([]);
  });
});

describe('modelsStore.applyEvent', () => {
  it('model.progress обновляет прогресс без сетевого запроса', () => {
    useModelsStore.setState({
      items: [
        makeModel({
          status: 'downloading',
          progress: { bytes_received: 10, total_bytes: 100, percent: 10 },
        }),
      ],
    });

    useModelsStore.getState().applyEvent({
      type: 'model.progress',
      payload: {
        model_id: 'whisper-small',
        status: 'downloading',
        bytes_received: 50,
        total_bytes: 100,
        percent: 50,
      },
    });

    const item = useModelsStore.getState().items[0];
    expect(item.status).toBe('downloading');
    expect(item.progress).toEqual({ bytes_received: 50, total_bytes: 100, percent: 50 });
    expect(listModels).not.toHaveBeenCalled();
  });

  it('model.progress игнорирует неизвестные события', () => {
    useModelsStore.setState({ items: [makeModel()] });

    useModelsStore.getState().applyEvent({ type: 'video.progress', payload: { model_id: 'x' } });
    useModelsStore.getState().applyEvent({ type: 'model.progress', payload: null });

    expect(useModelsStore.getState().items[0].status).toBe('absent');
    expect(listModels).not.toHaveBeenCalled();
  });

  it('model.state с ошибкой проставляет статус, текст и код', () => {
    useModelsStore.setState({ items: [makeModel({ status: 'downloading' })] });

    useModelsStore.getState().applyEvent({
      type: 'model.state',
      payload: {
        model_id: 'whisper-small',
        status: 'error',
        error: 'Контрольная сумма не совпала',
        error_code: 'checksum_mismatch',
      },
    });

    const item = useModelsStore.getState().items[0];
    expect(item.status).toBe('error');
    expect(item.error).toBe('Контрольная сумма не совпала');
    expect(item.error_code).toBe('checksum_mismatch');
    expect(item.progress).toBeNull();
    expect(listModels).not.toHaveBeenCalled();
  });

  it('model.state ready перечитывает список', async () => {
    useModelsStore.setState({
      items: [makeModel({ status: 'downloading', progress: { bytes_received: 1, total_bytes: 2, percent: 50 } })],
    });
    listModels.mockResolvedValue(makeResponse([makeModel({ status: 'ready', installed: true })]));

    useModelsStore.getState().applyEvent({
      type: 'model.state',
      payload: { model_id: 'whisper-small', status: 'ready' },
    });

    await vi.waitFor(() => {
      expect(listModels).toHaveBeenCalledTimes(1);
    });
    expect(useModelsStore.getState().items[0].status).toBe('ready');
  });

  it('model.state о неизвестной модели инициирует перезагрузку', async () => {
    listModels.mockResolvedValue(makeResponse([makeModel()]));

    useModelsStore.getState().applyEvent({
      type: 'model.state',
      payload: { model_id: 'unknown-model', status: 'ready' },
    });

    await vi.waitFor(() => {
      expect(listModels).toHaveBeenCalledTimes(1);
    });
  });
});

describe('modelsStore.download', () => {
  it('вызывает api и перечитывает список', async () => {
    listModels.mockResolvedValue(makeResponse([makeModel({ status: 'queued' })]));
    downloadModel.mockResolvedValue({ id: 'whisper-small', status: 'queued' });

    await useModelsStore.getState().download('whisper-small');

    expect(downloadModel).toHaveBeenCalledWith('whisper-small');
    expect(listModels).toHaveBeenCalledTimes(1);
    expect(useModelsStore.getState().items[0].status).toBe('queued');
  });

  it('при ошибке переводит строку в error с кодом', async () => {
    useModelsStore.setState({ items: [makeModel()] });
    downloadModel.mockRejectedValue(codedError('Офлайн-режим: сеть запрещена', 'offline_mode'));

    await useModelsStore.getState().download('whisper-small');

    const state = useModelsStore.getState();
    expect(state.error).toBe('Офлайн-режим: сеть запрещена');
    expect(state.items[0].status).toBe('error');
    expect(state.items[0].error).toBe('Офлайн-режим: сеть запрещена');
    expect(state.items[0].error_code).toBe('offline_mode');
    expect(listModels).not.toHaveBeenCalled();
  });
});

describe('modelsStore.cancel/remove/import', () => {
  it('cancel вызывает api и перечитывает список', async () => {
    listModels.mockResolvedValue(makeResponse([makeModel({ status: 'absent' })]));
    cancelModel.mockResolvedValue({ id: 'whisper-small', status: 'absent' });

    await useModelsStore.getState().cancel('whisper-small');

    expect(cancelModel).toHaveBeenCalledWith('whisper-small');
    expect(listModels).toHaveBeenCalledTimes(1);
  });

  it('remove удаляет модель и перечитывает список', async () => {
    useModelsStore.setState({ items: [makeModel({ status: 'ready', installed: true })] });
    listModels.mockResolvedValue(makeResponse([]));
    deleteModel.mockResolvedValue(undefined);

    await useModelsStore.getState().remove('whisper-small');

    expect(deleteModel).toHaveBeenCalledWith('whisper-small');
    expect(listModels).toHaveBeenCalledTimes(1);
    expect(useModelsStore.getState().items).toEqual([]);
  });

  it('remove при model_in_use оставляет статус и показывает ошибку строки', async () => {
    useModelsStore.setState({ items: [makeModel({ status: 'ready', installed: true })] });
    deleteModel.mockRejectedValue(codedError('Модель используется', 'model_in_use'));

    await useModelsStore.getState().remove('whisper-small');

    const item = useModelsStore.getState().items[0];
    expect(item.status).toBe('ready');
    expect(item.error_code).toBe('model_in_use');
    expect(useModelsStore.getState().error).toBe('Модель используется');
  });

  it('importModel передаёт путь и возвращает true после refresh', async () => {
    listModels.mockResolvedValue(makeResponse([makeModel({ status: 'verifying', installed: true })]));
    importModel.mockResolvedValue({ id: 'whisper-small', status: 'verifying' });

    const ok = await useModelsStore.getState().importModel('whisper-small', '/tmp/models/whisper-small');

    expect(ok).toBe(true);
    expect(importModel).toHaveBeenCalledWith('whisper-small', '/tmp/models/whisper-small');
    expect(listModels).toHaveBeenCalledTimes(1);
  });

  it('importModel при ошибке возвращает false и не меняет статус', async () => {
    useModelsStore.setState({ items: [makeModel()] });
    importModel.mockRejectedValue(codedError('Нет таких файлов', 'import_path_invalid'));

    const ok = await useModelsStore.getState().importModel('whisper-small', '/tmp/empty');

    expect(ok).toBe(false);
    const item = useModelsStore.getState().items[0];
    expect(item.status).toBe('absent');
    expect(item.error).toBe('Нет таких файлов');
    expect(item.error_code).toBe('import_path_invalid');
  });
});

describe('modelsStore настройки', () => {
  it('setOffline патчит настройку и обновляет локальный флаг', async () => {
    patchSettings.mockResolvedValue({});

    await useModelsStore.getState().setOffline(true);

    expect(patchSettings).toHaveBeenCalledWith({ 'models.offline': true });
    expect(useModelsStore.getState().offline).toBe(true);
  });

  it('setOffline откатывает флаг при ошибке', async () => {
    patchSettings.mockRejectedValue(new Error('settings failed'));

    await useModelsStore.getState().setOffline(true);

    expect(useModelsStore.getState().offline).toBe(false);
    expect(useModelsStore.getState().error).toBe('settings failed');
  });

  it('setEndpoint патчит models.endpoint (пусто = huggingface.co)', async () => {
    patchSettings.mockResolvedValue({});

    await useModelsStore.getState().setEndpoint('https://hf-mirror.com');
    await useModelsStore.getState().setEndpoint('');

    expect(patchSettings).toHaveBeenNthCalledWith(1, { 'models.endpoint': 'https://hf-mirror.com' });
    expect(patchSettings).toHaveBeenNthCalledWith(2, { 'models.endpoint': '' });
  });

  it('setEndpoint сохраняет текст ошибки', async () => {
    patchSettings.mockRejectedValue(codedError('URL слишком длинный', 'invalid_setting'));

    await useModelsStore.getState().setEndpoint('https://example.com/very-long');

    expect(useModelsStore.getState().error).toBe('URL слишком длинный');
  });
});
