import { useMemo, useRef, useState } from 'react';
import type { DragEvent, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from 'react';
import type { Video } from '../api/types';
import { vl } from '../api/electron';
import { VIDEO_EXTENSIONS } from '../lib/constants';
import { fileBaseName, formatDate } from '../lib/format';
import { t } from '../lib/i18n';
import { formatTimecode } from '../lib/time';
import { useLibraryStore } from '../state/libraryStore';
import type { LibrarySortField } from '../state/libraryStore';
import { useSearchStore } from '../state/searchStore';
import { flattenTagTree, tagPathMap, useTagsStore } from '../state/tagsStore';
import { ConfirmDialog } from './ui/ConfirmDialog';
import { ContextMenu } from './ui/ContextMenu';
import type { ContextMenuItem } from './ui/ContextMenu';
import { EmptyState } from './ui/EmptyState';
import { Spinner } from './ui/Spinner';
import './FileList.css';

interface Column {
  field: LibrarySortField | null;
  labelKey: string;
}

const COLUMNS: Column[] = [
  { field: 'title', labelKey: 'files.columnFile' },
  { field: 'duration_ms', labelKey: 'files.columnDuration' },
  { field: 'status', labelKey: 'files.columnStatus' },
  { field: null, labelKey: 'files.columnTags' },
  { field: 'mtime_ms', labelKey: 'files.columnDate' },
];

const TAG_MIME = 'application/x-vl-tag-id';

function videoLabel(video: Video): string {
  return video.title ?? fileBaseName(video.path);
}

function StatusBadge({ video }: { video: Video }) {
  if (video.status === 'processing') {
    const percent = Math.round(Math.max(0, Math.min(1, video.progress)) * 100);
    return (
      <span className="vl-status vl-status--processing">
        <span className="vl-status__text">{t('status.processing', { percent })}</span>
        <span className="vl-progress" aria-hidden="true">
          <span className="vl-progress__bar" style={{ width: `${percent}%` }} />
        </span>
      </span>
    );
  }
  if (video.status === 'error') {
    return (
      <span className="vl-status vl-status--error" title={video.error ?? ''}>
        {t('status.error', { message: video.error ?? '—' })}
      </span>
    );
  }
  return <span className={`vl-status vl-status--${video.status}`}>{t(`status.${video.status}`)}</span>;
}

interface ContextMenuState {
  x: number;
  y: number;
  videoId: number;
}

/** Таблица библиотеки: сортировка, мультивыбор, drag&drop файлов и тегов, контекстное меню. */
export function FileList() {
  const videos = useLibraryStore((state) => state.videos);
  const total = useLibraryStore((state) => state.total);
  const loading = useLibraryStore((state) => state.loading);
  const error = useLibraryStore((state) => state.error);
  const sort = useLibraryStore((state) => state.sort);
  const dir = useLibraryStore((state) => state.dir);
  const selectedIds = useLibraryStore((state) => state.selectedIds);
  const setSort = useLibraryStore((state) => state.setSort);
  const refresh = useLibraryStore((state) => state.refresh);
  const toggleSelect = useLibraryStore((state) => state.toggleSelect);
  const setSelection = useLibraryStore((state) => state.setSelection);
  const selectVideo = useLibraryStore((state) => state.selectVideo);
  const scanPaths = useLibraryStore((state) => state.scanPaths);
  const removeSelected = useLibraryStore((state) => state.removeSelected);
  const reprocessSelected = useLibraryStore((state) => state.reprocessSelected);

  const trees = useTagsStore((state) => state.tree);
  const assignToVideo = useTagsStore((state) => state.assignToVideo);
  const removeFromVideo = useTagsStore((state) => state.removeFromVideo);

  const searchQuery = useSearchStore((state) => state.query);
  const searchTotal = useSearchStore((state) => state.total);

  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Video | null>(null);
  const [dropActive, setDropActive] = useState(false);
  const [dropRowId, setDropRowId] = useState<number | null>(null);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const rowRefs = useRef<Array<HTMLTableRowElement | null>>([]);

  const tagList = useMemo(() => {
    const paths = tagPathMap(trees);
    return flattenTagTree(trees).map((node) => ({ id: node.id, label: paths.get(node.id) ?? node.name }));
  }, [trees]);

  const hasSearch = searchQuery.trim().length > 0;

  const assignTag = (tagId: number, targets: number[]): void => {
    for (const videoId of targets) void assignToVideo(videoId, tagId);
  };

  const unassignTag = (tagId: number, targets: number[]): void => {
    for (const videoId of targets) void removeFromVideo(videoId, tagId);
  };

  const contextTargets = (videoId: number): number[] =>
    selectedIds.includes(videoId) ? selectedIds : [videoId];

  const buildMenuItems = (video: Video): ContextMenuItem[] => {
    const targets = contextTargets(video.id);
    const assignChildren: ContextMenuItem[] =
      tagList.length > 0
        ? tagList.map((tag) => ({
            id: `assign-${tag.id}`,
            label: tag.label,
            onSelect: () => assignTag(tag.id, targets),
          }))
        : [];
    const unassignChildren: ContextMenuItem[] =
      tagList.length > 0
        ? tagList.map((tag) => ({
            id: `unassign-${tag.id}`,
            label: tag.label,
            onSelect: () => unassignTag(tag.id, targets),
          }))
        : [];
    return [
      {
        id: 'assign',
        label: t('annotations.tags'),
        disabled: assignChildren.length === 0,
        children: assignChildren,
      },
      {
        id: 'unassign',
        label: t('tags.delete'),
        disabled: unassignChildren.length === 0,
        children: unassignChildren,
      },
      {
        id: 'reprocess',
        label: t('timings.reprocess'),
        separatorBefore: true,
        onSelect: () => {
          setSelection(targets);
          void reprocessSelected();
        },
      },
      {
        id: 'reveal',
        label: t('player.showInFolder'),
        onSelect: () => void vl().revealInExplorer(video.path),
      },
      {
        id: 'delete',
        label: t('common.delete'),
        danger: true,
        separatorBefore: true,
        onSelect: () => setConfirmDelete(video),
      },
    ];
  };

  const handleRowClick = (event: ReactMouseEvent<HTMLTableRowElement>, video: Video): void => {
    toggleSelect(video.id, {
      additive: event.ctrlKey || event.metaKey,
      range: event.shiftKey,
    });
  };

  const handleRowKeyDown = (event: ReactKeyboardEvent<HTMLTableRowElement>, video: Video, index: number): void => {
    if (event.key === 'Enter') {
      event.preventDefault();
      selectVideo(video.id);
    } else if (event.key === ' ') {
      event.preventDefault();
      toggleSelect(video.id, { additive: true });
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      rowRefs.current[index + 1]?.focus();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      rowRefs.current[index - 1]?.focus();
    } else if (event.key === 'Escape') {
      setSelection([]);
    }
  };

  const isTagDrag = (event: DragEvent<HTMLElement>): boolean =>
    Array.from(event.dataTransfer.types).includes(TAG_MIME);

  const handleRowDragOver = (event: DragEvent<HTMLTableRowElement>, video: Video): void => {
    if (!isTagDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'copy';
    if (dropRowId !== video.id) setDropRowId(video.id);
  };

  const handleRowDrop = (event: DragEvent<HTMLTableRowElement>, video: Video): void => {
    if (!isTagDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    setDropRowId(null);
    const tagId = Number(event.dataTransfer.getData(TAG_MIME));
    if (!Number.isFinite(tagId) || tagId <= 0) return;
    assignTag(tagId, contextTargets(video.id));
  };

  const handleDropFiles = (event: DragEvent<HTMLDivElement>): void => {
    const types = Array.from(event.dataTransfer.types);
    if (!types.includes('Files')) return;
    event.preventDefault();
    setDropActive(false);
    const paths = Array.from(event.dataTransfer.files)
      .map((file) => vl().getPathForFile(file))
      .filter(
        (path) =>
          path.length > 0 &&
          VIDEO_EXTENSIONS.some((extension) => path.toLowerCase().endsWith(`.${extension}`)),
      );
    if (paths.length > 0) void scanPaths(paths);
  };

  if (loading && videos.length === 0) {
    return (
      <div className="vl-filelist">
        <Spinner />
      </div>
    );
  }

  if (error && videos.length === 0) {
    return (
      <div className="vl-filelist">
        <EmptyState
          title={t('toast.error', { message: error })}
          actionLabel={t('common.retry')}
          onAction={() => void refresh()}
        />
      </div>
    );
  }

  if (videos.length === 0) {
    return (
      <div className="vl-filelist">
        {hasSearch ? (
          <EmptyState title={t('files.emptySearch', { query: searchQuery })} />
        ) : (
          <EmptyState title={t('files.empty')} />
        )}
      </div>
    );
  }

  return (
    <div
      className={`vl-filelist${dropActive ? ' vl-filelist--drop' : ''}`}
      onDragOver={(event) => {
        if (!Array.from(event.dataTransfer.types).includes('Files')) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
        setDropActive(true);
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setDropActive(false);
      }}
      onDrop={handleDropFiles}
    >
      {hasSearch && (
        <div className="vl-filelist__search-line" aria-live="polite">
          {t('files.found', { count: searchTotal, query: searchQuery })}
        </div>
      )}
      <div className="vl-filelist__scroll">
        <table className="vl-table" aria-label={t('sidebar.tabFiles')}>
          <thead>
            <tr>
              {COLUMNS.map((column) => {
                const active = column.field !== null && sort === column.field;
                const ariaSort = active
                  ? dir === 'asc'
                    ? 'ascending'
                    : 'descending'
                  : 'none';
                return (
                  <th
                    key={column.labelKey}
                    scope="col"
                    aria-sort={column.field === null ? undefined : ariaSort}
                  >
                    {column.field === null ? (
                      <span className="vl-table__label">{t(column.labelKey)}</span>
                    ) : (
                      <button
                        type="button"
                        className="vl-table__sort"
                        onClick={() => setSort(column.field as LibrarySortField)}
                        title={t(column.labelKey)}
                      >
                        {t(column.labelKey)}
                        {active && <span aria-hidden="true">{dir === 'asc' ? ' ▲' : ' ▼'}</span>}
                      </button>
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {videos.map((video, index) => {
              const selected = selectedIds.includes(video.id);
              return (
                <tr
                  key={video.id}
                  ref={(element) => {
                    rowRefs.current[index] = element;
                  }}
                  tabIndex={focusedIndex === index ? 0 : -1}
                  className={[
                    selected ? 'vl-table__row--selected' : '',
                    dropRowId === video.id ? 'vl-table__row--drop-target' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  aria-selected={selected}
                  onClick={(event) => handleRowClick(event, video)}
                  onDoubleClick={() => selectVideo(video.id)}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    if (!selectedIds.includes(video.id)) setSelection([video.id]);
                    setContextMenu({ x: event.clientX, y: event.clientY, videoId: video.id });
                  }}
                  onFocus={() => setFocusedIndex(index)}
                  onKeyDown={(event) => handleRowKeyDown(event, video, index)}
                  onDragOver={(event) => handleRowDragOver(event, video)}
                  onDragLeave={() => setDropRowId((current) => (current === video.id ? null : current))}
                  onDrop={(event) => handleRowDrop(event, video)}
                >
                  <td className="vl-table__cell--file">
                    <span className="vl-table__title">{videoLabel(video)}</span>
                    <span className="vl-table__path" title={video.path}>
                      {video.path}
                    </span>
                  </td>
                  <td className="vl-table__cell--duration">
                    {video.duration_ms === null ? '—' : formatTimecode(video.duration_ms)}
                  </td>
                  <td className="vl-table__cell--status">
                    <StatusBadge video={video} />
                  </td>
                  <td className="vl-table__cell--tags">
                    {video.tags_count > 0 ? (
                      <span className="vl-tag-count" title={t('files.columnTags')}>
                        <span aria-hidden="true">🏷</span> {video.tags_count}
                      </span>
                    ) : (
                      <span className="vl-muted">—</span>
                    )}
                  </td>
                  <td className="vl-table__cell--date">{formatDate(video.mtime_ms ?? video.added_at)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="vl-filelist__footer">
        {videos.length} / {total}
      </div>
      {dropActive && (
        <div className="vl-filelist__drop-overlay" aria-hidden="true">
          <span className="vl-filelist__drop-icon">＋</span>
        </div>
      )}
      {contextMenu && (() => {
        const video = videos.find((item) => item.id === contextMenu.videoId);
        if (!video) return null;
        return (
          <ContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            items={buildMenuItems(video)}
            label={t('files.columnFile')}
            onClose={() => setContextMenu(null)}
          />
        );
      })()}
      {confirmDelete && (
        <ConfirmDialog
          title={t('common.delete')}
          message={t('toast.videoRemoved')}
          confirmLabel={t('common.delete')}
          danger
          onConfirm={() => {
            const id = confirmDelete.id;
            setConfirmDelete(null);
            setSelection([id]);
            void removeSelected();
          }}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </div>
  );
}
