/**
 * A/B benchmark: plain Claude Code vs Claude Code + Kilamu Code.
 *
 * SPENDS REAL MODEL USAGE — run only with the founder's consent.
 *
 * Protocol (docs/COST_ENGINE.md):
 *  - Same fixture snapshot, same prompt, same model, same allowed tools, same
 *    acceptance check for both arms; arm B adds `--plugin-dir <kilamu>` and a
 *    `kilamu init` in the trial project (the normal install experience).
 *    The plugin dir is a temp copy of the plugin's own files only, so arm B
 *    cannot discover the repository (and its reference solutions) from it.
 *  - Each trial runs in a fresh temp copy (git-initialized) of the fixture's
 *    tracked files only — ignored local state never leaks into a trial.
 *  - Arm order is shuffled per (run, task) from a recorded seed (`--seed`).
 *  - `--isolate` passes `--setting-sources project,local --strict-mcp-config`
 *    to BOTH arms, intended to keep user-level plugins, hooks and MCP servers
 *    out (unverified; `--bare` is not used because it would also disable
 *    Kilamu's own plugin hooks). With `--isolate`, every (run, task) pair is
 *    checked: arm B must load exactly arm A's plugins plus Kilamu, or the run
 *    aborts before spending more.
 *  - Acceptance: `node --test` exits 0 AND the trial's test/ tree is
 *    byte-identical to its state before the agent ran AND the session never
 *    mentioned the reference-solution directory.
 *  - Metrics come from `claude -p --output-format stream-json --verbose`
 *    (MEASURED by Claude Code): total_cost_usd (client-side list price), usage
 *    tokens, turns, duration; plus the plugins/MCP servers the session loaded
 *    and Kilamu engagement (kilamu CLI calls, Kilamu skills, subagent calls).
 *  - Report median and IQR per task × arm, completion rate and cost per
 *    verified task. Small tasks are included on purpose: Kilamu's always-on
 *    overhead is expected to make it worse there, and the report must show it.
 *
 * Usage:
 *   node --disable-warning=ExperimentalWarning scripts/ab-bench.ts [--runs 3] [--model sonnet]
 *        [--tasks a,b] [--max-turns 40] [--timeout-sec 900] [--seed N] [--isolate] [--dry-run] [--out docs/benchmarks]
 *   --dry-run sets up every trial and runs the acceptance check WITHOUT calling a model.
 */
import { spawnSync } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { checkArmPlugins, copyFiles, engaged, hashTree, listGitVisible, parseStream, prng, shuffle, totalTokens } from './ab-lib.ts';

const REPO = resolve(import.meta.dirname, '..');
const FIXTURES = join(REPO, 'tests', 'fixtures', 'ab');
/** What a Kilamu plugin install contains; everything else in the repository stays out of arm B's reach. */
const PLUGIN_PARTS = ['.claude-plugin', 'agents', 'bin', 'hooks', 'skills', 'src', 'package.json'];
const SOLUTIONS_MARKER = 'ab-solutions';

/** Copy the plugin's git-visible files into a fresh temp dir. */
function stagePlugin(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kilamu-ab-plugin-'));
  const all = listGitVisible(REPO, REPO);
  const files = all.filter((f) => PLUGIN_PARTS.some((part) => f === part || f.startsWith(`${part}/`)));
  copyFiles(REPO, files, dir);
  return dir;
}

interface Options {
  runs: number; model: string; tasks: string[]; maxTurns: number; timeoutSec: number; seed: number; isolate: boolean; dryRun: boolean; out: string;
}

function parseOptions(argv: string[]): Options {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const all = readdirSync(FIXTURES, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name).sort();
  const tasks = get('tasks')?.split(',') ?? all;
  for (const t of tasks) if (!all.includes(t)) throw new Error(`unknown task ${t} (have: ${all.join(', ')})`);
  const int = (name: string, def: number, min: number, max: number) => {
    const n = Number(get(name) ?? def);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`--${name} must be an integer in ${min}..${max}`);
    return n;
  };
  return {
    runs: int('runs', 3, 1, 20),
    model: get('model') ?? 'sonnet',
    tasks,
    maxTurns: int('max-turns', 40, 5, 200),
    timeoutSec: int('timeout-sec', 900, 60, 3600),
    seed: int('seed', randomInt(1, 2 ** 31 - 1), 1, 2 ** 31 - 1),
    isolate: argv.includes('--isolate'),
    dryRun: argv.includes('--dry-run'),
    out: resolve(REPO, get('out') ?? 'docs/benchmarks'),
  };
}

type Arm = 'A-plain' | 'B-kilamu';

interface Trial {
  task: string; arm: Arm; run: number; verified: boolean; testsTampered: boolean; isError: boolean;
  costUsd: number | null; inputTokens: number | null; outputTokens: number | null; cacheReadTokens: number | null;
  cacheWriteTokens: number | null; totalTokens: number | null; turns: number | null; durationMs: number | null;
  tokenSource: 'modelUsage' | 'usage' | null; subagents: number | null; permissionDenials: number | null;
  subagentCalls: number | null; kilamuAgentCalls: number | null; kilamuCliCalls: number | null; kilamuSkills: string[];
  plugins: string[] | null; mcpServers: number | null; solutionLeak: boolean;
  note: string;
}

function sh(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs = 120_000) {
  return spawnSync(cmd, args, { cwd, env, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
}

function setupTrial(task: string, arm: Arm, plugin: string, env: NodeJS.ProcessEnv): { dir: string; testHash: string } {
  const dir = mkdtempSync(join(tmpdir(), `kilamu-ab-${task}-`));
  const src = join(FIXTURES, task);
  copyFiles(src, listGitVisible(REPO, src), dir);
  const git = (...a: string[]) => sh('git', ['-c', 'user.email=bench@kilamu.local', '-c', 'user.name=bench', ...a], dir, env);
  git('init', '-q');
  git('add', '-A');
  git('commit', '-qm', 'fixture snapshot');
  // Baseline taken from the trial copy itself, so files ignored at the source (e.g. .DS_Store) cannot flag tampering.
  const testHash = hashTree(join(dir, 'test'));
  if (arm === 'B-kilamu') {
    const r = sh(join(plugin, 'bin', 'kilamu'), ['init'], dir, { ...env, KILAMU_PROJECT_DIR: dir });
    if (r.status !== 0) throw new Error(`kilamu init failed in ${dir}: ${r.stderr}`);
  }
  return { dir, testHash };
}

function prompt(task: string): string {
  const spec = readFileSync(join(FIXTURES, task, 'TASK.md'), 'utf8').trim();
  return `${spec}\n\nWhen you are done, \`npm test\` must pass. Do not modify anything under test/.`;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

type Stream = ReturnType<typeof parseStream>;

function runClaude(dir: string, task: string, arm: Arm, plugin: string, o: Options, env: NodeJS.ProcessEnv): { stream: Stream | null; leak: boolean; note: string } {
  const tools = ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Agent', 'Skill', 'TodoWrite', 'Bash(node:*)', 'Bash(npm:*)', 'Bash(git:*)', 'Bash(ls:*)', 'Bash(cat:*)'];
  const args = ['-p', '--model', o.model, '--output-format', 'stream-json', '--verbose', '--max-turns', String(o.maxTurns)];
  if (o.isolate) args.push('--setting-sources', 'project,local', '--strict-mcp-config');
  if (arm === 'B-kilamu') {
    args.push('--plugin-dir', plugin);
    tools.push('Bash(kilamu:*)');
  }
  args.push('--allowedTools', ...tools, '--', prompt(task));
  const r = sh('claude', args, dir, env, o.timeoutSec * 1000);
  // Parse whatever was streamed even on timeout/spawn errors, so partial sessions keep their evidence.
  const stdout = typeof r.stdout === 'string' ? r.stdout : '';
  const stream = parseStream(stdout);
  const leak = stdout.includes(SOLUTIONS_MARKER);
  const notes = [
    r.error ? `spawn error: ${r.error.message}` : '',
    r.status === 0 || r.error ? '' : `exit ${r.status}`,
    stream.result ? '' : `no result event: ${String(r.stderr ?? '').slice(0, 200)}`,
    stream.badLines ? `${stream.badLines} unparseable line(s)` : '',
    leak ? 'session referenced the reference solutions: trial invalid' : '',
  ];
  return { stream, leak, note: notes.filter(Boolean).join('; ') };
}

function acceptance(dir: string, testHash: string, env: NodeJS.ProcessEnv): { verified: boolean; tampered: boolean } {
  const tampered = hashTree(join(dir, 'test')) !== testHash;
  const r = sh('node', ['--test'], dir, env, 300_000);
  return { verified: r.status === 0 && !tampered, tampered };
}

function stats(xs: number[]): { median: number | null; q1: number | null; q3: number | null } {
  if (!xs.length) return { median: null, q1: null, q3: null };
  const s = [...xs].sort((a, b) => a - b);
  const at = (p: number) => {
    const i = (s.length - 1) * p;
    const lo = Math.floor(i);
    const hi = Math.ceil(i);
    return s[lo]! + (s[hi]! - s[lo]!) * (i - lo);
  };
  return { median: at(0.5), q1: at(0.25), q3: at(0.75) };
}

function fmt(v: number | null, digits = 0): string {
  return v === null ? 'n/a' : v.toFixed(digits);
}

function report(trials: Trial[], o: Options, startedAt: string): string {
  const lines = [
    `# A/B benchmark: plain Claude Code vs Claude Code + Kilamu Code`,
    '',
    `Run ${startedAt} · model \`${o.model}\` · ${o.runs} run(s) per task per arm · max ${o.maxTurns} turns · seed ${o.seed} · ${o.isolate ? 'isolated user config' : 'user config loaded'} · Node ${process.versions.node}`,
    '',
    'Metrics are MEASURED by Claude Code (`claude -p --output-format stream-json --verbose`). `cost` is the client-side list-price figure, not a bill.',
    '"verified" = `node --test` passes AND the fixture tests are byte-identical. Medians with [Q1–Q3].',
    '',
    '| task | arm | verified | median cost USD | median total tokens | median output tokens | median turns | median duration s | cost per verified task | Kilamu engaged | subagent calls |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const task of o.tasks) {
    for (const arm of ['A-plain', 'B-kilamu'] as Arm[]) {
      const ts = trials.filter((t) => t.task === task && t.arm === arm);
      const ok = ts.filter((t) => t.verified).length;
      const pick = (f: (t: Trial) => number | null) => stats(ts.map(f).filter((x): x is number => x !== null));
      const cost = pick((t) => t.costUsd);
      const tok = pick((t) => t.totalTokens);
      const out = pick((t) => t.outputTokens);
      const turns = pick((t) => t.turns);
      const dur = pick((t) => (t.durationMs === null ? null : t.durationMs / 1000));
      const totalCost = ts.reduce((s, t) => s + (t.costUsd ?? 0), 0);
      const missingCost = ts.filter((t) => t.costUsd === null).length;
      const perVerified = missingCost ? `n/a (${missingCost} without cost)` : ok ? (totalCost / ok).toFixed(4) : 'n/a (none verified)';
      const measured = ts.filter((t) => t.kilamuCliCalls !== null);
      const engagedCell = measured.length
        ? `${measured.filter((t) => engaged({ subagentCalls: 0, kilamuAgentCalls: t.kilamuAgentCalls ?? 0, kilamuCliCalls: t.kilamuCliCalls ?? 0, kilamuSkills: t.kilamuSkills })).length}/${measured.length}`
        : 'n/a';
      const subCalls = measured.length ? String(measured.reduce((s, t) => s + (t.subagentCalls ?? 0), 0)) : 'n/a';
      lines.push(`| ${task} | ${arm} | ${ok}/${ts.length} | ${fmt(cost.median, 4)} [${fmt(cost.q1, 4)}–${fmt(cost.q3, 4)}] | ${fmt(tok.median)} [${fmt(tok.q1)}–${fmt(tok.q3)}] | ${fmt(out.median)} | ${fmt(turns.median, 1)} | ${fmt(dur.median, 1)} | ${perVerified} | ${engagedCell} | ${subCalls} |`);
    }
  }
  const byArm = (arm: Arm) => {
    const ts = trials.filter((t) => t.arm === arm);
    const ok = ts.filter((t) => t.verified).length;
    const cost = ts.reduce((s, t) => s + (t.costUsd ?? 0), 0);
    const missing = ts.filter((t) => t.costUsd === null).length;
    return { n: ts.length, ok, cost, missing, perVerified: ok && !missing ? cost / ok : null };
  };
  const a = byArm('A-plain');
  const b = byArm('B-kilamu');
  lines.push(
    '',
    '## Totals',
    ...[['A-plain', a], ['B-kilamu', b]].map(([name, x]) => {
      const v = x as ReturnType<typeof byArm>;
      const missing = v.missing ? ` (${v.missing} trial(s) without a cost figure: totals are lower bounds)` : '';
      return `- ${name}: ${v.ok}/${v.n} verified, total cost ${v.cost.toFixed(4)} USD${missing}, cost per verified task ${v.perVerified === null ? 'n/a' : v.perVerified.toFixed(4)} USD`;
    }),
    '',
    '## Caveats',
    `- Small sample (${o.runs} run(s) per cell): treat differences as indicative, not significant.`,
    o.isolate
      ? '- `--isolate`: both arms load only project and local settings (no user settings, so no user-enabled plugins or user hooks) and no MCP servers. User memory (global CLAUDE.md) may still load in both arms. The per-trial `plugins` field records what each session actually loaded.'
      : '- Both arms load the same user-level Claude Code configuration (global CLAUDE.md, other enabled plugins); only `--plugin-dir kilamu` differs.',
    '- "Kilamu engaged" = the main agent called the `kilamu` CLI, a Kilamu skill or a Kilamu agent at least once; "subagent calls" counts all Agent/Task tool calls by the main agent.',
    `- Token totals come from \`modelUsage\` (all models, including subagents) when present, else from \`usage\` (main loop only): ${[...new Set(trials.map((t) => t.tokenSource ?? 'none'))].join(', ')}.`,
    '- Arm B uses the plugin as installed (natural-language prompt, no explicit skill invocation): whether Kilamu engages is part of what is measured.',
  );
  const notes = trials.filter((t) => t.note).map((t) => `- ${t.task}/${t.arm}#${t.run}: ${t.note}`);
  if (notes.length) lines.push('', '## Trial notes', ...notes);
  return lines.join('\n');
}

async function main(): Promise<void> {
  const o = parseOptions(process.argv.slice(2));
  const startedAt = new Date().toISOString();
  // Isolated Kilamu user config (trust records) for arm B trial projects.
  const cfg = mkdtempSync(join(tmpdir(), 'kilamu-ab-cfg-'));
  const env: NodeJS.ProcessEnv = { ...process.env, KILAMU_CONFIG_HOME: cfg, NO_COLOR: '1' };
  delete env.KILAMU_DATA_DIR;
  delete env.KILAMU_PROJECT_DIR;
  const trials: Trial[] = [];
  const rand = prng(o.seed);
  const plugin = stagePlugin();
  let aborted: string | null = null;
  try {
    for (let run = 1; run <= o.runs; run++) {
      for (const task of o.tasks) {
        // Shuffled per (run, task) from the recorded seed to spread order, time-of-day and cache effects.
        const arms = shuffle<Arm>(['A-plain', 'B-kilamu'], rand);
        for (const arm of arms) {
          const { dir, testHash } = setupTrial(task, arm, plugin, env);
          try {
            const { stream, leak, note } = o.dryRun ? { stream: null, leak: false, note: 'dry run: no model call' } : runClaude(dir, task, arm, plugin, o, env);
            const json = stream?.result ?? null;
            const acc = acceptance(dir, testHash, env);
            const tok = totalTokens(json);
            const u = (json?.usage ?? {}) as Record<string, unknown>;
            const inT = num(u.input_tokens);
            const outT = num(u.output_tokens);
            const cr = num(u.cache_read_input_tokens);
            const cw = num(u.cache_creation_input_tokens);
            const sub = (json?.subagent_stats ?? {}) as Record<string, unknown>;
            const t: Trial = {
              task, arm, run, verified: acc.verified && !leak, testsTampered: acc.tampered, isError: json?.is_error === true,
              costUsd: num(json?.total_cost_usd), inputTokens: inT, outputTokens: outT, cacheReadTokens: cr, cacheWriteTokens: cw,
              totalTokens: tok.tokens, tokenSource: tok.source, turns: num(json?.num_turns), durationMs: num(json?.duration_ms),
              subagents: num(sub.spawned), permissionDenials: Array.isArray(json?.permission_denials) ? (json!.permission_denials as unknown[]).length : null,
              subagentCalls: stream ? stream.engagement.subagentCalls : null, kilamuAgentCalls: stream ? stream.engagement.kilamuAgentCalls : null,
              kilamuCliCalls: stream ? stream.engagement.kilamuCliCalls : null, kilamuSkills: stream?.engagement.kilamuSkills ?? [],
              plugins: stream?.plugins ?? null, mcpServers: stream?.mcpServers ?? null, solutionLeak: leak,
              note: [note, acc.tampered ? 'tests modified' : ''].filter(Boolean).join('; '),
            };
            trials.push(t);
            console.log(`${task} ${arm} #${run}: verified=${t.verified} cost=${fmt(t.costUsd, 4)} tokens=${fmt(t.totalTokens)} turns=${fmt(t.turns)} kilamu=${fmt(t.kilamuCliCalls)}/${t.kilamuSkills.length} sub=${fmt(t.subagentCalls)} ${t.note}`);
          } finally {
            rmSync(dir, { recursive: true, force: true });
          }
        }
        if (o.isolate && !o.dryRun) {
          const pair = trials.slice(-2);
          const pa = pair.find((t) => t.arm === 'A-plain')?.plugins ?? null;
          const pb = pair.find((t) => t.arm === 'B-kilamu')?.plugins ?? null;
          const why = checkArmPlugins(pa, pb);
          if (why) throw new Error(`arm equivalence check failed for ${task} run ${run}: ${why}`);
        }
      }
    }
  } catch (e) {
    aborted = e instanceof Error ? e.message : String(e);
    console.error(`ABORTED: ${aborted}`);
  } finally {
    rmSync(cfg, { recursive: true, force: true });
    rmSync(plugin, { recursive: true, force: true });
  }
  let md = report(trials, o, startedAt);
  if (aborted) md = `> **ABORTED** after ${trials.length} trial(s): ${aborted}\n\n${md}`;
  if (o.dryRun) {
    console.log(`\n${md}`);
    return;
  }
  mkdirSync(o.out, { recursive: true });
  const stamp = startedAt.slice(0, 19).replace(/[:T]/g, '-');
  writeFileSync(join(o.out, `ab-${stamp}.json`), `${JSON.stringify({ options: { ...o, out: relative(REPO, o.out) || '.' }, startedAt, aborted, trials }, null, 2)}\n`);
  writeFileSync(join(o.out, `ab-${stamp}.md`), `${md}\n`);
  console.log(`\n${md}\n\nWrote ${join(o.out, `ab-${stamp}.{json,md}`)}`);
  if (aborted) process.exitCode = 1;
}

await main();
