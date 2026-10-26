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

export interface SearchQueryEcho {
  raw: string;
  fts: string | null;
  scope: SearchScope;
  prefixes: { tags: string[]; file: string | null };
  took_ms?: number;
}

export interface SearchItemBase {
  video_id: number;
  video_title: string;
  snippet_html: string;
  score: number;
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

export type SettingsValues = Record<string, string | number>;

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
  video_id?: number;
  tag_ids?: number[];
  tag_mode?: 'any' | 'all';
  include_children?: boolean;
  colors?: string[];
  limit?: number;
  offset?: number;
}
