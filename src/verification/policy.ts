import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isInside, safeResolve, userConfigDir } from '../core/paths.ts';

/**
 * Verification command policy (ADR-006, revised after the 0.1.0 security review).
 *
 * Acceptance commands are model-authored and run inside `kilamu verify`,
 * outside Claude Code's per-command permission prompt. A program allowlist is
 * not enough (`node -pe`, `npx pkg`, `git -c alias.x=!cmd`, `npm exec -c` all
 * execute arbitrary code), so every command must match an argv TEMPLATE for a
 * project test/build/lint runner:
 *   npm|pnpm|yarn|bun  test | run <script that exists in package.json>
 *   node               --test [paths] | <existing project .js/.mjs/.cjs/.ts file>
 *   python|python3     -m <pytest|unittest|mypy|ruff|...> | <existing project .py file>
 *   go                 test|vet|build      (no -exec/-toolexec/-overlay)
 *   cargo              test|build|check|clippy|fmt   (no --config/-Z)
 *   make               <target names only, no flags>
 *   dotnet, mvn, gradle  fixed phases/tasks only
 *   pytest vitest jest tsc eslint prettier biome ruff mypy pyright flake8 pylint black   direct runners
 * Every argument is additionally confined to the project: no absolute paths,
 * no `~`, no `..` segments.
 *
 * Residual risk (by design, documented): these runners execute project code —
 * including code an agent just wrote — exactly as running the tests yourself
 * would. The policy prevents *other* commands, not the project's own tooling.
 *
 * Extra programs can only be allowed in the USER-scope file
 * `<userConfigDir>/verification.json` ({"extraPrograms": ["rake"]}), never from
 * project config or the CLI, so a model cannot widen its own policy.
 */

export interface PolicyContext {
  root: string;
  /** Script names from <root>/package.json (or of `cwd`), null if none. */
  packageScripts: Set<string> | null;
  extraPrograms: string[];
}

const DIRECT_RUNNERS = new Set(['pytest', 'vitest', 'jest', 'tsc', 'eslint', 'prettier', 'biome', 'ruff', 'mypy', 'pyright', 'flake8', 'pylint', 'black']);
const PY_MODULES = new Set(['pytest', 'unittest', 'mypy', 'ruff', 'pyright', 'black', 'isort', 'flake8', 'pylint', 'doctest']);
const JS_FILE = /\.(c|m)?(js|ts)$/;
const NAME = /^[A-Za-z0-9_.:/-]+$/;
/** Target / phase names without ':' (mvn `g:a:v:goal` downloads and runs remote plugins). */
const PLAIN_NAME = /^[A-Za-z0-9_./-]+$/;
/** URL/specifier schemes: `data:` modules, remote URLs, `node:`/`npm:` specifiers execute or fetch code. */
const SCHEME = /(^|[=,])(data|file|https?|ftp|node|npm|jsr|git|git\+[a-z]+|blob|javascript|vbscript):/i;
/**
 * Flags that load arbitrary modules/plugins/reporters into a runner (round-2
 * review N1). Rejected for direct runners, python -m modules and script args.
 */
const CODE_LOADING_FLAG = /^(-p|-r|--plugins?|--require|--import|--loader|--experimental-loader|--rulesdir|--resolve-plugins-relative-to|--reporters?|--test-reporter|--globalSetup|--globalTeardown|--setupFiles(AfterEnv)?|--transform|--testEnvironment|--environment|--runner|--testRunner|--pool|--watch|--ui|--api|--inspect(-brk)?|-o|--override-ini|--rootdir|--confcutdir|--pyargs|--vettool|-vettool)(=|$)/;
const NODE_TEST_FLAG = /^--test-(name-pattern|skip-pattern|only|concurrency|timeout|force-exit|update-snapshots|coverage)(=.*)?$/;
const NODE_REPORTER = /^--test-reporter=(spec|tap|dot|junit|lcov)$/;
const NODE_REPORTER_DEST = /^--test-reporter-destination=(stdout|stderr)$/;

export function packageScripts(dir: string): Set<string> | null {
  const file = join(dir, 'package.json');
  if (!existsSync(file)) return null;
  try {
    const pkg = JSON.parse(readFileSync(file, 'utf8')) as { scripts?: Record<string, unknown> };
    return new Set(Object.keys(pkg.scripts ?? {}));
  } catch {
    return null;
  }
}

/** Programs the user (not the project, not the model) explicitly allowed. */
export function userExtraPrograms(): string[] {
  // An overridden config home is caller-controlled (tests, or a crafted command line): never widen from it.
  if (process.env.KILAMU_CONFIG_HOME) return [];
  const file = join(userConfigDir(), 'verification.json');
  if (!existsSync(file)) return [];
  try {
    const v = JSON.parse(readFileSync(file, 'utf8')) as { extraPrograms?: unknown };
    return Array.isArray(v.extraPrograms) ? v.extraPrograms.filter((p): p is string => typeof p === 'string' && NAME.test(p) && !p.includes('/')) : [];
  } catch {
    return [];
  }
}

function argEscapes(a: string): boolean {
  const vals = [a, ...(a.includes('=') ? [a.slice(a.indexOf('=') + 1)] : [])];
  return vals.some((v) => v.startsWith('/') || v.startsWith('~') || /^[A-Za-z]:[\\/]/.test(v) || v.split(/[\\/]/).includes('..'));
}

function projectFile(ctx: PolicyContext, rel: string, ext: RegExp): string | null {
  if (rel.startsWith('-')) return `expected a project file, got flag ${rel}`;
  if (!ext.test(rel)) return `${rel} is not a runnable project script`;
  try {
    const abs = safeResolve(ctx.root, rel);
    if (!existsSync(abs) || !statSync(abs).isFile() || !isInside(ctx.root, abs)) return `${rel} does not exist in the project`;
  } catch {
    return `${rel} escapes the project`;
  }
  return null;
}

/** Arguments after the subcommand: flags only after a literal "--" (passed to the script). */
function scriptArgs(rest: string[]): string | null {
  const sep = rest.indexOf('--');
  const before = sep === -1 ? rest : rest.slice(0, sep);
  const flag = before.find((a) => a.startsWith('-'));
  if (flag) return `flag ${flag} must come after "--" (it would be interpreted by the package manager)`;
  return codeLoading(sep === -1 ? [] : rest.slice(sep + 1));
}

function codeLoading(args: string[]): string | null {
  const bad = args.find((a) => CODE_LOADING_FLAG.test(a));
  return bad ? `option ${bad} loads modules, plugins or reporters and is not allowed (configure them in the project's own config files)` : null;
}

function packageManager(pm: string, args: string[], ctx: PolicyContext): string | null {
  const [sub, ...rest] = args;
  if (sub === 'test' || sub === 't') {
    if (pm !== 'bun' && !ctx.packageScripts?.has('test')) return 'package.json has no "test" script';
    return scriptArgs(rest);
  }
  if (sub === 'run' || sub === 'run-script') {
    const script = rest[0];
    if (!script || !ctx.packageScripts?.has(script)) return `"${script ?? ''}" is not a script in package.json`;
    return scriptArgs(rest.slice(1));
  }
  return `only "${pm} test" and "${pm} run <script>" are allowed (not "${sub ?? ''}")`;
}

function node(args: string[], ctx: PolicyContext): string | null {
  if (args[0] === '--test') {
    const bad = args.slice(1).find((a) => a.startsWith('-') && !NODE_TEST_FLAG.test(a) && !NODE_REPORTER.test(a) && !NODE_REPORTER_DEST.test(a));
    return bad ? `node flag ${bad} is not allowed (reporters: spec|tap|dot|junit|lcov written to stdout|stderr; other --test-* options only)` : null;
  }
  const first = args[0];
  if (!first) return 'node needs --test or a project script';
  return projectFile(ctx, first, JS_FILE);
}

function python(args: string[], ctx: PolicyContext): string | null {
  if (args[0] === '-m') {
    if (!args[1] || !PY_MODULES.has(args[1])) return `python -m ${args[1] ?? ''} is not an allowed module (${[...PY_MODULES].join(', ')})`;
    return codeLoading(args.slice(2));
  }
  const first = args[0];
  if (!first) return 'python needs -m <module> or a project script';
  return projectFile(ctx, first, /\.py$/);
}

function subcommand(prog: string, args: string[], allowed: string[], banned: RegExp | null): string | null {
  if (!args[0] || !allowed.includes(args[0])) return `only ${allowed.map((s) => `"${prog} ${s}"`).join(', ')} are allowed`;
  const bad = banned ? args.find((a) => banned.test(a)) : undefined;
  return bad ? `${prog} option ${bad} can execute arbitrary programs and is not allowed` : null;
}

function namesOnly(prog: string, args: string[], flags: string[], names: RegExp = NAME): string | null {
  const bad = args.find((a) => (a.startsWith('-') && !flags.includes(a)) || (!a.startsWith('-') && !names.test(a)));
  return bad ? `${prog} argument ${bad} is not allowed (targets/phases${flags.length ? ` and ${flags.join(' ')}` : ''} only)` : null;
}

/** Null if the command is allowed; otherwise the reason it is rejected. */
export function checkCommandPolicy(argv: string[], ctx: PolicyContext): string | null {
  const [prog, ...args] = argv;
  if (!prog) return 'empty command';
  const escaping = args.find(argEscapes);
  if (escaping) return `argument ${escaping} refers outside the project (absolute, ~ or ..)`;
  const scheme = args.find((a) => SCHEME.test(a));
  if (scheme) return `argument ${scheme} uses a URL/module specifier scheme, which can load or fetch code`;
  switch (prog) {
    case 'npm': case 'pnpm': case 'yarn': case 'bun':
      return packageManager(prog, args, ctx);
    case 'node':
      return node(args, ctx);
    case 'python': case 'python3':
      return python(args, ctx);
    case 'go':
      return subcommand('go', args, ['test', 'vet', 'build'], /^-{1,2}(exec|toolexec|overlay|vettool)(=|$)/);
    case 'cargo':
      return subcommand('cargo', args, ['test', 'build', 'check', 'clippy', 'fmt'], /^(--config(=|$)|-Z)/);
    case 'make':
      return namesOnly('make', args, [], PLAIN_NAME);
    case 'dotnet':
      return subcommand('dotnet', args, ['test', 'build'], null);
    case 'mvn': case './mvnw':
      return namesOnly(prog, args, ['-q', '-B', '-o', '--quiet', '--batch-mode', '--offline'], PLAIN_NAME);
    case 'gradle': case './gradlew':
      return namesOnly(prog, args, ['-q', '--quiet', '--offline', '--no-daemon', '--stacktrace']);
    default:
      if (DIRECT_RUNNERS.has(prog)) return codeLoading(args);
      if (!prog.includes('/') && ctx.extraPrograms.includes(prog)) return null;
      return `program "${prog}" is not an allowed verification runner (see SECURITY.md; extra programs can only be allowed in ${join(userConfigDir(), 'verification.json')})`;
  }
}
