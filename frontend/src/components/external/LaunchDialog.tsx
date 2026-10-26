import { useEffect, useRef, useState } from 'react';

import { t } from '../../lib/i18n';
import { formatTimecode } from '../../lib/time';
import { useExternalStore } from '../../state/externalStore';
import { usePlayerStore } from '../../state/playerStore';
import { useUIStore } from '../../state/uiStore';
import './LaunchDialog.css';

type StartMode = 'beginning' | 'current' | 'mark';

/** Диалог запуска внешнего плеера: плеер, стартовая позиция, метки, «запомнить». */
export function LaunchDialog(): JSX.Element | null {
  const request = useExternalStore((state) => state.launchRequest);
  const players = useExternalStore((state) => state.players);
  const configured = useExternalStore((state) => state.configured);
  const defaultPassMarks = useExternalStore((state) => state.passMarks);
  const loading = useExternalStore((state) => state.loading);
  const storeError = useExternalStore((state) => state.error);

  const annotations = usePlayerStore((state) => state.annotations);
  const positionMs = usePlayerStore((state) => state.positionMs);
  const pushToast = useUIStore((state) => state.pushToast);

  const [player, setPlayer] = useState(configured);
  const [startMode, setStartMode] = useState<StartMode>('beginning');
  const [markId, setMarkId] = useState<number | null>(null);
  const [passMarks, setPassMarks] = useState(defaultPassMarks);
  const [remember, setRemember] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!request) return;
    const store = useExternalStore.getState();
    const playerState = usePlayerStore.getState();
    setPlayer(store.configured);
    setStartMode(playerState.positionMs > 500 ? 'current' : 'beginning');
    setMarkId(playerState.annotations.length > 0 ? playerState.annotations[0].id : null);
    setPassMarks(store.passMarks);
    setRemember(false);
  }, [request]);

  useEffect(() => {
    if (!request) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        useExternalStore.getState().closeLaunch();
      }
    };
    document.addEventListener('keydown', onKey, true);
    const focusTimer = window.setTimeout(() => dialogRef.current?.querySelector<HTMLElement>('select, button')?.focus(), 0);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      window.clearTimeout(focusTimer);
    };
  }, [request]);

  if (!request) return null;

  const startMs =
    startMode === 'beginning'
      ? 0
      : startMode === 'current'
        ? positionMs
        : (annotations.find((item) => item.id === markId)?.start_ms ?? 0);
  const selectedPlayer = players.find((item) => item.id === player);
  const availablePlayers = players.filter((item) => item.available);

  const handleLaunch = async (): Promise<void> => {
    const ok = await useExternalStore.getState().launch({
      player: selectedPlayer?.available ? selectedPlayer.id : undefined,
      startMs,
      passMarks,
      remember,
    });
    if (ok) {
      pushToast({ kind: 'success', message: t('external.opened', { player: selectedPlayer?.label ?? player }) });
    } else {
      pushToast({
        kind: 'error',
        message: t('toast.error', { message: useExternalStore.getState().error ?? t('external.unavailable') }),
      });
    }
  };

  const close = (): void => useExternalStore.getState().closeLaunch();

  return (
    <div className="vl-launch-backdrop" onMouseDown={(event) => event.target === event.currentTarget && close()}>
      <div
        ref={dialogRef}
        className="vl-launch"
        role="dialog"
        aria-modal="true"
        aria-labelledby="vl-launch-title"
      >
        <h2 className="vl-launch__title" id="vl-launch-title">
          {t('external.openTitle')}
        </h2>

        <div className="vl-launch__field">
          <label htmlFor="vl-launch-player">{t('external.player')}</label>
          <select
            id="vl-launch-player"
            value={player}
            onChange={(event) => setPlayer(event.target.value)}
          >
            {players.map((item) => (
              <option key={item.id} value={item.id} disabled={!item.available}>
                {item.label}
                {item.sync ? ' · sync' : ''}
                {!item.available ? ` (${t('external.notAvailable')})` : ''}
              </option>
            ))}
          </select>
        </div>

        <fieldset className="vl-launch__group">
          <legend className="vl-launch__legend">{t('external.start')}</legend>
          <label className="vl-launch__radio">
            <input
              type="radio"
              name="start"
              checked={startMode === 'beginning'}
              onChange={() => setStartMode('beginning')}
            />
            {t('external.startBeginning')}
          </label>
          <label className="vl-launch__radio">
            <input
              type="radio"
              name="start"
              checked={startMode === 'current'}
              onChange={() => setStartMode('current')}
            />
            {t('external.startCurrent')} · {formatTimecode(positionMs)}
          </label>
          <label className="vl-launch__radio">
            <input
              type="radio"
              name="start"
              disabled={annotations.length === 0}
              checked={startMode === 'mark'}
              onChange={() => setStartMode('mark')}
            />
            {t('external.startMark')}
          </label>
          {startMode === 'mark' && annotations.length > 0 && (
            <select
              className="vl-launch__mark"
              value={markId ?? ''}
              onChange={(event) => setMarkId(Number(event.target.value))}
              aria-label={t('external.startMark')}
            >
              {annotations.map((item) => (
                <option key={item.id} value={item.id}>
                  {formatTimecode(item.start_ms)} — {item.label}
                </option>
              ))}
            </select>
          )}
        </fieldset>

        <label className="vl-launch__check">
          <input type="checkbox" checked={passMarks} onChange={(event) => setPassMarks(event.target.checked)} />
          {t('external.passMarks')}
        </label>
        <label className="vl-launch__check">
          <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
          {t('external.remember')}
        </label>

        {storeError && <p className="vl-launch__error">{storeError}</p>}
        <p className="vl-launch__hint">
          {t('external.ctaHint', {
            detail: selectedPlayer?.path ?? t('external.notAvailable'),
          })}
        </p>

        <footer className="vl-launch__footer">
          <button type="button" onClick={close}>
            {t('external.cancel')}
          </button>
          <button
            type="button"
            className="primary"
            disabled={loading || availablePlayers.length === 0 || !selectedPlayer?.available}
            onClick={() => void handleLaunch()}
          >
            {t('external.launch')}
          </button>
        </footer>
      </div>
    </div>
  );
}
