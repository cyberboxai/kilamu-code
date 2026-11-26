import { closeSync, constants, lstatSync, openSync, renameSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { redact } from './redact.ts';

/**
 * Structured JSONL logger (directive §21). Local only — no telemetry.
 * Values are redacted before write. Rotates at 5 MB (keeps one previous file).
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const MAX_BYTES = 5 * 1024 * 1024;

export class Logger {
  private readonly file: string | null;
  private readonly component: string;
  constructor(logsDir: string | null, component: string) {
    this.file = logsDir ? join(logsDir, 'kilamu.jsonl') : null;
    this.component = component;
  }

  log(level: LogLevel, event: string, data: Record<string, unknown> = {}): void {
    if (!this.file) return;
    if (level === 'debug' && !process.env.KILAMU_DEBUG) return;
    const line = redact(JSON.stringify({ at: new Date().toISOString(), level, component: this.component, event, ...data })).text;
    try {
      let size = 0;
      try {
        const st = lstatSync(this.file);
        if (!st.isFile()) return; // never write through symlinks or special files
        size = st.size;
      } catch {
        // does not exist yet
      }
      if (size > MAX_BYTES) renameSync(this.file, `${this.file}.1`);
      // O_NOFOLLOW: a planted symlink makes open fail instead of redirecting the write.
      const fd = openSync(this.file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
      try {
        writeSync(fd, `${line}\n`);
      } finally {
        closeSync(fd);
      }
    } catch {
      // Logging must never break the caller (hooks, statusline).
    }
  }

  debug(event: string, data?: Record<string, unknown>): void { this.log('debug', event, data); }
  info(event: string, data?: Record<string, unknown>): void { this.log('info', event, data); }
  warn(event: string, data?: Record<string, unknown>): void { this.log('warn', event, data); }
  error(event: string, data?: Record<string, unknown>): void { this.log('error', event, data); }
}
