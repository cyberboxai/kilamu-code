import { createHash, randomBytes } from 'node:crypto';

/** Sortable, collision-resistant id: <prefix>_<base36 time><random>. */
export function newId(prefix: string): string {
  const t = Date.now().toString(36).padStart(9, '0');
  const r = randomBytes(5).toString('hex');
  return `${prefix}_${t}${r}`;
}

export function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Plan-level task ids: short, filesystem- and CLI-safe. */
export const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
