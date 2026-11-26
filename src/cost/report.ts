import { formatTokens, measured, unavailable } from '../core/tokens.ts';
import type { LabeledValue } from '../core/types.ts';
import type { UsageStore } from './usage.ts';

export interface CostReport {
  tokens: LabeledValue;
  costUsd: LabeledValue;
  costPerVerifiedTask: LabeledValue;
  tokensPerVerifiedTask: LabeledValue;
  notes: string[];
}

export interface CostReportDeps {
  usage: UsageStore;
  sessionId: string | null;
  executionStartedAt: string;
  verifiedTasks: number;
  totalTasks: number;
}

const NOTE_COST = 'costUsd comes from statusline cost.total_cost_usd, computed client-side at list price; it is not your bill on subscription plans.';
const NOTE_AGENTS = 'Per-agent usage is UNAVAILABLE: the platform does not expose it.';

export function costReport(deps: CostReportDeps): CostReport {
  const notes = [NOTE_COST, NOTE_AGENTS];
  const none = (why: string): CostReport => ({
    tokens: unavailable(why),
    costUsd: unavailable(why),
    costPerVerifiedTask: unavailable(why),
    tokensPerVerifiedTask: unavailable(why),
    notes: [why, ...notes],
  });
  if (!deps.sessionId) return none('no session id: no statusline samples to attribute');
  const d = deps.usage.deltaSince(deps.sessionId, deps.executionStartedAt);
  if (!d) return none('no statusline samples recorded since execution start');

  const tokensVal = d.inputTokens !== null && d.outputTokens !== null ? d.inputTokens + d.outputTokens : null;
  const tokens = tokensVal === null ? unavailable('statusline:context_window.total_*_tokens') : measured(tokensVal, 'statusline:context_window.total_*_tokens delta');
  const costUsd = d.costUsd === null ? unavailable('statusline:cost.total_cost_usd') : measured(d.costUsd, 'statusline:cost.total_cost_usd delta');
  if (d.samples < 2) notes.push('Only one sample since execution start: deltas are zero until more samples arrive.');

  const v = deps.verifiedTasks;
  const perTask = (val: LabeledValue, name: string): LabeledValue =>
    v > 0 && val.value !== null ? measured(val.value / v, `${val.source} / verified tasks`) : unavailable(v > 0 ? val.source : `${name}: no verified tasks`);
  return {
    tokens,
    costUsd,
    costPerVerifiedTask: perTask(costUsd, 'cost'),
    tokensPerVerifiedTask: perTask(tokens, 'tokens'),
    notes,
  };
}

function line(label: string, v: LabeledValue, fmt: (n: number) => string): string {
  return v.value === null ? `${label}: UNAVAILABLE (${v.source})` : `${label}: ${fmt(v.value)} [${v.label}] (${v.source})`;
}

export function renderCostReport(r: CostReport): string {
  return [
    line('Tokens', r.tokens, (n) => formatTokens(n)),
    line('Cost (USD, list price)', r.costUsd, (n) => `$${n.toFixed(4)}`),
    line('Cost per verified task', r.costPerVerifiedTask, (n) => `$${n.toFixed(4)}`),
    line('Tokens per verified task', r.tokensPerVerifiedTask, (n) => formatTokens(n)),
    ...r.notes.map((n) => `note: ${n}`),
  ].join('\n');
}
