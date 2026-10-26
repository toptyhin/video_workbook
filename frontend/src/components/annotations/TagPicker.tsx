import { useEffect, useMemo, useState } from 'react';

import { api } from '../../api/client';
import type { TagNode } from '../../api/types';
import { t } from '../../lib/i18n';
import './TagPicker.css';

interface FlatTag {
  id: number;
  name: string;
  depth: number;
  color: string | null;
}

export interface TagPickerProps {
  selected: number[];
  onChange: (ids: number[]) => void;
  id?: string;
  className?: string;
}

function flattenTags(nodes: readonly TagNode[], depth = 0, out: FlatTag[] = []): FlatTag[] {
  for (const node of nodes) {
    out.push({ id: node.id, name: node.name, depth, color: node.color });
    if (node.children.length > 0) flattenTags(node.children, depth + 1, out);
  }
  return out;
}

export function TagPicker({ selected, onChange, id, className }: TagPickerProps): JSX.Element {
  const [tags, setTags] = useState<FlatTag[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .tags()
      .then((response) => {
        if (cancelled) return;
        setTags(flattenTags(response.items));
        setError(null);
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return tags;
    return tags.filter((tag) => tag.name.toLowerCase().includes(needle));
  }, [query, tags]);

  const toggle = (tagId: number): void => {
    onChange(
      selected.includes(tagId)
        ? selected.filter((item) => item !== tagId)
        : [...selected, tagId],
    );
  };

  return (
    <div className={`vl-tag-picker${className ? ` ${className}` : ''}`} id={id}>
      <input
        type="search"
        className="vl-tag-picker__search"
        value={query}
        placeholder={t('annotations.filterTag')}
        aria-label={t('annotations.filterTag')}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div className="vl-tag-picker__list" role="group" aria-label={t('annotations.tags')}>
        {loading && <span className="vl-tag-picker__hint">{t('timings.loading')}</span>}
        {!loading && error && (
          <button type="button" className="vl-tag-picker__retry" onClick={() => setReloadKey((value) => value + 1)}>
            {t('common.retry')}
          </button>
        )}
        {!loading && !error && filtered.length === 0 && (
          <span className="vl-tag-picker__hint">{t('tags.searchEmpty')}</span>
        )}
        {!loading &&
          !error &&
          filtered.map((tag) => (
            <label
              key={tag.id}
              className="vl-tag-picker__item"
              style={{ paddingLeft: `${8 + tag.depth * 12}px` }}
            >
              <input
                type="checkbox"
                checked={selected.includes(tag.id)}
                onChange={() => toggle(tag.id)}
              />
              {tag.color && (
                <span className="vl-tag-picker__dot" style={{ backgroundColor: tag.color }} aria-hidden="true" />
              )}
              <span className="vl-tag-picker__name">{tag.name}</span>
            </label>
          ))}
      </div>
    </div>
  );
}
