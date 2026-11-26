import { parseArgs, type ParseArgsConfig } from 'node:util';
import { KilamuError } from '../core/errors.ts';

export type OptionSpec = NonNullable<ParseArgsConfig['options']>;

export interface Parsed {
  values: Record<string, string | boolean | string[] | undefined>;
  positionals: string[];
}

/** Strict per-command parsing: unknown flags are errors, not silently ignored. */
export function parse(argv: string[], options: OptionSpec): Parsed {
  try {
    const r = parseArgs({ args: argv, options: { json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' }, ...options }, allowPositionals: true, strict: true });
    return { values: r.values as Parsed['values'], positionals: r.positionals };
  } catch (e) {
    throw new KilamuError('USAGE', (e as Error).message);
  }
}

export function str(p: Parsed, key: string): string | undefined {
  const v = p.values[key];
  return typeof v === 'string' ? v : undefined;
}

export function req(p: Parsed, key: string, hint: string): string {
  const v = str(p, key);
  if (!v) throw new KilamuError('USAGE', `--${key} is required (${hint})`);
  return v;
}

export function list(p: Parsed, key: string): string[] {
  const v = p.values[key];
  return Array.isArray(v) ? v : typeof v === 'string' ? [v] : [];
}

export function flag(p: Parsed, key: string): boolean {
  return p.values[key] === true;
}

export function int(p: Parsed, key: string, def: number, min: number, max: number): number {
  const v = str(p, key);
  if (v === undefined) return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new KilamuError('USAGE', `--${key} must be an integer in ${min}..${max}`);
  return n;
}

export function pos(p: Parsed, i: number, name: string): string {
  const v = p.positionals[i];
  if (!v) throw new KilamuError('USAGE', `missing <${name}>`);
  return v;
}

/** Parse "A-B" (1-based inclusive) line ranges. */
export function lineRange(v: string | undefined): { start?: number; end?: number } {
  if (!v) return {};
  const m = /^(\d+)(?:-(\d+))?$/.exec(v);
  if (!m) throw new KilamuError('USAGE', `--lines must look like 120-180`);
  const start = Number(m[1]);
  const end = m[2] ? Number(m[2]) : start;
  if (end < start) throw new KilamuError('USAGE', '--lines end must be ≥ start');
  return { start, end };
}

export async function readStdin(maxBytes = 32 * 1024 * 1024): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const b = chunk as Buffer;
    size += b.length;
    if (size > maxBytes) throw new KilamuError('INPUT_TOO_LARGE', `stdin exceeds ${maxBytes} bytes`);
    chunks.push(b);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Parse "<sub> [args]" where flags (e.g. --json) may appear anywhere, including before the subcommand. */
export function parseSub(argv: string[], options: OptionSpec): { sub: string | undefined; p: Parsed } {
  const p = parse(argv, options);
  const [sub, ...rest] = p.positionals;
  return { sub, p: { values: p.values, positionals: rest } };
}
