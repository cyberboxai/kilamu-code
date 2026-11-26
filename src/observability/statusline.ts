import { formatTokens } from '../core/tokens.ts';
import type { HudState, LabeledValue } from '../core/types.ts';

export interface StatuslineOptions {
  color?: boolean;
  compact?: boolean;
  width?: number;
}

type Tone = 'brand' | 'good' | 'warn' | 'bad' | 'dim' | 'plain';
interface Seg {
  text: string;
  tone: Tone;
}

const ANSI: Record<Tone, string> = { brand: '1;36', good: '32', warn: '33', bad: '31', dim: '2', plain: '' };
const SEP = ' | ';

/** Strip control characters so untrusted text cannot inject terminal escapes. */
function clean(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim();
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 3))}...`;
}

/** Format a labelled value; null when UNAVAILABLE. ESTIMATED gets a trailing `~`. */
function fmt(v: LabeledValue, f: (n: number) => string): string | null {
  if (v.label === 'UNAVAILABLE' || v.value === null) return null;
  return `${f(v.value)}${v.label === 'ESTIMATED' ? '~' : ''}`;
}

function headline(state: HudState): Seg[] {
  const u = state.usage;
  const segs: Seg[] = [{ text: 'KILAMU', tone: 'brand' }];
  if (u.model) segs.push({ text: clean(u.model), tone: 'plain' });
  const ctx = fmt(u.contextPct, (n) => `ctx ${Math.round(n)}%`);
  if (ctx) segs.push({ text: ctx, tone: u.contextPct.value !== null && u.contextPct.value >= 80 ? 'warn' : 'plain' });
  const tok = fmt(u.tokens, (n) => `${formatTokens(n)} tok`);
  if (tok) segs.push({ text: tok, tone: 'plain' });
  if (u.costUsd.label === 'MEASURED') {
    const cost = fmt(u.costUsd, (n) => `$${n.toFixed(2)}`);
    if (cost) segs.push({ text: cost, tone: 'plain' });
  }
  return segs;
}

function executionSegs(state: HudState, maxObjective: number): Seg[] {
  const e = state.execution;
  if (!e) return [];
  const verified = e.counts.VERIFIED ?? 0;
  const statusTone: Tone = e.status === 'FAILED' ? 'bad' : e.status === 'COMPLETED' ? 'good' : e.status === 'CANCELLED' ? 'dim' : 'plain';
  return [
    { text: truncate(clean(e.objective), maxObjective), tone: 'plain' },
    { text: e.mode, tone: 'dim' },
    { text: `VERIFIED ${verified}/${e.total} (${Math.round(e.progressPct)}%)`, tone: verified === e.total && e.total > 0 ? 'good' : 'plain' },
    { text: e.status, tone: statusTone },
  ];
}

function detailSegs(state: HudState): Seg[] {
  const e = state.execution;
  if (!e) return [];
  const segs: Seg[] = [];
  if (e.running.length > 0) {
    const shown = e.running.slice(0, 3).map((r) => `${clean(r.taskId)}:${r.role}`);
    const more = e.running.length > 3 ? ` +${e.running.length - 3}` : '';
    segs.push({ text: `running ${shown.join(', ')}${more}`, tone: 'plain' });
  }
  if (e.next) segs.push({ text: `next: ${truncate(clean(e.next), 40)}`, tone: 'plain' });
  if (e.blockers.length > 0) segs.push({ text: `blockers ${e.blockers.length}`, tone: 'bad' });
  const budget = fmt(state.budgetRemainingPct, (n) => `budget ${Math.round(n)}% left`);
  if (budget) segs.push({ text: budget, tone: state.budgetRemainingPct.value !== null && state.budgetRemainingPct.value < 20 ? 'warn' : 'plain' });
  return segs;
}

/** Drop trailing segments (then truncate the last) until the plain text fits `width`. */
function fit(segs: Seg[], width: number | undefined): Seg[] {
  if (!width || width <= 0) return segs;
  const out = [...segs];
  const len = (s: Seg[]) => s.map((x) => x.text).join(SEP).length;
  while (out.length > 1 && len(out) > width) out.pop();
  const only = out[0];
  if (out.length === 1 && only && only.text.length > width) out[0] = { ...only, text: truncate(only.text, width) };
  return out;
}

function paint(segs: Seg[], color: boolean): string {
  return segs
    .map((s) => (color && ANSI[s.tone] ? `\u001b[${ANSI[s.tone]}m${s.text}\u001b[0m` : s.text))
    .join(color ? `\u001b[2m${SEP}\u001b[0m` : SEP);
}

/** Pure, I/O-free HUD renderer. UNAVAILABLE metrics are omitted; ESTIMATED ones end with `~`. */
export function renderStatusline(state: HudState, opts: StatuslineOptions = {}): string {
  const color = opts.color === true;
  if (opts.compact) {
    const segs = [...headline(state), ...executionSegs(state, 24).slice(2)];
    return paint(fit(segs, opts.width), color);
  }
  const lines = [paint(fit(headline(state), opts.width), color)];
  const exec = executionSegs(state, 40);
  if (exec.length > 0) lines.push(paint(fit(exec, opts.width), color));
  const detail = detailSegs(state);
  if (detail.length > 0) lines.push(paint(fit(detail, opts.width), color));
  return lines.join('\n');
}

/** Parse raw stdin JSON from Claude Code's statusline hook. Null on invalid JSON. */
export function parseStatuslinePayload(raw: string): unknown | null {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}
