import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { App } from './app.ts';
import { errorMessage, isKilamuError, KilamuError } from './core/errors.ts';
import { DATA_DIR_NAME, findProjectRoot, projectPaths } from './core/paths.ts';
import { isInitialized } from './core/trust.ts';
import { flag, parse } from './cli/args.ts';
import { cmdConfig } from './cli/config-command.ts';
import {
  cmdArtifact, cmdChecks, cmdCleanup, cmdCompress, cmdContext, cmdCost, cmdCoverage, cmdExport, cmdImpact,
  cmdImport, cmdIndex, cmdMemory, cmdSearch, cmdSymbols, cmdTools, cmdUsage, storageDiagnostics,
} from './cli/data-commands.ts';
import { cmdBrief, cmdExecution, cmdNext, cmdPlan, cmdRecover, cmdReport, cmdStatus, cmdTask, cmdVerify } from './cli/exec-commands.ts';
import { runHook } from './cli/hooks.ts';
import { emit, type CommandResult } from './cli/output.ts';
import { cmdStatuslineAdmin, renderFromStdin, statuslineDiagnostic } from './cli/statusline.ts';
import { collectCapabilities, renderDoctor } from './observability/doctor.ts';

const PKG = JSON.parse(readFileSync(resolve(import.meta.dirname, '..', 'package.json'), 'utf8')) as { version: string };

const HELP = `Kilamu Code ${PKG.version} — the intelligent multi-agent engineering system for Claude Code
Build More. Waste Less. Engineer Smarter.

Most users never type these: the plugin's skills call them. Add --json for machine output.

Setup        init [--dry-run] · doctor · config get|set|reset · statusline install|uninstall [--scope project|user] [--dry-run] [--force]
Planning     plan create|check --file plan.json · plan show · status · next · brief <task>
Tasks        task start|submit|block|unblock|release|cancel|show|events <task> · verify <task> [--attest id=note --as name] [--dry-run]
Executions   execution list|cancel · recover [--force] · report · cost
Knowledge    index [--rebuild] · search <q> · symbols <name> · impact <term> · coverage · context "<q>" [--budget N] [--content]
Context      compress --source "<cmd>" (stdin) · artifact put|show|list|rm
Memory       memory add|list|search|show|validate|invalidate|promote|check|export
Other        checks · tools [--class c] · usage · export <dir> · import <memory.json> · cleanup [--dry-run] · version`;

type Handler = (app: App, argv: string[]) => CommandResult | Promise<CommandResult>;

const WITH_APP: Record<string, Handler> = {
  plan: cmdPlan, status: cmdStatus, next: cmdNext, brief: cmdBrief, task: cmdTask, verify: cmdVerify, execution: cmdExecution,
  recover: cmdRecover, report: cmdReport, index: cmdIndex, search: cmdSearch, symbols: cmdSymbols, impact: cmdImpact,
  coverage: cmdCoverage, context: cmdContext, checks: cmdChecks, compress: cmdCompress, artifact: cmdArtifact, memory: cmdMemory,
  usage: cmdUsage, cost: cmdCost, tools: cmdTools, export: cmdExport, import: cmdImport, cleanup: cmdCleanup,
};

async function doctor(argv: string[]): Promise<CommandResult> {
  parse(argv, {});
  const root = findProjectRoot();
  const caps = await collectCapabilities(root);
  const extra = [statuslineDiagnostic(root)];
  const paths = projectPaths(root);
  if (isInitialized(paths)) {
    const app = App.open(root);
    try {
      extra.push(...storageDiagnostics(app));
    } finally {
      app.close();
    }
  } else if (existsSync(paths.dataDir)) {
    extra.push({ name: 'storage', status: 'fail', detail: `${paths.dataDir} exists but was not created by \`kilamu init\` for this user — it is ignored (it may have come with the repository)` });
  } else {
    extra.push({ name: 'storage', status: 'warn', detail: `not initialized in ${root} — run kilamu init` });
  }
  const failed = !caps.nodeSupported || !caps.sqliteAvailable || !caps.fts5Available || extra.some((e) => e.status === 'fail');
  return { data: { capabilities: caps, checks: extra }, text: renderDoctor(caps, extra), exitCode: failed ? 1 : 0 };
}

/** True if git tracks anything under the data dir (a repository shipping its own `.kilamu/`). */
function dataDirTrackedByGit(root: string): boolean {
  const r = spawnSync('git', ['-c', 'core.fsmonitor=false', 'ls-files', '--', DATA_DIR_NAME], { cwd: root, encoding: 'utf8', timeout: 10_000 });
  return r.status === 0 && r.stdout.trim().length > 0;
}

async function init(argv: string[]): Promise<CommandResult> {
  const p = parse(argv, { 'dry-run': { type: 'boolean' } });
  const root = findProjectRoot();
  const paths = projectPaths(root);
  const caps = await collectCapabilities(root);
  const exists = existsSync(paths.dataDir);
  const trusted = isInitialized(paths);
  const tracked = dataDirTrackedByGit(root);
  const plan = [
    `${exists ? 'exists ' : 'create '} ${paths.dataDir}/ {state,memory,index,artifacts,cache,logs} + .gitignore (*)`,
    `${exists ? 'keep   ' : 'create '} ${paths.dbFile} (SQLite, schema migrations)`,
    `${trusted ? 'trusted' : 'trust  '} record it in your user-scope trust file (only trusted data dirs are ever used)`,
    'never   modify project files, .gitignore or Claude Code settings',
  ];
  const notes = [
    `Agent Teams: ${caps.agentTeams.available ? `available (${caps.agentTeams.source})` : 'not enabled — Kilamu uses subagents instead. Opt in yourself with env CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 (experimental).'}`,
    `PDF indexing: ${caps.pdftotext ? 'pdftotext found' : 'pdftotext not found (optional)'}`,
    'Optional HUD: kilamu statusline install --dry-run',
  ];
  if (tracked) {
    throw new KilamuError('UNTRUSTED_DATA_DIR', `${DATA_DIR_NAME}/ is tracked by git in this repository. Kilamu state must be created locally; a shipped ${DATA_DIR_NAME}/ could inject instructions or redirect writes. Remove it from the repository first.`);
  }
  if (flag(p, 'dry-run')) return { data: { dryRun: true, root, plan, capabilities: caps }, text: `Dry run for ${root}:\n${plan.map((l) => `  ${l}`).join('\n')}\n${notes.join('\n')}` };
  if (!caps.nodeSupported || !caps.sqliteAvailable || !caps.fts5Available) {
    return { data: caps, text: renderDoctor(caps), exitCode: 1 };
  }
  if (exists && !trusted && readdirSync(paths.dataDir).length > 0) {
    throw new KilamuError('UNTRUSTED_DATA_DIR', `${paths.dataDir} exists, is not empty and was not created by \`kilamu init\` for this user (it may have come with the repository or an archive). Move it aside (e.g. mv ${DATA_DIR_NAME} ${DATA_DIR_NAME}.untrusted) and run init again.`);
  }
  const warn = '';
  App.open(root, { create: true }).close();
  return { data: { root, initialized: true, capabilities: caps }, text: `Kilamu Code initialized in ${root}${warn}\n${notes.join('\n')}\nNext: kilamu index` };
}

export async function main(argv: string[]): Promise<number> {
  // Everything Kilamu creates is private to the user (dirs 0700, files 0600).
  process.umask(0o077);
  const [cmd, ...rest] = argv;
  const json = rest.includes('--json');
  try {
    if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
      process.stdout.write(`${HELP}\n`);
      return 0;
    }
    if (cmd === 'version' || cmd === '--version') {
      process.stdout.write(`kilamu-code ${PKG.version}\n`);
      return 0;
    }
    // --help never executes a command (it used to run init/statusline install).
    // `-h` only as the first argument, so a flag VALUE like `--summary -h` is never mistaken for help.
    if (rest.includes('--help') || rest[0] === '-h') {
      process.stdout.write(`${HELP}\n`);
      return 0;
    }
    if (cmd === 'hook') {
      const out = await runHook(rest[0] ?? '');
      if (out.stdout) process.stdout.write(out.stdout);
      if (out.stderr) process.stderr.write(`${out.stderr}\n`);
      return out.exitCode;
    }
    if (cmd === 'statusline') {
      if (rest[0] === 'install' || rest[0] === 'uninstall') return emit(cmdStatuslineAdmin(findProjectRoot(), rest), json);
      process.stdout.write(`${await renderFromStdin()}\n`);
      return 0;
    }
    if (cmd === 'doctor') return emit(await doctor(rest), json);
    if (cmd === 'init') return emit(await init(rest), json);
    if (cmd === 'config') return emit(cmdConfig(findProjectRoot(), rest), json);
    const handler = WITH_APP[cmd];
    if (!handler) {
      process.stderr.write(`kilamu: unknown command "${cmd}"\n\n${HELP}\n`);
      return 2;
    }
    const app = App.open();
    try {
      return emit(await handler(app, rest), json);
    } finally {
      app.close();
    }
  } catch (e) {
    const code = isKilamuError(e) ? e.code : 'INTERNAL';
    if (json) process.stdout.write(`${JSON.stringify({ error: { code, message: errorMessage(e) } })}\n`);
    else process.stderr.write(`kilamu: ${errorMessage(e)}${code === 'INTERNAL' && process.env.KILAMU_DEBUG ? `\n${(e as Error).stack}` : ''}\n`);
    return code === 'USAGE' ? 2 : 1;
  }
}

const isEntry = (() => {
  try {
    return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isEntry) {
  main(process.argv.slice(2)).then((c) => { process.exitCode = c; });
}
