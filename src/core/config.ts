import { existsSync, readFileSync } from 'node:fs';
import { writeFileAtomic } from './fsx.ts';
import { KilamuError } from './errors.ts';
import type { ModelAlias, TaskClass } from './types.ts';
import type { ProjectPaths } from './paths.ts';

/**
 * Project configuration lives in .kilamu/config.json. Defaults favour safe,
 * resource-efficient execution (directive §20). Nothing here is written unless
 * the user runs `kilamu config set` or `kilamu init`.
 */
export interface KilamuConfig {
  version: 1;
  execution: {
    /** 'auto' lets the mode selector decide; otherwise force a mode. */
    mode: 'auto' | 'SINGLE' | 'SUBAGENT' | 'TEAM';
    maxParallelAgents: number;
    maxRetries: number;
    /** Default execution budget in estimated tokens. */
    defaultBudgetTokens: number;
    /** Fraction of budget reserved for verification. */
    verificationReserve: number;
  };
  context: {
    defaultBudgetTokens: number;
    maxFileBytes: number;
    /** Compress large Bash outputs through the PostToolUse hook (opt-in). */
    compressToolOutput: boolean;
    compressThresholdChars: number;
  };
  models: Record<TaskClass, ModelAlias>;
  verification: {
    defaultTimeoutSec: number;
  };
  indexing: {
    maxFiles: number;
    respectGitignore: boolean;
  };
  memory: {
    /** Minimum confidence required to promote to a reusable pattern. */
    promotionConfidence: number;
  };
}

export const DEFAULT_CONFIG: KilamuConfig = {
  version: 1,
  execution: {
    mode: 'auto',
    maxParallelAgents: 3,
    maxRetries: 2,
    defaultBudgetTokens: 400_000,
    verificationReserve: 0.15,
  },
  context: {
    defaultBudgetTokens: 8_000,
    maxFileBytes: 1_000_000,
    compressToolOutput: false,
    compressThresholdChars: 20_000,
  },
  models: {
    classification: 'haiku',
    discovery: 'haiku',
    summarization: 'haiku',
    research: 'sonnet',
    implementation: 'sonnet',
    debugging: 'sonnet',
    architecture: 'opus',
    security: 'opus',
    verification: 'sonnet',
  },
  verification: {
    defaultTimeoutSec: 600,
  },
  indexing: {
    maxFiles: 50_000,
    respectGitignore: true,
  },
  memory: {
    promotionConfidence: 0.8,
  },
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Deep-merge user overrides onto defaults; unknown keys are rejected. */
function merge(base: Record<string, unknown>, over: Record<string, unknown>, path: string): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (!(k in base)) throw new KilamuError('CONFIG_INVALID', `Unknown config key: ${JSON.stringify(`${path}${k}`.slice(0, 80))}${k === 'allowedPrograms' ? ' (verification programs are configured only in the user-scope verification.json — see SECURITY.md)' : ''}`);
    const b = base[k];
    if (isPlainObject(b)) {
      if (!isPlainObject(v)) throw new KilamuError('CONFIG_INVALID', `Config key ${path}${k} must be an object`);
      out[k] = merge(b, v, `${path}${k}.`);
    } else {
      if (typeof v !== typeof b || Array.isArray(v) !== Array.isArray(b)) {
        throw new KilamuError('CONFIG_INVALID', `Config key ${path}${k} must be ${Array.isArray(b) ? 'an array' : typeof b}`);
      }
      out[k] = v;
    }
  }
  return out;
}

function validate(c: KilamuConfig): KilamuConfig {
  const e = c.execution;
  if (!Number.isInteger(e.maxParallelAgents) || e.maxParallelAgents < 1 || e.maxParallelAgents > 8) {
    throw new KilamuError('CONFIG_INVALID', 'execution.maxParallelAgents must be an integer 1..8');
  }
  if (!Number.isInteger(e.maxRetries) || e.maxRetries < 0 || e.maxRetries > 5) {
    throw new KilamuError('CONFIG_INVALID', 'execution.maxRetries must be an integer 0..5');
  }
  if (e.verificationReserve < 0 || e.verificationReserve > 0.5) {
    throw new KilamuError('CONFIG_INVALID', 'execution.verificationReserve must be within 0..0.5');
  }
  if (!['auto', 'SINGLE', 'SUBAGENT', 'TEAM'].includes(e.mode)) throw new KilamuError('CONFIG_INVALID', 'execution.mode invalid');
  const ranges: Array<[string, number, number, number]> = [
    ['execution.defaultBudgetTokens', e.defaultBudgetTokens, 1_000, 50_000_000],
    ['context.defaultBudgetTokens', c.context.defaultBudgetTokens, 500, 200_000],
    ['context.maxFileBytes', c.context.maxFileBytes, 1_000, 50_000_000],
    ['context.compressThresholdChars', c.context.compressThresholdChars, 1_000, 10_000_000],
    ['verification.defaultTimeoutSec', c.verification.defaultTimeoutSec, 1, 7_200],
    ['indexing.maxFiles', c.indexing.maxFiles, 1, 1_000_000],
  ];
  for (const [k, v, min, max] of ranges) {
    if (!Number.isFinite(v) || v < min || v > max) throw new KilamuError('CONFIG_INVALID', `${k} must be within ${min}..${max}`);
  }
  if (!(c.memory.promotionConfidence >= 0 && c.memory.promotionConfidence <= 1)) throw new KilamuError('CONFIG_INVALID', 'memory.promotionConfidence must be within 0..1');
  for (const [k, v] of Object.entries(c.models)) {
    if (!['haiku', 'sonnet', 'opus', 'fable', 'inherit'].includes(v)) throw new KilamuError('CONFIG_INVALID', `models.${k} invalid: ${v}`);
  }
  return c;
}

export function loadConfig(paths: ProjectPaths): KilamuConfig {
  if (!existsSync(paths.configFile)) return structuredClone(DEFAULT_CONFIG);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(paths.configFile, 'utf8'));
  } catch (e) {
    throw new KilamuError('CONFIG_INVALID', `Cannot parse ${paths.configFile}: ${(e as Error).message}`);
  }
  if (!isPlainObject(raw)) throw new KilamuError('CONFIG_INVALID', 'config.json must be an object');
  const merged = merge(structuredClone(DEFAULT_CONFIG) as unknown as Record<string, unknown>, raw, '');
  return validate(merged as unknown as KilamuConfig);
}

/** Set a dotted key (e.g. "execution.maxParallelAgents") with a JSON-parsed value. Atomic write. */
export function setConfigValue(paths: ProjectPaths, dotted: string, rawValue: string): KilamuConfig {
  const current: Record<string, unknown> = existsSync(paths.configFile)
    ? (JSON.parse(readFileSync(paths.configFile, 'utf8')) as Record<string, unknown>)
    : { version: 1 };
  let value: unknown;
  try {
    value = JSON.parse(rawValue);
  } catch {
    value = rawValue;
  }
  const keys = dotted.split('.');
  let node = current;
  for (const k of keys.slice(0, -1)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') throw new KilamuError('CONFIG_INVALID', 'Illegal key');
    if (!isPlainObject(node[k])) node[k] = {};
    node = node[k] as Record<string, unknown>;
  }
  const last = keys[keys.length - 1]!;
  if (last === '__proto__' || last === 'constructor' || last === 'prototype') throw new KilamuError('CONFIG_INVALID', 'Illegal key');
  node[last] = value;
  // Validate before persisting.
  const merged = validate(merge(structuredClone(DEFAULT_CONFIG) as unknown as Record<string, unknown>, current, '') as unknown as KilamuConfig);
  writeFileAtomic(paths.configFile, `${JSON.stringify(current, null, 2)}\n`, { refuseSymlinkTarget: true });
  return merged;
}
