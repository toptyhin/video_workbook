import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    environmentOptions: {
      jsdom: { url: 'http://localhost:5173/' },
    },
    globals: true,
    setupFiles: './src/test/setup.ts',
    css: false,
  },
});
