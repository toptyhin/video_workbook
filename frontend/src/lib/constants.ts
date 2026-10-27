export const STORAGE_KEYS = {
  detailLevel: 'vl.ui.detailLevel',
  theme: 'vl.theme',
  sidebarWidth: 'vl.ui.sidebarWidth',
  sidebarTab: 'vl.ui.sidebarTab',
  timingsWidth: 'vl.ui.timingsWidth',
  timingsCollapsed: 'vl.ui.timingsCollapsed',
  previewHeight: 'vl.ui.previewHeight',
  sort: 'vl.ui.sort',
  volume: 'vl.player.volume',
  positions: 'vl.playback.positions',
  tagsExpanded: 'vl.tags.expanded',
  searchMode: 'vl.search.mode',
  viewMode: 'vl.ui.viewMode',
  gridColumns: 'vl.ui.gridColumns',
} as const;

export const ANNOTATION_COLORS = [
  '#3b82f6',
  '#22c55e',
  '#eab308',
  '#f97316',
  '#ef4444',
  '#a855f7',
  '#14b8a6',
  '#64748b',
] as const;

export const MIN_ANNOTATION_MS = 300;
export const MAX_LABEL_LENGTH = 200;
export const MAX_NOTE_LENGTH = 2000;

export const VIDEO_EXTENSIONS = ['mp4', 'mkv', 'mov', 'avi', 'webm', 'm4v'] as const;

export const SEARCH_DEBOUNCE_MS = 300;
