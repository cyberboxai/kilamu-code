import { spawn } from 'node:child_process';
import { KilamuError } from './errors.ts';

/**
 * Safe command execution (directive §17).
 *  - never uses a shell: commands are parsed into argv
 *  - rejects shell metacharacters instead of interpreting them
 *  - bounded runtime (timeout + SIGKILL escalation) and bounded captured output
 *  - program allowlist enforced by callers that run model-authored commands
 */

export interface ExecResult {
  argv: string[];
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  /** True if output exceeded maxOutputBytes and was cut. */
  truncated: boolean;
}

export interface ExecOptions {
  cwd: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  env?: NodeJS.ProcessEnv;
}

const SHELL_META = /[|&;<>`$(){}\n\r\\*?!~]|\[|\]/;

/**
 * Parse a command string into argv. Supports single/double quotes and plain
 * whitespace separation only. Rejects anything that would need a shell.
 */
export function parseCommand(command: string): string[] {
  const argv: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let hasToken = false;
  for (const ch of command.trim()) {
    if (quote) {
      if (ch === quote) quote = null;
      else if (quote === '"' && (ch === '$' || ch === '`' || ch === '\\')) {
        throw new KilamuError('UNSAFE_COMMAND', `Shell expansion is not supported in commands: ${command}`);
      } else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      hasToken = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (hasToken) argv.push(cur);
      cur = '';
      hasToken = false;
      continue;
    }
    if (SHELL_META.test(ch)) {
      throw new KilamuError('UNSAFE_COMMAND', `Shell metacharacter "${ch}" is not allowed (commands run without a shell): ${command}`);
    }
    cur += ch;
    hasToken = true;
  }
  if (quote) throw new KilamuError('UNSAFE_COMMAND', `Unterminated quote in command: ${command}`);
  if (hasToken) argv.push(cur);
  if (argv.length === 0) throw new KilamuError('UNSAFE_COMMAND', 'Empty command');
  return argv;
}

export function run(argv: string[], opts: ExecOptions): Promise<ExecResult> {
  const timeoutMs = opts.timeoutMs ?? 10 * 60_000;
  const maxBytes = opts.maxOutputBytes ?? 8 * 1024 * 1024;
  const [cmd, ...args] = argv;
  if (!cmd) throw new KilamuError('UNSAFE_COMMAND', 'Empty argv');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new KilamuError('USAGE', 'timeout must be a positive number');
  const started = Date.now();
  const posix = process.platform !== 'win32';
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      // Own process group so a timeout kills grandchildren too (npm → node → workers).
      detached: posix,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let bytes = 0;
    let truncated = false;
    let timedOut = false;
    let done = false;
    const collect = (sink: Buffer[]) => (chunk: Buffer) => {
      if (bytes >= maxBytes) {
        truncated = true;
        return;
      }
      const room = maxBytes - bytes;
      const piece = chunk.length > room ? chunk.subarray(0, room) : chunk;
      if (piece.length < chunk.length) truncated = true;
      bytes += piece.length;
      sink.push(piece);
    };
    child.stdout.on('data', collect(out));
    child.stderr.on('data', collect(err));
    const killTree = (signal: NodeJS.Signals) => {
      try {
        if (posix && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        // group already gone
      }
    };
    const finish = (exitCode: number | null, signal: string | null, spawnError?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(grace);
      resolvePromise({
        argv,
        exitCode,
        signal,
        timedOut,
        durationMs: Date.now() - started,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: spawnError ? `${Buffer.concat(err).toString('utf8')}${spawnError.message}` : Buffer.concat(err).toString('utf8'),
        truncated,
      });
    };
    let grace: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree('SIGTERM');
      setTimeout(() => killTree('SIGKILL'), 3000).unref();
      // If a descendant escaped the group and keeps pipes open, stop waiting.
      grace = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        finish(null, 'SIGKILL');
      }, 5000);
    }, timeoutMs);
    child.on('error', (e) => finish(null, null, e));
    child.on('close', (code, signal) => finish(code, signal));
  });
}

