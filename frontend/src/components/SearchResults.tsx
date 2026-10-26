import { useMemo, useState } from 'react';
import type { SearchItem } from '../api/types';
import { t } from '../lib/i18n';
import { formatTimecode } from '../lib/time';
import { useSearchStore } from '../state/searchStore';
import { EmptyState } from './ui/EmptyState';
import { Spinner } from './ui/Spinner';
import './SearchResults.css';

type SearchKind = SearchItem['kind'];

const KINDS: { kind: SearchKind; labelKey: string }[] = [
  { kind: 'file', labelKey: 'search.file' },
  { kind: 'segment', labelKey: 'search.segment' },
  { kind: 'annotation', labelKey: 'search.annotation' },
];

function itemTimecode(item: SearchItem): number | null {
  if (item.kind === 'file') return null;
  return item.start_ms;
}

function ItemSnippet({ item }: { item: SearchItem }) {
  // snippet_html формируется сервером через sqlite snippet() + html.escape (plans/00 A8):
  // это ЕДИНСТВЕННОЕ место, где HTML вставляется как разметка.
  return (
    <span
      className="vl-search__snippet"
      dangerouslySetInnerHTML={{ __html: item.snippet_html }}
    />
  );
}

/** Панель результатов единого поиска `/api/search` (kind: файл/сегмент/метка). */
export function SearchResults() {
  const query = useSearchStore((state) => state.query);
  const results = useSearchStore((state) => state.results);
  const total = useSearchStore((state) => state.total);
  const loading = useSearchStore((state) => state.loading);
  const error = useSearchStore((state) => state.error);
  const runSearch = useSearchStore((state) => state.runSearch);
  const clear = useSearchStore((state) => state.clear);
  const openResult = useSearchStore((state) => state.openResult);

  const [kinds, setKinds] = useState<SearchKind[]>(['file', 'segment', 'annotation']);

  const filtered = useMemo(
    () => results.filter((item) => kinds.includes(item.kind)),
    [results, kinds],
  );

  if (query.trim().length === 0 && results.length === 0) return null;

  const toggleKind = (kind: SearchKind): void => {
    setKinds((current) =>
      current.includes(kind) ? current.filter((value) => value !== kind) : [...current, kind],
    );
  };

  return (
    <section className="vl-search" aria-label={t('search.results')}>
      <header className="vl-search__header">
        <div className="vl-search__title-row">
          <h2 className="vl-search__title">{t('search.results')}</h2>
          <span className="vl-search__total" aria-live="polite">
            {total}
          </span>
          <button
            type="button"
            className="vl-search__close"
            aria-label={t('common.close')}
            title={t('common.close')}
            onClick={clear}
          >
            ×
          </button>
        </div>
        <div className="vl-search__kinds" role="group" aria-label={t('search.results')}>
          {KINDS.map((item) => {
            const pressed = kinds.includes(item.kind);
            return (
              <button
                key={item.kind}
                type="button"
                className={`vl-search__chip${pressed ? ' vl-search__chip--active' : ''}`}
                aria-pressed={pressed}
                onClick={() => toggleKind(item.kind)}
              >
                {t(item.labelKey)}
              </button>
            );
          })}
        </div>
      </header>

      {loading && (
        <div className="vl-search__status">
          <Spinner compact /> {t('timings.loading')}
        </div>
      )}

      {!loading && error && (
        <EmptyState
          title={t('toast.error', { message: error })}
          actionLabel={t('common.retry')}
          onAction={() => void runSearch()}
        />
      )}

      {!loading && !error && filtered.length === 0 && (
        <EmptyState title={t('search.empty')} />
      )}

      {!loading && !error && filtered.length > 0 && (
        <ul className="vl-search__list">
          {filtered.map((item) => {
            const timecode = itemTimecode(item);
            return (
              <li key={`${item.kind}-${item.kind === 'file' ? item.video_id : item.kind === 'segment' ? item.segment_id : item.annotation_id}`}>
                <button
                  type="button"
                  className="vl-search__item"
                  onClick={() => openResult(item)}
                  title={
                    timecode === null
                      ? item.video_title
                      : t('search.openAt', { time: formatTimecode(timecode) })
                  }
                >
                  <span className={`vl-search__kind vl-search__kind--${item.kind}`}>
                    {t(`search.${item.kind}`)}
                  </span>
                  <span className="vl-search__body">
                    <span className="vl-search__video">{item.video_title}</span>
                    <ItemSnippet item={item} />
                    {item.kind === 'annotation' && (
                      <span className="vl-search__annotation">
                        <span
                          className="vl-search__swatch"
                          style={{ background: item.color }}
                          aria-hidden="true"
                        />
                        {item.label}
                      </span>
                    )}
                  </span>
                  <span className="vl-search__time">
                    {timecode === null ? '' : formatTimecode(timecode)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
