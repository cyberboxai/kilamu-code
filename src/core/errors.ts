/** Typed error carrying a stable machine-readable code. */
export class KilamuError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;
  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'KilamuError';
    this.code = code;
    this.details = details;
  }
}

export function isKilamuError(e: unknown): e is KilamuError {
  return e instanceof KilamuError;
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
