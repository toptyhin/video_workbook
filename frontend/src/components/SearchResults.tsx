import { useMemo, useState } from 'react';
import type { SearchItem, SearchMode, SemanticStatus } from '../api/types';
import { t } from '../lib/i18n';
import { formatTimecode } from '../lib/time';
import { SEARCH_MODES, selectSearchActive, useSearchStore } from '../state/searchStore';
import { EmptyState } from './ui/EmptyState';
import { Spinner } from './ui/Spinner';
import './SearchResults.css';

type SearchKind = SearchItem['kind'];

const KINDS: { kind: SearchKind; labelKey: string }[] = [
  { kind: 'file', labelKey: 'search.file' },
  { kind: 'segment', labelKey: 'search.segment' },
  { kind: 'annotation', labelKey: 'search.annotation' },
];

const MODE_LABELS: Record<SearchMode, string> = {
  fts: 'search.modeFts',
  semantic: 'search.modeSemantic',
  hybrid: 'search.modeHybrid',
};

function itemTimecode(item: SearchItem): number | null {
  if (item.kind === 'file') return null;
  return item.start_ms;
}

function semanticReason(semantic: SemanticStatus | null): string {
  return semantic?.detail
    ? t('search.semanticUnavailable', { detail: semantic.detail })
    : t('search.semanticNoDetail');
}

function indexingText(semantic: SemanticStatus): string {
  return t('search.semanticIndexing', {
    indexed: semantic.indexed_segments,
    total: semantic.total_segments,
  });
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

/**
 * Панель результатов единого поиска `/api/search` (kind: файл/сегмент/метка).
 * Живёт под полосой вкладок «Файлы/Метки» и при активном поиске заменяет список
 * файлов (plans/12 §4.2): шапка фиксирована, список скроллится внутри панели.
 */
export function SearchResults() {
  const scope = useSearchStore((state) => state.scope);
  const mode = useSearchStore((state) => state.mode);
  const semantic = useSearchStore((state) => state.semantic);
  const semanticLoading = useSearchStore((state) => state.semanticLoading);
  const results = useSearchStore((state) => state.results);
  const total = useSearchStore((state) => state.total);
  const loading = useSearchStore((state) => state.loading);
  const error = useSearchStore((state) => state.error);
  const active = useSearchStore(selectSearchActive);
  const runSearch = useSearchStore((state) => state.runSearch);
  const clear = useSearchStore((state) => state.clear);
  const setMode = useSearchStore((state) => state.setMode);
  const openResult = useSearchStore((state) => state.openResult);
  const reindexSemantic = useSearchStore((state) => state.reindexSemantic);

  const [kinds, setKinds] = useState<SearchKind[]>(['file', 'segment', 'annotation']);

  const filtered = useMemo(
    () => results.filter((item) => kinds.includes(item.kind)),
    [results, kinds],
  );

  if (!active) return null;

  const unavailable = semantic !== null && !semantic.available;
  const reason = semanticReason(semantic);
  const scopeHint =
    mode !== 'fts' && semantic?.available !== false && scope !== 'all' && scope !== 'segments';

  const toggleKind = (kind: SearchKind): void => {
    setKinds((current) =>
      current.includes(kind) ? current.filter((value) => value !== kind) : [...current, kind],
    );
  };

  return (
    <section className="vl-search" aria-label={t('search.results')} data-search-mode={mode}>
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

        <div className="vl-search__modes" role="group" aria-label={t('search.mode')}>
          {SEARCH_MODES.map((value) => {
            const pressed = mode === value;
            const disabled = value !== 'fts' && unavailable;
            return (
              <button
                key={value}
                type="button"
                className={`vl-search__mode${pressed ? ' vl-search__mode--active' : ''}`}
                aria-pressed={pressed}
                disabled={disabled}
                title={disabled ? reason : undefined}
                onClick={() => setMode(value)}
              >
                {t(MODE_LABELS[value])}
              </button>
            );
          })}
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

        {semantic !== null ? (
          <div className="vl-search__semantic">
            <span
              className={`vl-search__semantic-note${
                semantic.available && !semantic.indexing ? ' vl-search__semantic-note--muted' : ''
              }`}
              aria-live="polite"
            >
              {!semantic.available
                ? reason
                : semantic.indexing
                  ? indexingText(semantic)
                  : t('search.semanticReady', {
                      indexed: semantic.indexed_segments,
                      total: semantic.total_segments,
                    })}
            </span>
            {semantic.available && (
              <button
                type="button"
                className="vl-search__reindex"
                disabled={semantic.indexing || semanticLoading}
                title={t('search.reindex')}
                onClick={() => void reindexSemantic()}
              >
                {t('search.reindex')}
              </button>
            )}
          </div>
        ) : (
          semanticLoading &&
          mode !== 'fts' && (
            <div className="vl-search__semantic">
              <span className="vl-search__semantic-note vl-search__semantic-note--muted">
                {t('search.semanticChecking')}
              </span>
            </div>
          )
        )}

        {scopeHint && <p className="vl-search__hint">{t('search.semanticScopeHint')}</p>}
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
                  {item.semantic && (
                    <span className="vl-search__semantic-badge">{t('search.semanticBadge')}</span>
                  )}
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
