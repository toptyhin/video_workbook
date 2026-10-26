import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    // Явно IPv4: Electron и dev.sh обращаются к 127.0.0.1 (Vite по умолчанию
    // может слушать только ::1/localhost, что даёт ERR_CONNECTION_REFUSED).
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: process.env.VL_DEV_BACKEND_URL ?? 'http://127.0.0.1:8765',
        changeOrigin: true,
      },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
