import { appendFileSync, existsSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';

const MAX_BYTES = 10 * 1024 * 1024;

export class Logger {
  private readonly file: string;

  constructor(logsDir: string) {
    this.file = path.join(logsDir, 'electron.log');
    try {
      if (existsSync(this.file) && statSync(this.file).size > MAX_BYTES) {
        renameSync(this.file, `${this.file}.1`);
      }
    } catch {
      /* ignore rotation errors */
    }
  }

  write(level: string, message: string): void {
    const line = `${new Date().toISOString()} | ${level.toUpperCase()} | ${message}\n`;
    try {
      appendFileSync(this.file, line, { encoding: 'utf8' });
    } catch {
      /* logging must never crash the app */
    }
    if (!process.env.VL_SILENT) {
      // eslint-disable-next-line no-console
      console.log(line.trimEnd());
    }
  }

  info(message: string): void { this.write('info', message); }
  warn(message: string): void { this.write('warn', message); }
  error(message: string): void { this.write('error', message); }
}
