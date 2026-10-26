import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  timeout: 180_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:8899',
    headless: true,
    viewport: { width: 1400, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command:
      'bash -lc "VITE_VL_TOKEN=e2e-token npm --prefix frontend run build >/dev/null && bash scripts/e2e-server.sh"',
    url: 'http://127.0.0.1:8899/',
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
