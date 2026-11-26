import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { App } from '../app.ts';
import { KilamuError } from '../core/errors.ts';
import { parseJsonStrict, projectPaths, readProjectFile, safeResolve, toRel } from '../core/paths.ts';
import { fenceUntrusted, oneLine } from '../core/redact.ts';
import { formatTokens } from '../core/tokens.ts';
import type { ArtifactRef, MemoryCategory, MemoryValidation, TaskClass } from '../core/types.ts';
import { compressAndStore, renderSummary } from '../context/compress.ts';
import { buildContextPack, renderContextPack } from '../context/pack.ts';
import { costReport, renderCostReport } from '../cost/report.ts';
import { Indexer } from '../knowledge/indexer.ts';
import type { ImpactReport } from '../knowledge/query.ts';
import { backupTo, currentVersion, integrityCheck } from '../persistence/db.ts';
import { SCHEMA_VERSION } from '../persistence/migrations.ts';
import { discoverMcp } from '../tools/mcp.ts';
import { recommendTools } from '../tools/select.ts';
import { detectChecks } from '../verification/detect.ts';
import { getRun } from '../verification/engine.ts';
import { TASK_CLASSES } from '../orchestrator/graph.ts';
import { flag, int, lineRange, list, parse, parseSub, pos, readStdin, req, str } from './args.ts';
import type { CommandResult } from './output.ts';

// ------------------------------------------------------------------ knowledge

export async function cmdIndex(app: App, argv: string[]): Promise<CommandResult> {
  const p = parse(argv, { rebuild: { type: 'boolean' }, path: { type: 'string', multiple: true } });
  const paths = list(p, 'path').map((x) => toRel(app.rt.paths.root, safeResolve(app.rt.paths.root, x)));
  const stats = await new Indexer(app.rt).index({ rebuild: flag(p, 'rebuild'), ...(paths.length ? { paths } : {}) });
  const langs = Object.entries(stats.byLanguage).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(' ');
  return {
    data: stats,
    text: `Indexed in ${stats.durationMs} ms — scanned ${stats.scanned}, indexed ${stats.indexed}, unchanged ${stats.unchanged}, removed ${stats.removed}, skipped ${stats.skipped}, errors ${stats.errors}\n${langs}`,
  };
}

async function ensureIndexed(app: App): Promise<void> {
  if (app.knowledge.stats().files === 0) await new Indexer(app.rt).index({});
}

export async function cmdSearch(app: App, argv: string[]): Promise<CommandResult> {
  const p = parse(argv, { limit: { type: 'string' } });
  await ensureIndexed(app);
  const hits = app.knowledge.search(p.positionals.join(' ') || pos(p, 0, 'query'), int(p, 'limit', 10, 1, 100));
  return { data: hits, text: hits.map((h) => `${oneLine(h.path)}:${h.lineStart}-${h.lineEnd}  ${oneLine(h.snippet.replace(/\s+/g, ' '), 160)}`).join('\n') || 'No matches.' };
}

export async function cmdSymbols(app: App, argv: string[]): Promise<CommandResult> {
  const p = parse(argv, { limit: { type: 'string' } });
  await ensureIndexed(app);
  const syms = app.knowledge.findSymbols(pos(p, 0, 'name'), int(p, 'limit', 20, 1, 200));
  return { data: syms, text: syms.map((s) => `${oneLine(s.path)}:${s.lineStart}  ${s.kind} ${oneLine(s.name, 120)}  ${oneLine(s.signature, 120)}`).join('\n') || 'No symbols found.' };
}

export async function cmdImpact(app: App, argv: string[]): Promise<CommandResult> {
  const p = parse(argv, { depth: { type: 'string' }, limit: { type: 'string' } });
  await ensureIndexed(app);
  const report = app.knowledge.impact(pos(p, 0, 'term'), { depth: int(p, 'depth', 3, 1, 6), limit: int(p, 'limit', 60, 1, 500) });
  return { data: report, text: renderImpact(report) };
}

function renderImpact(r: ImpactReport): string {
  const lines = [`Impact of "${r.term}" — seeds: ${r.seeds.slice(0, 8).join(', ') || 'none'}`];
  for (const l of r.layers) {
    if (!l.entries.length) continue;
    lines.push(`${l.layer}:`);
    for (const e of l.entries.slice(0, 15)) lines.push(`  ${oneLine(e.path)}:${e.line}  conf ${e.confidence.toFixed(2)}  via ${oneLine(e.via.slice(-2).join(' ← '), 200)}`);
  }
  if (r.truncated) lines.push(`(truncated: ${r.total} affected entries; raise --limit)`);
  lines.push('Links are heuristic (see confidence); confirm by reading the cited lines.');
  return lines.join('\n');
}

export function cmdCoverage(app: App, argv: string[]): CommandResult {
  parse(argv, {});
  const cov = app.knowledge.coverage();
  return { data: cov, text: cov.map((c) => `${c.language.padEnd(12)} ${String(c.files).padStart(6)} files  ${c.parser} v${c.parserVersion}  ${c.confidence}`).join('\n') || 'Index is empty. Run kilamu index.' };
}

export async function cmdContext(app: App, argv: string[]): Promise<CommandResult> {
  const p = parse(argv, { budget: { type: 'string' }, seed: { type: 'string', multiple: true }, task: { type: 'string' }, exec: { type: 'string' }, content: { type: 'boolean' }, save: { type: 'boolean' } });
  const query = p.positionals.join(' ');
  if (!query) throw new KilamuError('USAGE', 'usage: kilamu context "<question or task>" [--budget N] [--seed path] [--task id] [--content]');
  await ensureIndexed(app);
  const seeds = list(p, 'seed');
  const taskId = str(p, 'task');
  if (taskId) {
    const ex = app.executions.resolveExecution(str(p, 'exec'));
    const t = app.executions.getTask(ex.id, taskId);
    seeds.push(...t.files.filter((f) => !f.endsWith('/')), ...t.inputs.filter((i) => !i.includes(':')));
  }
  const budget = int(p, 'budget', app.rt.config.context.defaultBudgetTokens, 500, 200_000);
  const pack = buildContextPack({ root: app.rt.paths.root, kq: app.knowledge, memory: app.memory }, { query, budgetTokens: budget, seeds: [...new Set(seeds)], includeContent: flag(p, 'content') });
  let text = renderContextPack(pack);
  let savedAs: string | null = null;
  if (flag(p, 'save')) {
    savedAs = app.artifacts.put(text, { kind: 'context-pack', source: `context:${query.slice(0, 80)}`, ...(taskId ? { taskId } : {}) }).id;
    text += `\n(saved as artifact ${savedAs})`;
  }
  return { data: { ...pack, savedAs }, text };
}

export function cmdChecks(app: App, argv: string[]): CommandResult {
  parse(argv, {});
  const checks = detectChecks(app.rt.paths.root);
  return { data: checks, text: checks.map((c) => `${c.name.padEnd(9)} ${c.command}   (${c.source})`).join('\n') || 'No build/test/lint commands detected.' };
}

// ------------------------------------------------------------------ artifacts

export async function cmdCompress(app: App, argv: string[]): Promise<CommandResult> {
  const p = parse(argv, { source: { type: 'string' }, 'exit-code': { type: 'string' }, task: { type: 'string' } });
  const text = await readStdin();
  if (!text) throw new KilamuError('USAGE', 'pipe output into compress: <cmd> 2>&1 | kilamu compress --source "<cmd>"');
  const exitRaw = str(p, 'exit-code');
  const source = str(p, 'source') ?? 'stdin';
  const s = compressAndStore(app.artifacts, text, {
    source, command: source, kind: 'command-output',
    ...(exitRaw !== undefined ? { exitCode: Number(exitRaw) } : {}),
    ...(str(p, 'task') ? { taskId: str(p, 'task')! } : {}),
  });
  return { data: s, text: renderSummary(s) };
}

const KINDS: ArtifactRef['kind'][] = ['command-output', 'log', 'file-snapshot', 'report', 'handoff', 'context-pack', 'other'];

export async function cmdArtifact(app: App, argv: string[]): Promise<CommandResult> {
  const { sub, p } = parseSub(argv, { kind: { type: 'string' }, source: { type: 'string' }, lines: { type: 'string' }, task: { type: 'string' }, file: { type: 'string' }, limit: { type: 'string' } });
  switch (sub) {
    case 'put': {
      const kind = (str(p, 'kind') ?? 'other') as ArtifactRef['kind'];
      if (!KINDS.includes(kind)) throw new KilamuError('USAGE', `--kind must be one of ${KINDS.join(', ')}`);
      const file = str(p, 'file');
      const content = file ? readProjectFile(app.rt.paths.root, file) : await readStdin();
      if (!content) throw new KilamuError('USAGE', 'provide content on stdin or with --file');
      const ref = app.artifacts.put(content, { kind, source: str(p, 'source') ?? file ?? 'stdin', ...(str(p, 'task') ? { taskId: str(p, 'task')! } : {}) });
      return { data: ref, text: `${ref.id}  ${ref.lines} lines, ${ref.bytes} bytes` };
    }
    case 'show': {
      const r = lineRange(str(p, 'lines'));
      const slice = app.artifacts.read(pos(p, 0, 'artifact-id'), r.start, r.end);
      return { data: slice, text: `# ${slice.ref.id} lines ${slice.lineStart}-${slice.lineEnd} of ${slice.totalLines} (${oneLine(slice.ref.source, 120)})\n${fenceUntrusted(`artifact ${slice.ref.id}`, slice.content)}` };
    }
    case 'list': {
      const rows = app.artifacts.list({ limit: int(p, 'limit', 20, 1, 500), ...(str(p, 'kind') ? { kind: str(p, 'kind') as ArtifactRef['kind'] } : {}) });
      return { data: rows, text: rows.map((a) => `${a.id} ${a.kind.padEnd(14)} ${String(a.lines).padStart(6)} lines  ${a.createdAt}  ${oneLine(a.source, 60)}`).join('\n') || 'No artifacts.' };
    }
    case 'rm': {
      const ok = app.artifacts.remove(pos(p, 0, 'artifact-id'));
      return { data: { removed: ok }, text: ok ? 'removed' : 'not found' };
    }
    default:
      throw new KilamuError('USAGE', 'usage: kilamu artifact put|show|list|rm');
  }
}

// --------------------------------------------------------------------- memory

const CATS: MemoryCategory[] = ['project', 'execution', 'pattern', 'technical'];

/** Memory evidence must point at something real: a VERIFIED verification run or a stored artifact. */
function resolveEvidence(app: App, ids: string[]): void {
  for (const id of ids) {
    if (id.startsWith('vr_')) {
      const run = getRun(app.rt.db, id);
      if (!run) throw new KilamuError('EVIDENCE_INVALID', `verification run ${id} not found`);
      if (run.verdict !== 'VERIFIED') throw new KilamuError('EVIDENCE_INVALID', `verification run ${id} is ${run.verdict}, not VERIFIED`);
    } else if (/^a_[0-9a-f]{16}$/.test(id)) {
      app.artifacts.read(id, 1, 1);
    } else {
      throw new KilamuError('EVIDENCE_INVALID', `evidence ${JSON.stringify(id.slice(0, 40))} must be a verification run id (vr_…) or an artifact id (a_…)`);
    }
  }
}

export function cmdMemory(app: App, argv: string[]): CommandResult {
  const { sub, p } = parseSub(argv, {
    category: { type: 'string' }, scope: { type: 'string' }, description: { type: 'string' }, problem: { type: 'string' }, solution: { type: 'string' },
    source: { type: 'string', multiple: true }, evidence: { type: 'string', multiple: true }, confidence: { type: 'string' }, invalidate: { type: 'string', multiple: true },
    reason: { type: 'string' }, validation: { type: 'string' }, limit: { type: 'string' }, dir: { type: 'string' },
  });
  const m = app.memory;
  const line = (i: { id: string; category: string; validation: string; confidence: number; description: string }) => `${i.id} ${i.category.padEnd(9)} ${i.validation.padEnd(11)} ${i.confidence.toFixed(2)}  ${i.description}`;
  switch (sub) {
    case 'add': {
      const category = req(p, 'category', CATS.join('|')) as MemoryCategory;
      if (!CATS.includes(category)) throw new KilamuError('USAGE', `--category must be one of ${CATS.join(', ')}`);
      const item = m.add({
        category, scope: str(p, 'scope') ?? 'global',
        description: req(p, 'description', 'one line'), problem: req(p, 'problem', 'the problem or question'), solution: req(p, 'solution', 'the solution or observation'),
        evidence: list(p, 'evidence'), sources: list(p, 'source').map((s) => {
          const [path, range] = s.split(':');
          const r = lineRange(range);
          return { path: path!, ...(r.start ? { lineStart: r.start, lineEnd: r.end } : {}) };
        }),
        ...(str(p, 'confidence') ? { confidence: Number(str(p, 'confidence')) } : {}),
        invalidationConditions: list(p, 'invalidate'),
      });
      return { data: item, text: line(item) };
    }
    case 'list': {
      const rows = m.list({ limit: int(p, 'limit', 50, 1, 1000), ...(str(p, 'category') ? { category: str(p, 'category') as MemoryCategory } : {}), ...(str(p, 'validation') ? { validation: str(p, 'validation') as MemoryValidation } : {}) });
      return { data: rows, text: rows.map(line).join('\n') || 'No memory items.' };
    }
    case 'search': {
      const rows = m.search(p.positionals.join(' ') || pos(p, 0, 'text'), int(p, 'limit', 10, 1, 100));
      return { data: rows, text: rows.map((i) => `${line(i)}\n    problem: ${i.problem.slice(0, 160)}\n    solution: ${i.solution.slice(0, 200)}`).join('\n') || 'No matches.' };
    }
    case 'show': {
      const item = m.get(pos(p, 0, 'memory-id'));
      if (!item) throw new KilamuError('NOT_FOUND', 'memory item not found');
      return { data: item, text: fenceUntrusted(`memory ${item.id}`, JSON.stringify(item, null, 2)) };
    }
    case 'validate': {
      const ev = list(p, 'evidence');
      if (!ev.some((e) => e.startsWith('vr_'))) throw new KilamuError('USAGE', '--evidence must include a VERIFIED verification run id (vr_…); artifact ids (a_…) may be added as supporting evidence');
      resolveEvidence(app, ev);
      const item = m.validate(pos(p, 0, 'memory-id'), ev);
      return { data: item, text: line(item) };
    }
    case 'invalidate': {
      const item = m.invalidate(pos(p, 0, 'memory-id'), req(p, 'reason', 'why it is wrong or obsolete'));
      return { data: item, text: line(item) };
    }
    case 'promote': {
      const item = m.promote(pos(p, 0, 'memory-id'));
      return { data: item, text: line(item) };
    }
    case 'check': {
      const r = m.checkStaleness();
      return { data: r, text: `checked ${r.checked}; stale: ${r.stale.join(', ') || 'none'}` };
    }
    case 'export': {
      const files = m.exportMarkdown(str(p, 'dir') ? safeResolve(app.rt.paths.root, str(p, 'dir')!) : undefined);
      return { data: files, text: files.join('\n') };
    }
    default:
      throw new KilamuError('USAGE', 'usage: kilamu memory add|list|search|show|validate|invalidate|promote|check|export');
  }
}

// ----------------------------------------------------------------- cost/tools

export function cmdUsage(app: App, argv: string[]): CommandResult {
  parse(argv, {});
  const sid = app.sessionId ?? app.lastSeenSessionId;
  const latest = sid ? app.usage.latest(sid) : null;
  if (!latest) return { data: { label: 'UNAVAILABLE' }, text: 'Usage UNAVAILABLE: no statusline samples recorded. Install the HUD (kilamu statusline install) to measure session usage.' };
  return {
    data: latest,
    text: `session ${sid} (MEASURED via statusline) — input ${formatTokens(latest.inputTokens)}, output ${formatTokens(latest.outputTokens)}, cache read ${formatTokens(latest.cacheReadTokens)}, context ${latest.contextUsedPct ?? 'n/a'}%, cost ${latest.costUsd !== null ? `$${latest.costUsd.toFixed(4)} (list price, client-side)` : 'n/a'}`,
  };
}

export function cmdCost(app: App, argv: string[]): CommandResult {
  const p = parse(argv, {});
  const ex = app.executions.resolveExecution(p.positionals[0]);
  const s = app.executions.summary(ex.id);
  const r = costReport({ usage: app.usage, sessionId: ex.sessionId ?? app.lastSeenSessionId, executionStartedAt: ex.createdAt, verifiedTasks: s.verified, totalTasks: s.total });
  return { data: r, text: renderCostReport(r) };
}

export function cmdTools(app: App, argv: string[]): CommandResult {
  const p = parse(argv, { class: { type: 'string' } });
  const mcp = discoverMcp(app.rt.paths.root);
  const cls = (str(p, 'class') ?? 'implementation') as TaskClass;
  if (!TASK_CLASSES.includes(cls)) throw new KilamuError('USAGE', `--class must be one of ${TASK_CLASSES.join(', ')}`);
  const rec = recommendTools(cls, mcp.servers);
  return {
    data: { mcp, recommendation: rec },
    text: [
      `MCP servers (project .mcp.json): ${mcp.servers.map((s) => `${s.name}[${s.transport}]`).join(', ') || 'none'}`,
      mcp.note,
      `For ${cls}: local → ${rec.local.join(', ')}`,
      `            mcp → ${rec.mcp.map((m) => `${m.name} (${m.reason})`).join(', ') || 'none relevant'}`,
      ...rec.rationale.map((r) => `  - ${r}`),
    ].join('\n'),
  };
}

// ------------------------------------------------------------ config/storage

export function cmdExport(app: App, argv: string[]): CommandResult {
  const p = parse(argv, {});
  const dir = resolve(pos(p, 0, 'target-dir'));
  if (existsSync(dir)) throw new KilamuError('EXISTS', `Target exists: ${dir} (choose a new directory)`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  backupTo(app.rt.db, join(dir, 'execution.db'));
  writeFileSync(join(dir, 'memory.json'), `${JSON.stringify(app.memory.exportJson(), null, 2)}\n`, { mode: 0o600 });
  if (existsSync(app.rt.paths.configFile)) copyFileSync(app.rt.paths.configFile, join(dir, 'config.json'));
  return { data: { dir }, text: `Exported database snapshot, memory and config to ${dir}` };
}

export function cmdImport(app: App, argv: string[]): CommandResult {
  const p = parse(argv, {});
  const file = resolve(pos(p, 0, 'memory.json'));
  if (!/\.json$/i.test(file) || !existsSync(file)) throw new KilamuError('USAGE', 'expected an existing memory.json produced by `kilamu export`');
  const items = parseJsonStrict(readFileSync(file, 'utf8'), 'memory import file');
  if (!Array.isArray(items)) throw new KilamuError('USAGE', 'expected a JSON array exported by `kilamu export`');
  const r = app.memory.importJson(items);
  return { data: r, text: `Imported memory: ${JSON.stringify(r)}` };
}

export function cmdCleanup(app: App, argv: string[]): CommandResult {
  const p = parse(argv, { 'artifacts-older-than': { type: 'string' }, 'usage-rows': { type: 'string' }, 'dry-run': { type: 'boolean' } });
  const days = int(p, 'artifacts-older-than', 30, 1, 3650);
  const rows = int(p, 'usage-rows', 2000, 10, 1_000_000);
  if (flag(p, 'dry-run')) {
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    const n = app.artifacts.list({ limit: 100_000 }).filter((a) => a.createdAt < cutoff).length;
    return { data: { artifacts: n }, text: `would remove ${n} artifact(s) older than ${days} days and trim usage samples to ${rows}/session` };
  }
  const removed = app.artifacts.prune({ olderThanDays: days });
  const trimmed = app.usage.prune(rows);
  return { data: { artifacts: removed, usageRows: trimmed }, text: `removed ${removed} artifact(s); trimmed ${trimmed} usage row(s)` };
}

/** Diagnostics that need the database (doctor adds these when .kilamu exists). */
export function storageDiagnostics(app: App): Array<{ name: string; status: 'ok' | 'warn' | 'fail'; detail: string }> {
  const v = currentVersion(app.rt.db);
  const files = { n: app.knowledge.stats().files };
  const integrity = integrityCheck(app.rt.db);
  const ex = app.executions.activeExecution();
  const out: Array<{ name: string; status: 'ok' | 'warn' | 'fail'; detail: string }> = [
    { name: 'storage', status: 'ok', detail: `${projectPaths(app.rt.paths.root).dataDir}` },
    { name: 'schema', status: v === SCHEMA_VERSION ? 'ok' : 'fail', detail: `v${v} (expected v${SCHEMA_VERSION})` },
    { name: 'integrity', status: integrity === 'ok' ? 'ok' : 'fail', detail: integrity === 'ok' ? 'quick_check ok' : `quick_check: ${integrity}` },
    { name: 'index', status: files.n ? 'ok' : 'warn', detail: files.n ? `${files.n} files indexed` : 'empty — run kilamu index' },
    { name: 'execution', status: 'ok', detail: ex ? `ACTIVE ${ex.id}` : 'none active' },
  ];
  if (app.rt.recoveredFrom) out.push({ name: 'database', status: 'warn', detail: `corrupt database quarantined at ${app.rt.recoveredFrom}` });
  return out;
}
