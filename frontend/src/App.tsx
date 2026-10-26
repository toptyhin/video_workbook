import { useEffect, useState } from 'react';
import { api } from './api/client';
import { t } from './lib/i18n';

export function App() {
  const [health, setHealth] = useState<string>('…');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .health()
      .then((value) => setHealth(`${value.status} · v${value.version} · db ${value.db}`))
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
  }, []);

  return (
    <div style={{ display: 'grid', placeItems: 'center', height: '100%', gap: 12 }}>
      <h1 style={{ margin: 0 }}>{t('app.name')}</h1>
      <p style={{ color: 'var(--vl-text-muted)', margin: 0 }}>Каркас приложения · backend: {health}</p>
      {error && <p style={{ color: 'var(--vl-danger)', margin: 0 }}>{error}</p>}
    </div>
  );
}
