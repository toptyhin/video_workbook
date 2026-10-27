export type VideoStatus =
  | 'pending'
  | 'queued'
  | 'processing'
  | 'done'
  | 'error'
  | 'duplicate'
  | 'missing';

export interface Video {
  id: number;
  path: string;
  title: string | null;
  duration_ms: number | null;
  size_bytes: number | null;
  sha256: string | null;
  status: VideoStatus;
  progress: number;
  error: string | null;
  error_code?: string | null;
  added_at: string;
  processed_at: string | null;
  lang: string | null;
  model: string | null;
  headline: string | null;
  mtime_ms: number | null;
  tags_count: number;
}

export interface VideoListResponse {
  items: Video[];
  total: number;
}

export interface Folder {
  id: number;
  path: string;
  added_at: string;
  total: number;
  done: number;
}

export interface FolderListResponse {
  items: Folder[];
  total: number;
}

/** Действие групповой операции с файлами (plans/15 §3.1). */
export type TransferAction = 'move' | 'copy';

/** Результат перемещения/копирования одного файла (plans/15 §3.1). */
export interface TransferItemResult {
  id: number;
  ok: boolean;
  code: string | null;
  detail: string | null;
  path: string | null;
  /** id новой строки `videos` для копии; для перемещения `null`. */
  new_id: number | null;
}

/** Ответ `POST /api/videos/transfer` (plans/15 §3.1). */
export interface TransferResponse {
  action: TransferAction;
  destination: string;
  items: TransferItemResult[];
  moved: number;
  copied: number;
  failed: number;
  /** Актуальная история адресатов (свежие первыми, максимум 5). */
  recent_destinations: string[];
}

export interface FsEntry {
  name: string;
  path: string;
  mtime_ms: number;
  watched: boolean;
}

export interface FsListResponse {
  path: string;
  parent: string | null;
  entries: FsEntry[];
}

export type PlaybackMode = 'direct' | 'remux' | 'transcode' | 'unsupported';
export type PlaybackState = 'direct' | 'idle' | 'queued' | 'preparing' | 'ready' | 'error';

export interface PlaybackInfo {
  video_id: number;
  mode: PlaybackMode;
  state: PlaybackState;
  progress: number;
  error: string | null;
  ready?: boolean;
  video_codec: string | null;
  audio_codec: string | null;
  pix_fmt: string | null;
  width: number | null;
  height: number | null;
  audio_channels: number | null;
  detail: string | null;
}

export interface ExternalPlayer {
  id: 'mpv' | 'vlc' | 'system';
  label: string;
  path: string | null;
  available: boolean;
  sync: boolean;
}

export interface ExternalPlayersResponse {
  items: ExternalPlayer[];
  configured: string;
  policy: 'ask' | 'always' | 'never';
  pass_marks: boolean;
}

export interface ExternalSession {
  session_id: string;
  player: 'mpv' | 'vlc' | 'system';
  player_label: string;
  sync: boolean;
  video_id: number;
  title: string | null;
  start_ms: number;
  position_ms: number;
  duration_ms: number;
  paused: boolean;
  volume: number;
  active: boolean;
  ended: boolean;
  chapters: boolean;
  subtitles: boolean;
}

export interface ExternalStatus {
  active: boolean;
  session: ExternalSession | null;
}

export interface Segment {
  id: number;
  video_id: number;
  start_ms: number;
  end_ms: number;
  text: string;
  tag_ids: number[];
}

export interface Annotation {
  id: number;
  video_id: number;
  start_ms: number;
  end_ms: number;
  label: string;
  color: string;
  note: string | null;
  tag_ids: number[];
  created_at: string;
  updated_at: string | null;
}

export interface AnnotationInput {
  video_id: number;
  start_ms: number;
  end_ms: number;
  label: string;
  color?: string;
  note?: string | null;
  tag_ids?: number[];
}

export type AnnotationPatch = Partial<Omit<AnnotationInput, 'video_id'>>;

export interface SegmentListResponse {
  segments: Segment[];
  annotations: Annotation[];
}

export interface AnnotationListResponse {
  items: Annotation[];
  total: number;
}

export interface TagCounts {
  files: number;
  segments: number;
  annotations: number;
  children: number;
}

export interface TagNode {
  id: number;
  parent_id: number | null;
  name: string;
  color: string | null;
  depth: number;
  counts: TagCounts;
  children: TagNode[];
}

export interface TagTreeResponse {
  items: TagNode[];
  total: number;
}

export type SearchScope = 'all' | 'files' | 'segments' | 'annotations';

/** Режим единого поиска (plans/12 §4.1): API default — `fts`, UI default — `hybrid`. */
export type SearchMode = 'fts' | 'semantic' | 'hybrid';

/** Статус семантического индекса (GET /api/search/semantic/status). */
export interface SemanticStatus {
  available: boolean;
  model: string;
  dim: number;
  indexed_segments: number;
  total_segments: number;
  indexing: boolean;
  autoindex: boolean;
  detail: string | null;
}

/** POST /api/search/semantic/reindex → 202 {state,mode,available,...}. */
export interface SemanticReindexResponse extends SemanticStatus {
  state: string;
}

/** SSE `embedding.progress` (plans/12 §3.3). */
export interface EmbeddingProgressPayload {
  indexed: number;
  total: number;
  percent: number;
}

/** SSE `embedding.state` (plans/12 §3.3). */
export interface EmbeddingStatePayload {
  state: 'indexing' | 'idle';
  detail?: string | null;
}

export interface SearchQueryEcho {
  raw: string;
  fts: string | null;
  scope: SearchScope;
  prefixes: { tags: string[]; file: string | null };
  mode?: SearchMode;
  mode_used?: SearchMode;
  semantic?: SemanticStatus;
  took_ms?: number;
}

export interface SearchItemBase {
  video_id: number;
  video_title: string;
  snippet_html: string;
  score: number;
  /** Элемент найден (в т.ч.) векторным поиском — маркер «семантика» в UI. */
  semantic?: boolean;
}


export interface SearchItemFile extends SearchItemBase {
  kind: 'file';
  path: string;
  duration_ms: number | null;
}

export interface SearchItemSegment extends SearchItemBase {
  kind: 'segment';
  segment_id: number;
  start_ms: number;
  end_ms: number;
  text: string;
}

export interface SearchItemAnnotation extends SearchItemBase {
  kind: 'annotation';
  annotation_id: number;
  start_ms: number;
  end_ms: number;
  label: string;
  note: string | null;
  color: string;
  tag_ids: number[];
}

export type SearchItem = SearchItemFile | SearchItemSegment | SearchItemAnnotation;

export interface SearchResponse {
  query: SearchQueryEcho;
  total: number;
  items: SearchItem[];
}

export interface QueueState {
  current: { video_id: number; title: string; progress: number } | null;
  pending: { video_id: number; position: number }[];
  total: number;
}

export interface ScanResponse {
  scan_id: string;
  state: string;
  root: string;
}

/** Значения настроек: `GET/PATCH /api/settings` (M9). Списки (например,
 * `files.recent_destinations`, plans/15 §3.2) передаются массивами строк. */
export type SettingsValues = Record<string, string | number | boolean | string[]>;

export interface AppInfo {
  version: string;
  dataDir: string;
  logsDir: string;
}

export type BackendStatus = 'starting' | 'ready' | 'crashed' | 'stopped';

export interface BackendInfo {
  baseUrl: string;
  token: string;
}

// --- M11: запись экрана/окна ---

/** Источник захвата из Electron `desktopCapturer.getSources` (см. plans/11 §5). */
export interface CaptureSource {
  /** `screen:0:0` | `window:12345` — используется как `chromeMediaSourceId`. */
  id: string;
  name: string;
  type: 'screen' | 'window';
  display_id?: string;
  /** PNG data URL (320×180). */
  thumbnail_data_url: string;
}

export interface RecordingSystemAudioCapability {
  available: boolean;
  detail: string | null;
}

/** GET /api/recordings/capabilities */
export interface RecordingCapabilities {
  system_audio: RecordingSystemAudioCapability;
  max_chunk_bytes: number;
}

export interface RecordingSystemAudioState {
  active: boolean;
  detail: string | null;
}

/** POST /api/recordings */
export interface StartRecordingPayload {
  source_kind: 'screen' | 'window';
  source_title: string;
  /** Пусто/undefined → backend формирует title по умолчанию. */
  title?: string;
  mime_type: string;
  system_audio: boolean;
}

export interface StartRecordingResponse {
  recording_id: string;
  system_audio: RecordingSystemAudioState;
}

/** POST /api/recordings/{id}/finish */
export interface FinishRecordingPayload {
  duration_ms?: number;
  width?: number;
  height?: number;
}

export interface FinishRecordingResponse {
  video_id: number;
  title: string;
  duration_ms: number;
  size_bytes: number;
  path: string | null;
  playback_mode: PlaybackMode;
}

/** POST /api/recordings/{id}/chunks */
export interface RecordingChunkResponse {
  bytes: number;
}

export interface VLApi {
  getBackend(): Promise<BackendInfo>;
  openFiles(): Promise<string[]>;
  openFolder(): Promise<string | null>;
  getPathForFile(file: File): string;
  revealInExplorer(path: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  getAppInfo(): Promise<AppInfo>;
  onBackendStatus(cb: (status: BackendStatus) => void): () => void;
  log(level: 'info' | 'warn' | 'error', msg: string): void;
  /** M11: экраны/окна + миниатюры; в браузере — пустой список. */
  getCaptureSources(): Promise<CaptureSource[]>;
}

export interface VideoQuery {
  folder?: string;
  tag_ids?: number[];
  tag_mode?: 'any' | 'all';
  include_children?: boolean;
  status?: VideoStatus[];
  q?: string;
  sort?: string;
  dir?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

export interface SearchParams {
  q: string;
  scope?: SearchScope;
  mode?: SearchMode;
  video_id?: number;
  tag_ids?: number[];
  tag_mode?: 'any' | 'all';
  include_children?: boolean;
  colors?: string[];
  limit?: number;
  offset?: number;
}

/** ---------- M13: менеджер моделей ---------- */
export type ModelKind = 'transcription' | 'embedding' | 'summary';
export type ModelStatus =
  | 'absent'
  | 'queued'
  | 'downloading'
  | 'verifying'
  | 'ready'
  | 'error'
  | 'bundled';

export interface ModelLicense {
  name: string;
  url: string;
}

export interface ModelProgress {
  bytes_received: number;
  total_bytes: number;
  percent: number;
}

export interface ModelInfo {
  id: string;
  kind: ModelKind;
  label: string;
  installed: boolean;
  bundled: boolean;
  status: ModelStatus;
  revision: string | null;
  update_available: boolean;
  size_bytes: number;
  progress: ModelProgress | null;
  license: ModelLicense;
  recommended: boolean;
  default: boolean;
  meta: Record<string, unknown>;
  path: string | null;
  error: string | null;
  error_code: string | null;
}

export interface ModelListResponse {
  items: ModelInfo[];
  total_installed_bytes: number;
  total_available_bytes: number;
  models_dir: string;
  offline: boolean;
}

export interface ModelActionResponse {
  id: string;
  status: string;
}

/** ---------- M14 (rev2): иерархическое саммари транскрибации ---------- */
export type SummaryState =
  | 'absent'
  | 'outlining'
  | 'splitting'
  | 'summarizing'
  | 'ready'
  | 'error'
  | 'stale';

/** Блок смыслового дерева: корень → темы → подтемы → … → строки. */
export interface SummaryBlock {
  /** Стабильный id узла дерева (`0`, `0.1`, `0.1.2`, …). */
  node_id: string;
  start_ms: number;
  end_ms: number;
  /** Заголовок смыслового блока; у корня/листьев может быть null. */
  title: string | null;
  /** Саммари блока (для листьев — текст/первое предложение). */
  text: string;
  keywords?: string[];
}

export interface SummaryLevelInfo {
  level: number;
  /** Человекочитаемое название уровня (зависит от фактической глубины дерева). */
  label: string;
  blocks: SummaryBlock[];
}

export interface SummaryProgress {
  stage: 'outline' | 'splitting' | 'summarizing';
  done: number;
  total: number;
  percent: number;
}

export interface SummaryModelInfo {
  id: string;
  label: string | null;
  installed: boolean;
}

export interface SummaryResponse {
  video_id: number;
  state: SummaryState;
  /** Сколько уровней саммари доступно (0 — только дословная транскрибация). */
  max_level: number;
  /** levels["1"] — самый подробный, levels[max_level] — корневое саммари. */
  levels: Record<string, SummaryLevelInfo>;
  /** Верхнеуровневое саммари всего видео (о чём оно). */
  root_summary: string | null;
  model: SummaryModelInfo | null;
  progress: SummaryProgress | null;
  detail: string | null;
  error_code: string | null;
}

export interface SummaryGenerateResponse {
  video_id: number;
  state: SummaryState;
  level: number;
}

/** SSE `model.progress` (plans/13 §4.4). */
export interface ModelProgressPayload {
  model_id: string;
  status: ModelStatus;
  bytes_received: number;
  total_bytes: number;
  percent: number;
}

/** SSE `model.state` (plans/13 §4.4). */
export interface ModelStatePayload {
  model_id: string;
  status: ModelStatus;
  error?: string | null;
  error_code?: string | null;
}

/** SSE `summary.progress` (plans/14 §4.3). */
export interface SummaryProgressPayload {
  video_id: number;
  stage: 'outline' | 'splitting' | 'summarizing';
  done: number;
  total: number;
  percent: number;
}

/** SSE `summary.state` (plans/14 §4.3). */
export interface SummaryStatePayload {
  video_id: number;
  state: SummaryState;
  detail?: string | null;
}
