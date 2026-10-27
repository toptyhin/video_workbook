import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import type { BackendInfo, BackendStatus } from './ipc-channels';
import type { Logger } from './logger';

const READY_TIMEOUT_MS = 15_000;
const MAX_RESTARTS = 3;

export interface BackendOptions {
  isPackaged: boolean;
  resourcesDir: string;
  dataDir: string;
  repoRoot: string;
  logger: Logger;
  onStatus: (status: BackendStatus) => void;
}

export class BackendManager {
  private child: ChildProcessWithoutNullStreams | null = null;
  private info: BackendInfo | null = null;
  private restarts = 0;
  private stopping = false;
  private readonly token: string;

  constructor(private readonly opts: BackendOptions) {
    this.token = process.env.VL_TOKEN ?? randomBytes(32).toString('hex');
  }

  getInfo(): BackendInfo {
    if (!this.info) throw new Error('Backend is not ready');
    return this.info;
  }

  async start(): Promise<BackendInfo> {
    // В dev бэкенд запускает scripts/dev.sh, а SPA грузится с Vite; API идёт
    // относительным путём через прокси Vite (same-origin, без CORS).
    const externalBackend = process.env.VL_BACKEND_URL;
    if (externalBackend) {
      this.info = { baseUrl: '', token: process.env.VL_TOKEN ?? '' };
      this.opts.onStatus('ready');
      return this.info;
    }
    return this.spawnBackend();
  }

  private resolveCommand(): { command: string; args: string[]; cwd: string } {
    if (this.opts.isPackaged) {
      const binary = path.join(this.opts.resourcesDir, 'backend', 'vl-backend');
      return { command: binary, args: [], cwd: path.dirname(binary) };
    }
    const py = process.env.VL_PYTHON ?? path.join(this.opts.repoRoot, '.venv', 'bin', 'python');
    return {
      command: py,
      args: ['-m', 'app.main'],
      cwd: path.join(this.opts.repoRoot, 'backend'),
    };
  }

  private spawnBackend(): Promise<BackendInfo> {
    const { command, args, cwd } = this.resolveCommand();
    this.opts.logger.info(`Starting backend: ${command} ${args.join(' ')}`);
    this.opts.onStatus('starting');
    const child = spawn(command, args, {
      cwd,
      env: {
        ...process.env,
        VL_TOKEN: this.token,
        VL_DATA_DIR: this.opts.dataDir,
        VL_RESOURCES_DIR: this.opts.resourcesDir,
        PYTHONUNBUFFERED: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;

    return new Promise<BackendInfo>((resolve, reject) => {
      let settled = false;
      let buffer = '';
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error('Backend did not report VL_READY in time'));
      }, READY_TIMEOUT_MS);

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        buffer += chunk;
        let newline = buffer.indexOf('\n');
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf('\n');
          if (!line) continue;
          if (line.startsWith('VL_READY:')) {
            try {
              const payload = JSON.parse(line.slice('VL_READY:'.length));
              if (settled) {
                // Дочерние процессы sidecar (multiprocessing spawn) наследуют
                // stdout, поэтому поздний VL_READY не должен перезаписывать
                // адрес уже работающего backend.
                this.opts.logger.warn(`Ignoring late VL_READY on port ${payload.port}`);
                continue;
              }
              this.info = { baseUrl: `http://127.0.0.1:${payload.port}`, token: this.token };
              settled = true;
              clearTimeout(timer);
              this.restarts = 0;
              this.opts.onStatus('ready');
              resolve(this.info);
            } catch (error) {
              this.opts.logger.error(`Bad VL_READY payload: ${line} (${String(error)})`);
            }
          } else {
            this.opts.logger.info(`[backend] ${line}`);
          }
        }
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        this.opts.logger.warn(`[backend stderr] ${String(chunk).trimEnd()}`);
      });
      child.on('error', (error) => {
        this.opts.logger.error(`Backend spawn error: ${String(error)}`);
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(error);
        }
      });
      child.on('exit', (code, signal) => {
        this.opts.logger.warn(`Backend exited code=${code} signal=${signal}`);
        this.child = null;
        this.info = null;
        if (this.stopping) {
          this.opts.onStatus('stopped');
          return;
        }
        this.opts.onStatus('crashed');
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error(`Backend exited before ready (code=${code})`));
        }
        void this.tryRestart();
      });
    });
  }

  private async tryRestart(): Promise<void> {
    if (this.restarts >= MAX_RESTARTS) {
      this.opts.logger.error('Backend restart limit reached');
      return;
    }
    this.restarts += 1;
    const delay = 1000 * 2 ** (this.restarts - 1);
    this.opts.logger.info(`Restarting backend in ${delay} ms (attempt ${this.restarts})`);
    await new Promise((resolve) => setTimeout(resolve, delay));
    if (this.stopping) return;
    try {
      await this.spawnBackend();
    } catch (error) {
      this.opts.logger.error(`Backend restart failed: ${String(error)}`);
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const child = this.child;
    if (!child) return;
    this.opts.onStatus('stopped');
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 5000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.child = null;
  }
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}
