import type { LabeledValue } from './types.ts';

/**
 * Token ESTIMATE from text. Heuristic: ~4 characters per token for English
 * prose/code (Anthropic guidance for rough sizing). Always labeled ESTIMATED.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export function estimated(value: number, source = 'heuristic:chars/4'): LabeledValue {
  return { value, label: 'ESTIMATED', source };
}

export function measured(value: number, source: string): LabeledValue {
  return { value, label: 'MEASURED', source };
}

export function unavailable(source: string): LabeledValue {
  return { value: null, label: 'UNAVAILABLE', source };
}

export function formatTokens(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return 'n/a';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}
