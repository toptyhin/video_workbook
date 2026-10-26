import { backend } from './electron';
import type {
  Annotation,
  AnnotationInput,
  AnnotationListResponse,
  AnnotationPatch,
  BackendInfo,
  Folder,
  ExternalPlayersResponse,
  ExternalStatus,
  FolderListResponse,
  FsListResponse,
  QueueState,
  ScanResponse,
  SearchParams,
  SearchResponse,
  PlaybackInfo,
  SegmentListResponse,
  SettingsValues,
  TagNode,
  TagTreeResponse,
  VideoListResponse,
  VideoQuery,
} from './types';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(status: number, detail: string, code: string | null) {
    super(detail);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

let cachedBackend: BackendInfo | null = null;

export async function initBackend(): Promise<BackendInfo> {
  cachedBackend = await backend();
  return cachedBackend;
}

export function getBaseUrl(): string {
  return cachedBackend?.baseUrl ?? '';
}

export function getToken(): string {
  return cachedBackend?.token ?? '';
}

function buildQuery(params: Record<string, unknown> | undefined): string {
  if (!params) return '';
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      search.set(key, value.join(','));
    } else if (typeof value === 'boolean') {
      search.set(key, value ? '1' : '0');
    } else {
      search.set(key, String(value));
    }
  }
  const encoded = search.toString();
  return encoded ? `?${encoded}` : '';
}

async function request<T>(
  path: string,
  options: { method?: string; body?: unknown; params?: Record<string, unknown>; signal?: AbortSignal } = {},
): Promise<T> {
  if (!cachedBackend) await initBackend();
  const url = `${cachedBackend?.baseUrl ?? ''}${path}${buildQuery(options.params)}`;
  const headers: Record<string, string> = { 'X-VL-Token': cachedBackend?.token ?? '' };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(url, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal,
  });
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { detail: text, code: null };
    }
  }
  if (!response.ok) {
    const err = (data ?? {}) as { detail?: string; code?: string };
    throw new ApiError(response.status, err.detail ?? response.statusText, err.code ?? null);
  }
  return data as T;
}

export function mediaUrl(videoId: number, kind: 'stream' | 'thumb' | 'preview', extra?: Record<string, unknown>): string {
  const params = new URLSearchParams({ token: cachedBackend?.token ?? '' });
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      if (value !== undefined && value !== null) params.set(key, String(value));
    }
  }
  return `${cachedBackend?.baseUrl ?? ''}/api/videos/${videoId}/${kind}?${params.toString()}`;
}

export function eventsUrl(): string {
  const params = new URLSearchParams({ token: cachedBackend?.token ?? '' });
  return `${cachedBackend?.baseUrl ?? ''}/api/events?${params.toString()}`;
}

export const api = {
  health: () => request<{ status: string; version: string; db: string }>('/api/health'),
  getSettings: () => request<SettingsValues>('/api/settings'),
  patchSettings: (values: SettingsValues) =>
    request<SettingsValues>('/api/settings', { method: 'PATCH', body: values }),

  listVideos: (query: VideoQuery = {}) =>
    request<VideoListResponse>('/api/videos', {
      params: {
        folder: query.folder,
        tag_ids: query.tag_ids,
        tag_mode: query.tag_mode,
        include_children: query.include_children,
        status: query.status,
        q: query.q,
        sort: query.sort,
        dir: query.dir,
        limit: query.limit,
        offset: query.offset,
      },
    }),
  scan: (path: string) => request<ScanResponse>('/api/videos/scan', { method: 'POST', body: { path } }),
  enqueue: (ids: number[]) =>
    request<{ queued: number[]; skipped: { id: number; reason: string }[] }>('/api/videos/enqueue', {
      method: 'POST',
      body: { ids },
    }),
  deleteVideo: (id: number) => request<void>(`/api/videos/${id}`, { method: 'DELETE' }),
  reprocess: (id: number) => request<{ id: number; status: string }>(`/api/videos/${id}/reprocess`, { method: 'POST' }),
  cancelVideo: (id: number) => request<{ id: number; status: string }>(`/api/videos/${id}/cancel`, { method: 'POST' }),
  queue: () => request<QueueState>('/api/queue'),
  segments: (videoId: number) => request<SegmentListResponse>(`/api/videos/${videoId}/segments`),
  playback: (videoId: number) => request<PlaybackInfo>(`/api/videos/${videoId}/playback`),
  preparePreview: (videoId: number) =>
    request<PlaybackInfo>(`/api/videos/${videoId}/prepare-preview`, { method: 'POST' }),
  externalPlayers: () => request<ExternalPlayersResponse>('/api/external/players'),
  externalStatus: () => request<ExternalStatus>('/api/external/status'),
  externalLaunch: (payload: {
    video_id: number;
    start_ms?: number;
    player?: string;
    pass_marks?: boolean;
    player_path?: string;
  }) => request<ExternalStatus>('/api/external/launch', { method: 'POST', body: payload }),
  externalCommand: (action: string, value?: unknown) =>
    request<ExternalStatus>('/api/external/command', { method: 'POST', body: { action, value } }),
  externalStop: () => request<ExternalStatus>('/api/external/stop', { method: 'POST' }),
  clearPreviewCache: () =>
    request<{ removed_bytes: number; removed_files: number }>('/api/maintenance/clear-preview-cache', {
      method: 'POST',
    }),

  search: (params: SearchParams, signal?: AbortSignal) =>
    request<SearchResponse>('/api/search', {
      params: {
        q: params.q,
        scope: params.scope,
        video_id: params.video_id,
        tag_ids: params.tag_ids,
        tag_mode: params.tag_mode,
        include_children: params.include_children,
        colors: params.colors,
        limit: params.limit,
        offset: params.offset,
      },
      signal,
    }),

  folders: () => request<FolderListResponse>('/api/folders'),
  addFolder: (path: string) => request<Folder>('/api/folders', { method: 'POST', body: { path } }),
  removeFolder: (id: number) => request<void>(`/api/folders/${id}`, { method: 'DELETE' }),
  fsList: (path: string) => request<FsListResponse>('/api/fs/list', { params: { path } }),

  tags: () => request<TagTreeResponse>('/api/tags/tree'),
  createTag: (payload: { parent_id?: number | null; name: string; color?: string | null }) =>
    request<TagNode>('/api/tags', { method: 'POST', body: payload }),
  patchTag: (id: number, payload: { name?: string; color?: string | null; parent_id?: number | null }) =>
    request<TagNode>(`/api/tags/${id}`, { method: 'PATCH', body: payload }),
  deleteTag: (id: number) => request<void>(`/api/tags/${id}`, { method: 'DELETE' }),
  exportTags: () => request<unknown>('/api/tags/export'),
  importTags: (data: unknown, mode: 'merge' | 'replace' = 'merge') =>
    request<{ imported: number; skipped: number; errors: string[] }>('/api/tags/import', {
      method: 'POST',
      body: { data, mode },
    }),
  addVideoTag: (videoId: number, tagId: number) =>
    request<void>(`/api/videos/${videoId}/tags`, { method: 'POST', body: { tag_id: tagId } }),
  removeVideoTag: (videoId: number, tagId: number) =>
    request<void>(`/api/videos/${videoId}/tags/${tagId}`, { method: 'DELETE' }),
  addSegmentTag: (segmentId: number, tagId: number) =>
    request<void>(`/api/segments/${segmentId}/tags`, { method: 'POST', body: { tag_id: tagId } }),
  removeSegmentTag: (segmentId: number, tagId: number) =>
    request<void>(`/api/segments/${segmentId}/tags/${tagId}`, { method: 'DELETE' }),

  annotations: (params: { video_id?: number; tag_id?: number; color?: string; q?: string; limit?: number; offset?: number } = {}) =>
    request<AnnotationListResponse>('/api/annotations', {
      params: {
        video_id: params.video_id,
        tag_id: params.tag_id,
        color: params.color,
        q: params.q,
        limit: params.limit,
        offset: params.offset,
      },
    }),
  createAnnotation: (input: AnnotationInput) =>
    request<Annotation>('/api/annotations', { method: 'POST', body: input }),
  bulkCreateAnnotations: (videoId: number, items: Omit<AnnotationInput, 'video_id'>[]) =>
    request<{ items: Annotation[]; total: number }>('/api/annotations/bulk', {
      method: 'POST',
      body: { video_id: videoId, items },
    }),
  getAnnotation: (id: number) => request<Annotation>(`/api/annotations/${id}`),
  patchAnnotation: (id: number, patch: AnnotationPatch) =>
    request<Annotation>(`/api/annotations/${id}`, { method: 'PATCH', body: patch }),
  deleteAnnotation: (id: number) => request<void>(`/api/annotations/${id}`, { method: 'DELETE' }),
  exportAnnotations: (videoId?: number) =>
    request<unknown>('/api/annotations/export', { params: { video_id: videoId } }),
  importAnnotations: (videoId: number, data: unknown, mode: 'merge' | 'replace' = 'merge') =>
    request<{ imported: number; skipped: number; errors: string[] }>('/api/annotations/import', {
      method: 'POST',
      body: { video_id: videoId, data, mode },
    }),
};
