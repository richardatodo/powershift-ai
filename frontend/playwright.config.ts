import { defineConfig, devices } from '@playwright/test';
import { tmpdir } from 'node:os';
import path from 'node:path';

if (process.env.POWERSHIFT_NATIVE_TESTS !== '1' || !process.env.POWERSHIFT_TEST_DATABASE_URL || !process.env.POWERSHIFT_PG_ROOT) {
  throw new Error('Browser tests require an explicitly disposable PostgreSQL cluster. See frontend/README.md.');
}
process.env.POWERSHIFT_BROWSER_SESSION_FILE ||= path.join(tmpdir(), `powershift-m6-browser-${process.pid}.json`);
const python = path.resolve('..', '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
export default defineConfig({
  testDir: './tests', fullyParallel: false, workers: 1, retries: 0, timeout: 45000,
  expect: { timeout: 10000 }, reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:5173', trace: 'retain-on-failure', screenshot: 'only-on-failure', reducedMotion: 'reduce' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  globalTeardown: './tests/teardown.ts',
  webServer: [
    { command: `"${python}" -B ../tests/browser_server.py`, url: 'http://127.0.0.1:8787/api/status', timeout: 40000, reuseExistingServer: false,
      env: { POWERSHIFT_BROWSER_SESSION_FILE: process.env.POWERSHIFT_BROWSER_SESSION_FILE! } },
    { command: 'npm run dev -- --port 5173 --strictPort', url: 'http://127.0.0.1:5173', timeout: 30000, reuseExistingServer: false,
      env: { VITE_OIDC_AUTHORITY: 'https://identity.example.test/', VITE_OIDC_CLIENT_ID: 'powershift-browser-client', POWERSHIFT_API_PROXY: 'http://127.0.0.1:8787' } },
  ],
});
