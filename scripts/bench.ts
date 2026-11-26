/**
 * Kilamu Code local benchmarks (deterministic, no model calls).
 *
 * Measures what can be measured honestly without spending model tokens:
 *  1. Indexing: cold vs incremental wall time on a target repository.
 *  2. Context selection: ESTIMATED tokens of a budgeted context pack vs the
 *     naive baseline of reading every file the pack draws from in full.
 *  3. Log compression: ESTIMATED tokens of compressed summaries vs raw logs.
 *
 * Token figures are chars/4 ESTIMATES. Wall times are MEASURED on this
 * machine. This is NOT the A/B model benchmark (standard Claude Code vs Claude
 * Code + Kilamu) — that requires headless model runs and is documented in
 * docs/COST_ENGINE.md; run it only with explicit consent because it spends
 * real usage.
 *
 * Usage: node --disable-warning=ExperimentalWarning scripts/bench.ts [repo] [--runs N]
 */
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { estimateTokens } from '../src/core/tokens.ts';
import { compressOutput, renderSummary } from '../src/context/compress.ts';
import { buildContextPack } from '../src/context/pack.ts';
import { Indexer } from '../src/knowledge/indexer.ts';
import { KnowledgeGraph } from '../src/knowledge/query.ts';
import { openRuntime, type Runtime } from '../src/runtime.ts';

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function spread(xs: number[]): string {
  return `min ${Math.min(...xs).toFixed(0)} / max ${Math.max(...xs).toFixed(0)}`;
}

const args = process.argv.slice(2);
const runsIdx = args.indexOf('--runs');
const runs = runsIdx >= 0 ? Number(args[runsIdx + 1]) : 5;
const repo = resolve(args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--runs') ?? '.');

/**
 * Run `fn` against an isolated runtime: temp data dir AND temp user-config dir
 * (so benchmarks never register trust entries in the user's real config).
 * Always closes the runtime, restores the environment and removes temp dirs.
 */
async function withIsolatedRuntime<T>(fn: (rt: Runtime) => Promise<T>): Promise<T> {
  const saved = { data: process.env.KILAMU_DATA_DIR, cfg: process.env.KILAMU_CONFIG_HOME };
  const dataDir = mkdtempSync(join(tmpdir(), 'kilamu-bench-'));
  const cfgDir = mkdtempSync(join(tmpdir(), 'kilamu-bench-cfg-'));
  process.env.KILAMU_DATA_DIR = dataDir;
  process.env.KILAMU_CONFIG_HOME = cfgDir;
  let rt: Runtime | null = null;
  try {
    rt = openRuntime({ root: repo, create: true });
    return await fn(rt);
  } finally {
    rt?.close();
    for (const [key, value] of [['KILAMU_DATA_DIR', saved.data], ['KILAMU_CONFIG_HOME', saved.cfg]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(cfgDir, { recursive: true, force: true });
  }
}

async function benchIndexing(): Promise<void> {
  const cold: number[] = [];
  const warm: number[] = [];
  let files = 0;
  for (let i = 0; i < runs; i++) {
    await withIsolatedRuntime(async (rt) => {
      const idx = new Indexer(rt);
      const a = await idx.index({});
      const b = await idx.index({});
      cold.push(a.durationMs);
      warm.push(b.durationMs);
      files = a.indexed;
    });
  }
  console.log(`\n## Indexing (${repo}, ${files} files, ${runs} runs, MEASURED wall time)`);
  console.log(`cold        median ${median(cold).toFixed(0)} ms (${spread(cold)})`);
  console.log(`incremental median ${median(warm).toFixed(0)} ms (${spread(warm)})`);
}

async function benchContext(queries: string[]): Promise<void> {
  await withIsolatedRuntime(async (rt) => {
    await new Indexer(rt).index({});
    const kg = new KnowledgeGraph(rt.db);
    console.log('\n## Context selection (ESTIMATED tokens, chars/4)');
    console.log('| query | pack tokens | naive full-file tokens | files | ratio |');
    console.log('|---|---|---|---|---|');
    const ratios: number[] = [];
    for (const q of queries) {
      const pack = buildContextPack({ root: repo, kq: kg }, { query: q, budgetTokens: 6000, includeContent: true });
      const files = [...new Set(pack.items.filter((i) => i.kind !== 'memory').map((i) => i.ref.split('#')[0]!))];
      let naive = 0;
      for (const f of files) {
        try {
          const abs = join(repo, f);
          if (statSync(abs).isFile()) naive += estimateTokens(readFileSync(abs, 'utf8'));
        } catch {
          // file vanished between index and read; it contributes no tokens
        }
      }
      const used = pack.usedTokens.value ?? 0;
      const ratio = naive ? used / naive : 1;
      ratios.push(ratio);
      console.log(`| ${q} | ${used} | ${naive} | ${files.length} | ${ratio.toFixed(2)} |`);
    }
    console.log(`median pack/naive ratio: ${median(ratios).toFixed(2)} (lower = less context; quality not measured here)`);
  });
}

function benchCompression(): void {
  const cases: Array<{ name: string; text: string }> = [];
  const passing = Array.from({ length: 3000 }, (_, i) => ` ✓ tests/unit/mod${i % 40}.test.ts > case ${i} 3ms`);
  const vitest = [...passing.slice(0, 1500), ' FAIL  tests/unit/auth.test.ts > login > rejects bad password', 'AssertionError: expected 200 to be 401', ' ❯ tests/unit/auth.test.ts:42:18', ...passing.slice(1500), ' Test Files  1 failed | 39 passed (40)', '      Tests  1 failed | 2999 passed (3000)'];
  cases.push({ name: 'vitest 3k tests, 1 failure', text: vitest.join('\n') });
  const tsc = Array.from({ length: 400 }, (_, i) => `src/m${i % 20}.ts(${i + 1},5): error TS2322: Type 'string' is not assignable to type 'number'.`);
  cases.push({ name: 'tsc 400 errors (repetitive)', text: tsc.join('\n') });
  const build = Array.from({ length: 8000 }, (_, i) => `[build] compiling module ${i} ... ok`);
  build.splice(6000, 0, 'Error: Cannot find module "left-pad" imported from src/util.js');
  cases.push({ name: 'build log 8k lines, 1 error', text: build.join('\n') });
  console.log('\n## Log compression (ESTIMATED tokens)');
  console.log('| case | raw | summary | ratio | failure found | status (no exit code given) |');
  console.log('|---|---|---|---|---|---|');
  for (const c of cases) {
    const r = compressOutput(c.text, { source: c.name });
    const rendered = renderSummary({ ...r, artifactId: 'a_0000000000000000', retrieval: 'kilamu artifact show a_0000000000000000' });
    const raw = estimateTokens(c.text);
    const sum = estimateTokens(rendered);
    const found = r.findings.some((f) => /error|fail|assert|\bTS\d{4}\b/i.test(f.text));
    console.log(`| ${c.name} | ${raw} | ${sum} | ${(sum / raw).toFixed(3)} | ${found ? 'yes' : 'NO'} | ${r.status} |`);
  }
}

async function main(): Promise<void> {
  console.log(`# Kilamu Code local benchmarks — ${new Date().toISOString()}`);
  console.log(`node ${process.versions.node}, ${process.platform}`);
  await benchIndexing();
  await benchContext(['verification engine allowlist', 'task state machine transitions', 'how is secret redaction done', 'impact analysis layers', 'statusline usage parsing']);
  benchCompression();
}

await main();
