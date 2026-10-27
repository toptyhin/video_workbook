import { create } from 'zustand';

import { api } from '../api/client';
import type {
  ModelStatePayload,
  SummaryBlock,
  SummaryLevelInfo,
  SummaryProgress,
  SummaryProgressPayload,
  SummaryResponse,
  SummaryState,
  SummaryStatePayload,
} from '../api/types';
import { t } from '../lib/i18n';
import { readStorage, writeStorage } from '../lib/storage';
import { clamp } from '../lib/time';

/**
 * M14 (rev2): иерархическое саммари текущего видео и ДИНАМИЧЕСКАЯ шкала детализации.
 *
 * Дерево саммари имеет фактическую глубину `response.max_level` у конкретного видео:
 * уровень 0 — дословная транскрибация (сегменты), уровни 1..max_level — смысловые блоки
 * (levels["1"] самый подробный, levels[max_level] — корневое саммари). Число позиций
 * шкалы `DetailScale` = `max_level + 1`.
 *
 * Интеграция:
 * - `TimingPanel` вызывает `load(videoId)` при открытии видео, читает `level`/`response`
 *   и переключает уровень через `setLevel`;
 * - SSE-слой (`App.tsx`) передаёт события в `applyEvent({type, payload})`;
 * - `SummarySettings` (настройки) может вызывать `loadSettings(true)`/`reload()`.
 */

export const DETAIL_LEVEL_MIN = 0;
export const DETAIL_LEVEL_STORAGE_KEY = 'vl.ui.detailLevel';
/** Максимальная глубина дерева, которую принимаем от бэкенда (защита от мусора). */
export const MAX_SUMMARY_DEPTH = 32;

const GENERATING_STATES: readonly SummaryState[] = ['outlining', 'splitting', 'summarizing'];

function isGeneratingState(state: SummaryState | undefined | null): boolean {
  return state !== undefined && state !== null && GENERATING_STATES.includes(state);
}

/** Глубина дерева саммари: `max_level` из ответа, с fallback по ключам `levels`. */
export function maxSummaryLevel(response: SummaryResponse | null): number {
  if (!response) return 0;
  const raw = response.max_level;
  const numeric = typeof raw === 'number' ? raw : Number(raw);
  if (Number.isFinite(numeric) && numeric > 0) {
    return Math.min(MAX_SUMMARY_DEPTH, Math.floor(numeric));
  }
  const keys = Object.keys(response.levels ?? {})
    .map((key) => Number(key))
    .filter((value) => Number.isFinite(value) && value > 0);
  return keys.length > 0 ? Math.min(MAX_SUMMARY_DEPTH, Math.max(...keys)) : 0;
}

export function clampDetailLevel(value: unknown, maxLevel: number): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  const max = Math.max(DETAIL_LEVEL_MIN, Math.floor(maxLevel));
  if (!Number.isFinite(numeric)) return DETAIL_LEVEL_MIN;
  return clamp(Math.round(numeric), DETAIL_LEVEL_MIN, max);
}

/** Сохранённое значение уровня (может быть больше фактической глубины — клампится при load). */
export function readDetailLevel(): number {
  const numeric = Number(readStorage<unknown>(DETAIL_LEVEL_STORAGE_KEY, DETAIL_LEVEL_MIN));
  if (!Number.isFinite(numeric)) return DETAIL_LEVEL_MIN;
  return Math.max(DETAIL_LEVEL_MIN, Math.min(MAX_SUMMARY_DEPTH, Math.round(numeric)));
}

export function writeDetailLevel(level: number): number {
  const numeric = Number(level);
  const clamped = Number.isFinite(numeric)
    ? Math.max(DETAIL_LEVEL_MIN, Math.min(MAX_SUMMARY_DEPTH, Math.round(numeric)))
    : DETAIL_LEVEL_MIN;
  writeStorage(DETAIL_LEVEL_STORAGE_KEY, clamped);
  return clamped;
}

/** Информация об уровне саммари (совместимо со старым форматом `{ready, blocks}`). */
export function summaryLevelInfo(response: SummaryResponse | null, level: number): SummaryLevelInfo | null {
  if (!response || level <= 0) return null;
  const entry = response.levels?.[String(Math.round(level))];
  if (!entry || !Array.isArray(entry.blocks)) return null;
  return {
    level: typeof entry.level === 'number' ? entry.level : Math.round(level),
    label: typeof entry.label === 'string' ? entry.label : '',
    blocks: entry.blocks,
  };
}

export function isSummaryLevelReady(response: SummaryResponse | null, level: number): boolean {
  return summaryLevelInfo(response, level) !== null;
}

/** Блоки уровня в хронологическом порядке (готовые или частичные). */
export function summaryLevelBlocks(response: SummaryResponse | null, level: number): SummaryBlock[] {
  const info = summaryLevelInfo(response, level);
  if (!info) return [];
  return [...info.blocks].sort(
    (a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms || a.node_id.localeCompare(b.node_id),
  );
}

/**
 * Название уровня для `aria-valuetext`/подсказок: `label` из дерева, для 0 — «Дословно»,
 * иначе — динамический fallback «Уровень N из M».
 */
export function summaryLevelLabel(response: SummaryResponse | null, level: number, maxLevel: number): string {
  if (level <= DETAIL_LEVEL_MIN) return t('summary.levelTranscript');
  if (maxLevel <= 0 && level > 0) return t('summary.levelProvisional');
  const info = summaryLevelInfo(response, level);
  if (info?.label) return info.label;
  return t('summary.levelDynamic', {
    level: Math.round(level),
    max: Math.max(Math.round(maxLevel), Math.round(level)),
  });
}

/** Метки всех уровней для `DetailScale` (0 — «Дословно»). */
export function summaryLevelLabels(response: SummaryResponse | null, maxLevel: number): Record<number, string> {
  const labels: Record<number, string> = { [DETAIL_LEVEL_MIN]: t('summary.levelTranscript') };
  if (maxLevel <= 0) {
    // Дерева ещё нет: единственная провизорная позиция — «Саммари» (запускает генерацию).
    labels[1] = t('summary.levelProvisional');
    return labels;
  }
  for (let level = 1; level <= Math.max(0, Math.floor(maxLevel)); level += 1) {
    labels[level] = summaryLevelLabel(response, level, maxLevel);
  }
  return labels;
}

/**
 * Индекс активного блока: последний блок, начавшийся не позже `positionMs`
 * (бинарный поиск). `-1`, если ещё рано.
 */
export function findActiveSummaryBlock(blocks: readonly SummaryBlock[], positionMs: number): number {
  if (blocks.length === 0 || !Number.isFinite(positionMs)) return -1;
  let low = 0;
  let high = blocks.length - 1;
  let candidate = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (blocks[middle].start_ms <= positionMs) {
      candidate = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return candidate;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Код ошибки из `ApiError` без импорта класса (позволяет мокать `api/client` в тестах). */
function errorCodeOf(error: unknown): string | null {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : null;
  }
  return null;
}

export interface SummaryEventLike {
  type: string;
  payload?: unknown;
}

export interface SummaryStoreState {
  videoId: number | null;
  response: SummaryResponse | null;
  /** Текущий уровень детализации (0…maxLevel), персистится в `vl.ui.detailLevel`. */
  level: number;
  /** Фактическая глубина дерева саммари (0 — только транскрибация). */
  maxLevel: number;
  loading: boolean;
  generating: boolean;
  error: string | null;
  errorCode: string | null;
  /** Модель саммари не установлена — показываем CTA «Скачать модель». */
  modelMissing: boolean;
  /** `summary.enabled` из настроек: false — уровни 1..maxLevel показывают «Саммари отключено». */
  enabled: boolean;
  settingsLoaded: boolean;

  load: (videoId: number, force?: boolean) => Promise<void>;
  reload: () => Promise<void>;
  loadSettings: (force?: boolean) => Promise<void>;
  setLevel: (level: number) => void;
  generate: (level?: number, force?: boolean) => Promise<boolean>;
  applyEvent: (event: SummaryEventLike) => void;
  reset: () => void;
}

let loadToken = 0;

export const useSummaryStore = create<SummaryStoreState>((set, get) => ({
  videoId: null,
  response: null,
  level: readDetailLevel(),
  maxLevel: 0,
  loading: false,
  generating: false,
  error: null,
  errorCode: null,
  modelMissing: false,
  enabled: true,
  settingsLoaded: false,

  load: async (videoId, force = false) => {
    const current = get();
    if (!force && current.videoId === videoId && current.response?.video_id === videoId) return;
    const isNewVideo = current.videoId !== videoId;
    const token = ++loadToken;
    set({
      videoId,
      ...(isNewVideo
        ? {
            response: null,
            maxLevel: 0,
            error: null,
            errorCode: null,
            modelMissing: false,
            generating: false,
          }
        : {}),
      // При обновлении уже открытого видео не показываем скелетон (прогресс/SSE-рефреш).
      loading: isNewVideo || current.response === null,
    });
    if (!current.settingsLoaded) void get().loadSettings();
    try {
      const response = await api.summary(videoId);
      if (token !== loadToken || get().videoId !== videoId) return;
      set(applyResponse(response, get().level));
    } catch (error) {
      if (token !== loadToken || get().videoId !== videoId) return;
      const code = errorCodeOf(error);
      set({
        loading: false,
        generating: false,
        error: errorMessage(error),
        errorCode: code,
        modelMissing: code === 'model_missing',
        ...(code === 'summary_disabled' ? { enabled: false } : {}),
      });
    }
  },

  reload: async () => {
    const { videoId } = get();
    if (videoId === null) return;
    await get().load(videoId, true);
  },

  loadSettings: async (force = false) => {
    if (get().settingsLoaded && !force) return;
    try {
      const values = await api.getSettings();
      const enabled = values['summary.enabled'] !== false && values['summary.enabled'] !== 'false';
      set({ enabled, settingsLoaded: true });
    } catch {
      // Настройки недоступны — не блокируем панель, считаем саммари включённым.
      set({ settingsLoaded: true });
    }
  },

  setLevel: (level) => {
    const state = get();
    // Пока дерева нет (max_level=0), оставляем одну провизорную позицию «Саммари»:
    // без неё при summary.auto=false пользователь не может открыть CTA «Сгенерировать».
    const effectiveMax = state.maxLevel > 0 ? state.maxLevel : 1;
    const next = clampDetailLevel(level, effectiveMax);
    writeDetailLevel(next);
    if (next === state.level) return;
    set({ level: next });
    if (next === DETAIL_LEVEL_MIN) return;
    // Уровень > 0: готовое дерево показываем сразу, недостающий уровень достраиваем,
    // если саммари уже сгенерировано (или ещё не запрашивалось) и модель доступна.
    if (!state.enabled || state.modelMissing) return;
    const { response } = state;
    if (!response) return;
    if (response.state === 'stale' || response.state === 'error') return;
    if (isGeneratingState(response.state)) return;
    if (isSummaryLevelReady(response, next)) return;
    void get().generate(next);
  },

  generate: async (level, force = false) => {
    const state = get();
    const { videoId } = state;
    if (videoId === null) return false;
    if (!state.enabled || state.modelMissing) return false;
    let requested: number | undefined;
    if (level !== undefined) {
      requested = state.maxLevel > 0 ? clampDetailLevel(level, state.maxLevel) : Math.max(1, Math.round(level));
    } else if (state.level > DETAIL_LEVEL_MIN && state.maxLevel > 0) {
      requested = clampDetailLevel(state.level, state.maxLevel);
    }
    set({ generating: true, error: null, errorCode: null });
    try {
      await api.generateSummary(videoId, requested, force);
      if (get().videoId !== videoId) return false;
      await get().reload();
      return true;
    } catch (error) {
      if (get().videoId !== videoId) return false;
      const code = errorCodeOf(error);
      set({
        generating: false,
        error: errorMessage(error),
        errorCode: code,
        modelMissing: get().modelMissing || code === 'model_missing',
        ...(code === 'summary_disabled' ? { enabled: false } : {}),
      });
      return false;
    }
  },

  applyEvent: (event) => {
    const { type, payload } = event;
    if (type === 'summary.progress') {
      const data = payload as SummaryProgressPayload | null;
      if (!data || data.video_id !== get().videoId) return;
      const progress: SummaryProgress = {
        stage: data.stage,
        done: data.done,
        total: data.total,
        percent: data.percent,
      };
      const nextState: SummaryState =
        data.stage === 'outline' ? 'outlining' : data.stage === 'splitting' ? 'splitting' : 'summarizing';
      set((state) => ({
        generating: true,
        response: state.response ? { ...state.response, state: nextState, progress } : state.response,
      }));
      return;
    }
    if (type === 'summary.state') {
      const data = payload as SummaryStatePayload | null;
      if (!data || data.video_id !== get().videoId) return;
      if (isGeneratingState(data.state)) {
        set((state) => ({
          generating: true,
          error: null,
          ...(state.response ? { response: { ...state.response, state: data.state } } : {}),
        }));
        return;
      }
      // ready/error/stale/absent — перечитываем состояние и уровни с сервера.
      void get().reload();
      return;
    }
    if (type === 'model.state') {
      const data = payload as ModelStatePayload | null;
      if (data && data.status === 'ready' && get().modelMissing) {
        void get().reload();
      }
      return;
    }
    if (type === 'settings.changed') {
      void get().loadSettings(true);
    }
  },

  reset: () => {
    loadToken += 1;
    set({
      videoId: null,
      response: null,
      level: readDetailLevel(),
      maxLevel: 0,
      loading: false,
      generating: false,
      error: null,
      errorCode: null,
      modelMissing: false,
    });
  },
}));

/**
 * Нормализует ответ GET/POST: глубина дерева и уровень (клампится по фактической глубине).
 * Если `max_level === 0` (саммари ещё нет), сохранённый уровень не затираем — чтобы
 * оставался доступен CTA «Сгенерировать»; шкала в этом случае показывает только «Дословно».
 */
function applyResponse(response: SummaryResponse, currentLevel: number): Partial<SummaryStoreState> {
  const maxLevel = maxSummaryLevel(response);
  let level = currentLevel;
  if (maxLevel > 0) {
    level = clampDetailLevel(currentLevel, maxLevel);
    if (level !== currentLevel) writeDetailLevel(level);
  }
  const code = response.error_code ?? null;
  return {
    response,
    maxLevel,
    level,
    loading: false,
    generating: isGeneratingState(response.state),
    modelMissing: (response.model !== null && response.model.installed === false) || code === 'model_missing',
    error: response.state === 'error' ? (response.detail ?? null) : null,
    errorCode: code,
  };
}
