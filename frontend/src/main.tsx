import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { initBackend } from './api/client';
import { applyTheme, useUIStore } from './state/uiStore';
import './styles/global.css';

const root = createRoot(document.getElementById('root') as HTMLElement);

function render(): void {
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

async function bootstrap(): Promise<void> {
  applyTheme(useUIStore.getState().theme);
  useUIStore.subscribe((state) => applyTheme(state.theme));
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    applyTheme(useUIStore.getState().theme);
  });
  try {
    await initBackend();
    useUIStore.getState().setBackendReady(true);
  } catch (error) {
    console.error('Backend init failed', error);
  }
  render();
}

void bootstrap();
