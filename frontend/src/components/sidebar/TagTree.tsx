import { useEffect, useRef, useState } from 'react';
import type {
  ChangeEvent,
  DragEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  ReactNode,
} from 'react';
import type { TagNode } from '../../api/types';
import { t } from '../../lib/i18n';
import { useTagsStore } from '../../state/tagsStore';
import { useUIStore } from '../../state/uiStore';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { ContextMenu } from '../ui/ContextMenu';
import type { ContextMenuItem } from '../ui/ContextMenu';
import { EmptyState } from '../ui/EmptyState';
import { Spinner } from '../ui/Spinner';
import './TagTree.css';

const TAG_MIME = 'application/x-vl-tag-id';

type EditorState = { mode: 'create'; parentId: number | null } | { mode: 'rename'; node: TagNode };

interface TagContextMenuState {
  x: number;
  y: number;
  node: TagNode | null;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface TagTreeProps {
  /** Увеличивается при SSE `tags.changed`, чтобы перечитать дерево. */
  refreshToken?: number;
}

/** Таб «Теги»: иерархия, счётчики, фильтр, мультивыбор, CRUD, экспорт/импорт. */
export function TagTree({ refreshToken = 0 }: TagTreeProps = {}) {
  const tree = useTagsStore((state) => state.tree);
  const loading = useTagsStore((state) => state.loading);
  const error = useTagsStore((state) => state.error);
  const expandedIds = useTagsStore((state) => state.expandedIds);
  const activeTagIds = useTagsStore((state) => state.activeTagIds);
  const mode = useTagsStore((state) => state.mode);
  const load = useTagsStore((state) => state.load);
  const create = useTagsStore((state) => state.create);
  const rename = useTagsStore((state) => state.rename);
  const remove = useTagsStore((state) => state.remove);
  const toggleExpand = useTagsStore((state) => state.toggleExpand);
  const toggleActive = useTagsStore((state) => state.toggleActive);
  const clearActive = useTagsStore((state) => state.clearActive);
  const setMode = useTagsStore((state) => state.setMode);
  const exportTags = useTagsStore((state) => state.exportTags);
  const importTags = useTagsStore((state) => state.importTags);
  const pushToast = useUIStore((state) => state.pushToast);

  const containerRef = useRef<HTMLUListElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [contextMenu, setContextMenu] = useState<TagContextMenuState | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TagNode | null>(null);
  const [name, setName] = useState('');
  const [color, setColor] = useState('');

  useEffect(() => {
    void load(refreshToken > 0);
  }, [load, refreshToken]);

  const openEditor = (state: EditorState): void => {
    setName(state.mode === 'rename' ? state.node.name : '');
    setColor(state.mode === 'rename' ? (state.node.color ?? '') : '');
    setEditor(state);
  };

  const saveEditor = async (): Promise<void> => {
    if (!editor) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    const colorValue = color.trim().length > 0 ? color.trim() : null;
    if (editor.mode === 'create') {
      await create(editor.parentId, trimmed, colorValue);
    } else {
      const unchangedColor = colorValue === (editor.node.color ?? null) ? undefined : colorValue;
      await rename(editor.node.id, trimmed, unchangedColor);
    }
    setEditor(null);
  };

  const handleExport = async (): Promise<void> => {
    const data = await exportTags();
    if (data === null || data === undefined) return;
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'vl-tags.json';
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const handleImportFile = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      const data: unknown = JSON.parse(await file.text());
      await importTags(data);
    } catch (importError) {
      pushToast({ kind: 'error', message: t('toast.error', { message: errorText(importError) }) });
    }
  };

  const focusRelative = (delta: number): void => {
    const nodes = Array.from(
      containerRef.current?.querySelectorAll<HTMLElement>('[data-tag-id]') ?? [],
    );
    if (nodes.length === 0) return;
    const focused = (document.activeElement?.closest('[data-tag-id]') as HTMLElement | null) ?? null;
    const index = focused ? nodes.indexOf(focused) : -1;
    const next = nodes[Math.min(nodes.length - 1, Math.max(0, index + delta))];
    next?.focus();
  };

  const handleNodeKeyDown = (event: ReactKeyboardEvent<HTMLLIElement>, node: TagNode): void => {
    // Enter/Space на вложенной кнопке обрабатывает сама кнопка (иначе будет двойной toggle).
    const target = event.target as HTMLElement;
    if ((event.key === 'Enter' || event.key === ' ') && target !== event.currentTarget && target.closest('button')) {
      return;
    }
    const isExpanded = expandedIds.includes(node.id);
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        focusRelative(1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        focusRelative(-1);
        break;
      case 'ArrowRight':
        event.preventDefault();
        if (node.children.length > 0 && !isExpanded) toggleExpand(node.id);
        else focusRelative(1);
        break;
      case 'ArrowLeft': {
        event.preventDefault();
        if (isExpanded) {
          toggleExpand(node.id);
        } else {
          const parent = event.currentTarget.parentElement?.closest<HTMLElement>('[data-tag-id]');
          parent?.focus();
        }
        break;
      }
      case 'Enter':
        event.preventDefault();
        toggleActive(node.id);
        break;
      case ' ':
        event.preventDefault();
        toggleActive(node.id, { additive: true });
        break;
      case 'F2':
        event.preventDefault();
        openEditor({ mode: 'rename', node });
        break;
      case 'Delete':
        event.preventDefault();
        setDeleteTarget(node);
        break;
      case 'Home':
        event.preventDefault();
        focusRelative(-Number.MAX_SAFE_INTEGER);
        break;
      case 'End':
        event.preventDefault();
        focusRelative(Number.MAX_SAFE_INTEGER);
        break;
      default:
        break;
    }
  };

  const buildMenuItems = (node: TagNode | null): ContextMenuItem[] => {
    const items: ContextMenuItem[] = [
      {
        id: 'create',
        label: t('tags.create'),
        onSelect: () => openEditor({ mode: 'create', parentId: node?.id ?? null }),
      },
    ];
    if (node) {
      items.push({
        id: 'rename',
        label: t('tags.rename'),
        onSelect: () => openEditor({ mode: 'rename', node }),
      });
      items.push({
        id: 'delete',
        label: t('tags.delete'),
        danger: true,
        separatorBefore: true,
        onSelect: () => setDeleteTarget(node),
      });
    }
    items.push({
      id: 'export',
      label: t('tags.export'),
      separatorBefore: node === null,
      onSelect: () => void handleExport(),
    });
    items.push({
      id: 'import',
      label: t('tags.import'),
      onSelect: () => fileInputRef.current?.click(),
    });
    return items;
  };

  const handleNodeDragStart = (event: DragEvent<HTMLLIElement>, node: TagNode): void => {
    event.dataTransfer.setData(TAG_MIME, String(node.id));
    event.dataTransfer.setData('text/plain', node.name);
    event.dataTransfer.effectAllowed = 'copyMove';
  };

  const handleNodeClick = (event: ReactMouseEvent<HTMLButtonElement>, node: TagNode): void => {
    toggleActive(node.id, {
      additive: event.ctrlKey || event.metaKey,
      range: event.shiftKey,
    });
  };

  const renderNode = (node: TagNode, level: number): ReactNode => {
    const isExpanded = expandedIds.includes(node.id);
    const active = activeTagIds.includes(node.id);
    const hasChildren = node.children.length > 0;
    return (
      <li
        key={node.id}
        role="treeitem"
        aria-level={level}
        aria-expanded={hasChildren ? isExpanded : undefined}
        aria-selected={active}
        data-tag-id={node.id}
        tabIndex={0}
        className="vl-tag-node"
        draggable
        onDragStart={(event) => handleNodeDragStart(event, node)}
        onKeyDown={(event) => handleNodeKeyDown(event, node)}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setContextMenu({ x: event.clientX, y: event.clientY, node });
        }}
      >
        <div className={`vl-tree-row${active ? ' vl-tree-row--active' : ''}`} style={{ paddingLeft: 4 + (level - 1) * 12 }}>
          {hasChildren ? (
            <button
              type="button"
              className="vl-tree-row__chevron"
              aria-label={node.name}
              aria-expanded={isExpanded}
              onClick={() => toggleExpand(node.id)}
            >
              <span aria-hidden="true">{isExpanded ? '▾' : '▸'}</span>
            </button>
          ) : (
            <span className="vl-tree-row__chevron vl-tree-row__chevron--empty" aria-hidden="true" />
          )}
          <span
            className="vl-tag-swatch"
            style={node.color ? { background: node.color } : undefined}
            aria-hidden="true"
          />
          <button
            type="button"
            className="vl-tree-row__label"
            title={t('sidebar.tabTags')}
            onClick={(event) => handleNodeClick(event, node)}
          >
            {node.name}
          </button>
          <span className="vl-tree-row__count" title={t('files.columnTags')}>
            {node.counts.files}
          </span>
        </div>
        {hasChildren && isExpanded && (
          <ul role="group">{node.children.map((child) => renderNode(child, level + 1))}</ul>
        )}
      </li>
    );
  };

  if (loading && tree.length === 0) {
    return (
      <div className="vl-tree-panel__status">
        <Spinner />
      </div>
    );
  }

  if (error && tree.length === 0) {
    return (
      <EmptyState
        title={t('toast.error', { message: error })}
        actionLabel={t('common.retry')}
        onAction={() => void load(true)}
      />
    );
  }

  return (
    <div className="vl-tree-panel">
      <div className="vl-tree-panel__toolbar">
        <button type="button" onClick={() => openEditor({ mode: 'create', parentId: null })}>
          {t('tags.create')}
        </button>
        <button type="button" onClick={() => fileInputRef.current?.click()}>
          {t('tags.import')}
        </button>
        <button type="button" onClick={() => void handleExport()}>
          {t('tags.export')}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json,.json"
          className="sr-only"
          aria-hidden="true"
          tabIndex={-1}
          onChange={(event) => void handleImportFile(event)}
        />
      </div>

      {activeTagIds.length > 0 && (
        <div className="vl-tag-filter" role="group" aria-label={t('annotations.tags')}>
          <button type="button" aria-pressed={mode === 'union'} onClick={() => void setMode('union')}>
            {t('tags.multiUnion')}
          </button>
          <button
            type="button"
            aria-pressed={mode === 'intersection'}
            onClick={() => void setMode('intersection')}
          >
            {t('tags.multiIntersection')}
          </button>
          <button type="button" aria-label={t('common.close')} title={t('common.close')} onClick={clearActive}>
            ×
          </button>
        </div>
      )}

      {tree.length === 0 ? (
        <EmptyState
          title={t('sidebar.noTags')}
          actionLabel={t('tags.create')}
          onAction={() => openEditor({ mode: 'create', parentId: null })}
        />
      ) : (
        <ul
          ref={containerRef}
          className="vl-tree"
          role="tree"
          aria-label={t('sidebar.tabTags')}
          onContextMenu={(event) => {
            event.preventDefault();
            setContextMenu({ x: event.clientX, y: event.clientY, node: null });
          }}
        >
          {tree.map((node) => renderNode(node, 1))}
        </ul>
      )}

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={buildMenuItems(contextMenu.node)}
          label={t('sidebar.tabTags')}
          onClose={() => setContextMenu(null)}
        />
      )}

      {deleteTarget && (
        <ConfirmDialog
          title={t('tags.delete')}
          message={t('tags.deleteConfirm', { name: deleteTarget.name })}
          confirmLabel={t('common.delete')}
          danger
          onConfirm={() => {
            const target = deleteTarget;
            setDeleteTarget(null);
            void remove(target.id);
          }}
          onCancel={() => setDeleteTarget(null)}
        />
      )}

      {editor && (
        <div
          className="vl-tag-editor-overlay"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setEditor(null);
          }}
        >
          <div className="vl-tag-editor" role="dialog" aria-modal="true" aria-labelledby="vl-tag-editor-title">
            <h2 id="vl-tag-editor-title">
              {editor.mode === 'create' ? t('tags.create') : t('tags.rename')}
            </h2>
            <input
              autoFocus
              value={name}
              aria-label={t('tags.namePlaceholder')}
              placeholder={t('tags.namePlaceholder')}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void saveEditor();
                } else if (event.key === 'Escape') {
                  event.preventDefault();
                  setEditor(null);
                }
              }}
            />
            <input
              value={color}
              aria-label={t('tags.colorPlaceholder')}
              placeholder={t('tags.colorPlaceholder')}
              onChange={(event) => setColor(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void saveEditor();
                } else if (event.key === 'Escape') {
                  event.preventDefault();
                  setEditor(null);
                }
              }}
            />
            <div className="vl-tag-editor__actions">
              <button type="button" onClick={() => setEditor(null)}>
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="primary"
                disabled={name.trim().length === 0}
                onClick={() => void saveEditor()}
              >
                {t('common.save')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
