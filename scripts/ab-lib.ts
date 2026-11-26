/**
 * Pure helpers for the A/B benchmark harness (scripts/ab-bench.ts).
 * Kept separate so they can be unit-tested without spending model usage.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

/**
 * Files of a fixture that git tracks or would track (untracked but not ignored).
 * Ignored local state (e.g. `.omc/`, `.kilamu/`, `node_modules/`) never leaks into a trial.
 * Returned paths are relative to `fixtureDir`.
 */
export function listFixtureFiles(repo: string, fixtureDir: string): string[] {
  const rel = relative(repo, fixtureDir);
  if (rel.startsWith('..')) throw new Error(`fixture ${fixtureDir} is outside the repository`);
  const r = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', rel], {
    cwd: repo,
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`git ls-files failed for ${rel}: ${r.stderr}`);
  const files = r.stdout.split('\0').filter(Boolean).map((p) => relative(rel, p)).sort();
  if (!files.length) throw new Error(`fixture ${rel} has no tracked files`);
  return files;
}

/** Copy the listed fixture files (relative paths) from `src` into `dest`. */
export function copyFiles(src: string, files: string[], dest: string): void {
  for (const f of files) {
    mkdirSync(dirname(join(dest, f)), { recursive: true });
    cpSync(join(src, f), join(dest, f));
  }
}

/** SHA-256 over every file below `dir` (recursive, path-sorted); detects edits, additions and deletions. */
export function hashTree(dir: string): string {
  const h = createHash('sha256');
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else h.update(relative(dir, p)).update('\0').update(readFileSync(p)).update('\0');
    }
  };
  walk(dir);
  return h.digest('hex');
}

/** Deterministic PRNG (mulberry32) so a run's arm order can be reproduced from its seed. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher–Yates shuffle returning a new array. */
export function shuffle<T>(xs: readonly T[], rand: () => number): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export interface Engagement {
  /** Agent/Task tool calls made by the main agent. */
  subagentCalls: number;
  /** Bash tool calls whose command invokes the `kilamu` CLI. */
  kilamuCliCalls: number;
  /** Kilamu skills invoked through the Skill tool. */
  kilamuSkills: string[];
}

export interface StreamSummary {
  /** The final `result` event (same shape as `--output-format json`), or null. */
  result: Record<string, unknown> | null;
  /** Plugin names reported by the session's `system/init` event, or null if absent. */
  plugins: string[] | null;
  /** Number of MCP servers reported by `system/init`, or null if absent. */
  mcpServers: number | null;
  engagement: Engagement;
  /** Lines that were not valid JSON (should be 0). */
  badLines: number;
}

/** `kilamu` in command position: at the start, or after `;`, `&`, `|`, `(` or a `$(`/backtick substitution. */
const KILAMU_CMD = /(^|[;&|(`]|\$\()\s*kilamu(\s|$)/;

/** Parse `claude -p --output-format stream-json --verbose` stdout. Unknown event shapes are ignored. */
export function parseStream(stdout: string): StreamSummary {
  const s: StreamSummary = {
    result: null, plugins: null, mcpServers: null, badLines: 0,
    engagement: { subagentCalls: 0, kilamuCliCalls: 0, kilamuSkills: [] },
  };
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(line) as Record<string, unknown>;
    } catch {
      s.badLines++;
      continue;
    }
    if (ev.type === 'result') s.result = ev;
    else if (ev.type === 'system' && ev.subtype === 'init') {
      if (Array.isArray(ev.plugins)) {
        s.plugins = ev.plugins.map((p) => (typeof p === 'string' ? p : String((p as { name?: unknown }).name ?? '?')));
      }
      if (Array.isArray(ev.mcp_servers)) s.mcpServers = ev.mcp_servers.length;
    } else if (ev.type === 'assistant' && ev.parent_tool_use_id == null) {
      const content = (ev.message as { content?: unknown } | undefined)?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content as Array<Record<string, unknown>>) {
        if (block.type !== 'tool_use') continue;
        const input = (block.input ?? {}) as Record<string, unknown>;
        if (block.name === 'Agent' || block.name === 'Task') s.engagement.subagentCalls++;
        else if (block.name === 'Bash' && typeof input.command === 'string' && KILAMU_CMD.test(input.command)) s.engagement.kilamuCliCalls++;
        else if (block.name === 'Skill' && typeof input.skill === 'string' && input.skill.startsWith('kilamu-code:')) {
          s.engagement.kilamuSkills.push(input.skill);
        }
      }
    }
  }
  return s;
}
