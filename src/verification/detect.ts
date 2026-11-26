import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type CheckName = 'typecheck' | 'test' | 'lint' | 'build';

export interface DetectedCheck {
  name: CheckName;
  command: string;
  source: string;
}

const ORDER: Record<CheckName, number> = { typecheck: 0, lint: 1, test: 2, build: 3 };

function readText(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function nodeRunner(root: string): string {
  if (existsSync(join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(root, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(root, 'bun.lockb')) || existsSync(join(root, 'bun.lock'))) return 'bun';
  return 'npm';
}

function scriptCommand(runner: string, script: string): string {
  if (script === 'test') return `${runner} test`;
  return `${runner} run ${script}`;
}

function detectNode(root: string): DetectedCheck[] {
  const text = readText(join(root, 'package.json'));
  if (text === null) return [];
  let scripts: Record<string, unknown> = {};
  try {
    const pkg = JSON.parse(text) as { scripts?: Record<string, unknown> };
    scripts = pkg.scripts ?? {};
  } catch {
    return [];
  }
  const runner = nodeRunner(root);
  const has = (s: string) => typeof scripts[s] === 'string';
  const out: DetectedCheck[] = [];
  const typecheck = ['typecheck', 'type-check', 'tsc'].find(has);
  if (typecheck) out.push({ name: 'typecheck', command: scriptCommand(runner, typecheck), source: `package.json#scripts.${typecheck}` });
  if (has('lint')) out.push({ name: 'lint', command: scriptCommand(runner, 'lint'), source: 'package.json#scripts.lint' });
  if (has('test')) out.push({ name: 'test', command: scriptCommand(runner, 'test'), source: 'package.json#scripts.test' });
  if (has('build')) out.push({ name: 'build', command: scriptCommand(runner, 'build'), source: 'package.json#scripts.build' });
  return out;
}

function detectPython(root: string): DetectedCheck[] {
  const pyproject = readText(join(root, 'pyproject.toml'));
  const marker = ['pytest.ini', 'setup.cfg', 'tox.ini'].find((f) => existsSync(join(root, f)));
  const out: DetectedCheck[] = [];
  if (pyproject !== null || marker) {
    out.push({ name: 'test', command: 'python -m pytest', source: pyproject !== null ? 'pyproject.toml' : (marker as string) });
  }
  const configs = [pyproject, readText(join(root, 'setup.cfg')), readText(join(root, 'tox.ini'))].filter((t): t is string => t !== null);
  const mentions = (re: RegExp) => configs.some((c) => re.test(c));
  if (existsSync(join(root, 'ruff.toml')) || existsSync(join(root, '.ruff.toml')) || mentions(/\[tool\.ruff/)) {
    out.push({ name: 'lint', command: 'ruff check .', source: 'ruff config' });
  }
  if (existsSync(join(root, 'mypy.ini')) || existsSync(join(root, '.mypy.ini')) || mentions(/\[tool\.mypy|\[mypy\]/)) {
    out.push({ name: 'typecheck', command: 'mypy .', source: 'mypy config' });
  }
  return out;
}

function detectGo(root: string): DetectedCheck[] {
  if (!existsSync(join(root, 'go.mod'))) return [];
  return [
    { name: 'test', command: 'go test ./...', source: 'go.mod' },
    { name: 'lint', command: 'go vet ./...', source: 'go.mod' },
  ];
}

function detectRust(root: string): DetectedCheck[] {
  if (!existsSync(join(root, 'Cargo.toml'))) return [];
  return [
    { name: 'test', command: 'cargo test', source: 'Cargo.toml' },
    { name: 'lint', command: 'cargo clippy', source: 'Cargo.toml' },
  ];
}

function detectMake(root: string): DetectedCheck[] {
  const text = readText(join(root, 'Makefile'));
  if (text === null) return [];
  const out: DetectedCheck[] = [];
  for (const name of ['test', 'lint', 'build'] as const) {
    if (new RegExp(`^${name}\\s*:`, 'm').test(text)) out.push({ name, command: `make ${name}`, source: `Makefile#${name}` });
  }
  return out;
}

/** Detect verification commands from project manifests. Deterministic order: kind, then command. */
export function detectChecks(root: string): DetectedCheck[] {
  const all = [...detectNode(root), ...detectPython(root), ...detectGo(root), ...detectRust(root), ...detectMake(root)];
  const seen = new Set<string>();
  const unique = all.filter((c) => (seen.has(c.command) ? false : (seen.add(c.command), true)));
  return unique.sort((a, b) => ORDER[a.name] - ORDER[b.name] || a.command.localeCompare(b.command));
}
