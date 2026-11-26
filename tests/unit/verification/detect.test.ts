import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { detectChecks } from '../../../src/verification/detect.ts';

const dirs: string[] = [];
function fixture(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), 'kil-detect-'));
  dirs.push(d);
  for (const [k, v] of Object.entries(files)) writeFileSync(join(d, k), v);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('detectChecks', () => {
  it('reads package.json scripts and picks runner from lockfile', () => {
    const pkg = JSON.stringify({ scripts: { typecheck: 'tsc', test: 'vitest', lint: 'eslint .', build: 'tsc', dev: 'x' } });
    expect(detectChecks(fixture({ 'package.json': pkg })).map((c) => c.command)).toEqual([
      'npm run typecheck', 'npm run lint', 'npm test', 'npm run build',
    ]);
    const pn = detectChecks(fixture({ 'package.json': pkg, 'pnpm-lock.yaml': '' }));
    expect(pn.every((c) => c.command.startsWith('pnpm'))).toBe(true);
    expect(detectChecks(fixture({ 'package.json': pkg, 'yarn.lock': '' }))[0]?.command).toBe('yarn run typecheck');
    expect(detectChecks(fixture({ 'package.json': pkg, 'bun.lockb': '' }))[2]?.command).toBe('bun test');
  });

  it('ignores malformed package.json', () => {
    expect(detectChecks(fixture({ 'package.json': '{nope' }))).toEqual([]);
  });

  it('detects python tools from pyproject', () => {
    const py = '[tool.ruff]\nline-length=100\n[tool.mypy]\nstrict=true\n';
    const r = detectChecks(fixture({ 'pyproject.toml': py }));
    expect(r.map((c) => c.command).sort()).toEqual(['mypy .', 'python -m pytest', 'ruff check .']);
  });

  it('detects go, rust and make', () => {
    expect(detectChecks(fixture({ 'go.mod': 'module x' })).map((c) => c.command)).toEqual(['go vet ./...', 'go test ./...']);
    expect(detectChecks(fixture({ 'Cargo.toml': '[package]' })).map((c) => c.command)).toEqual(['cargo clippy', 'cargo test']);
    const mk = detectChecks(fixture({ Makefile: 'test:\n\techo\nbuild:\n\techo\n' }));
    expect(mk.map((c) => c.command)).toEqual(['make test', 'make build']);
  });

  it('returns empty for an empty project', () => {
    expect(detectChecks(fixture({}))).toEqual([]);
  });
});
