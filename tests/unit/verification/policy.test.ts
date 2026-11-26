import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseCommand } from '../../../src/core/exec.ts';
import { checkCommandPolicy, packageScripts } from '../../../src/verification/policy.ts';

let root: string;
const check = (cmd: string, extra: string[] = []) => checkCommandPolicy(parseCommand(cmd), { root, packageScripts: packageScripts(root), extraPrograms: extra });

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'kil-policy-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run', typecheck: 'tsc --noEmit' } }));
  mkdirSync(join(root, 'scripts'));
  writeFileSync(join(root, 'scripts/check.js'), '');
  writeFileSync(join(root, 'run_checks.py'), '');
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('verification command policy', () => {
  it.each([
    'npm test', 'npm test -- tests/auth.test.ts', 'npm run typecheck', 'pnpm test', 'yarn run typecheck', 'bun test',
    'node --test', 'node --test --test-reporter=spec tests/', 'node --test --test-reporter=tap --test-reporter-destination=stdout', 'node scripts/check.js',
    'python -m pytest -q tests/', 'python3 -m unittest', 'python run_checks.py', 'pytest -x tests/unit', 'tsc --noEmit',
    'go test ./...', 'cargo test --all', 'make test lint', 'mvn -q test', './gradlew test --offline', 'dotnet test',
  ])('allows %s', (c) => {
    expect(check(c)).toBeNull();
  });

  it.each([
    ['npm run missing', /not a script/],
    ['npm test --silent', /after "--"/],
    ['npm exec cowsay', /only "npm test"/],
    ['npm install left-pad', /only "npm test"/],
    ['node --version', /project file/],
    ['node scripts/missing.js', /does not exist/],
    ['python -m http.server', /not an allowed module/],
    ['go test -toolexec x ./...', /arbitrary programs/],
    ['make -C /tmp test', /refers outside the project/],
    ['make VAR=1 test', /targets/],
    ['pytest ../other', /refers outside/],
    ['tsc -p /etc/tsconfig.json', /refers outside/],
    ['rake test', /not an allowed verification runner/],
    ['./evil', /not an allowed verification runner/],
    ['/bin/sh', /not an allowed verification runner/],
    ['node --test --test-reporter=data:text/javascript,1 tests/a.js', /scheme|reporters/],
    ['node --test --test-reporter=some-npm-package', /reporters/],
    ['node --test --test-reporter-destination=.kilamu/.trust-token', /reporters/],
    ['node --test --import=x.js', /not allowed/],
    ['prettier --plugin=data:text/javascript,1 --check .', /scheme|loads modules/],
    ['vitest run --reporter=./evil.js', /loads modules/],
    ['jest --globalSetup=./x.js', /loads modules/],
    ['pytest -p evil_plugin', /loads modules/],
    ['python -m pytest -p evil', /loads modules/],
    ['npm test -- --import=data:text/javascript,1', /scheme|loads modules/],
    ['npm test -- --require ./x.js', /loads modules/],
    ['mvn org.evil:plugin:1.0:run', /not allowed/],
    ['go vet -vettool=./x ./...', /arbitrary programs/],
    ['eslint --rulesdir rules .', /loads modules/],
  ])('rejects %s', (c, re) => {
    expect(check(c)).toMatch(re);
  });

  it('extra programs come only from the user-scope list and still cannot escape the project', () => {
    expect(check('rake test', ['rake'])).toBeNull();
    expect(check('rake -f /etc/x', ['rake'])).toMatch(/outside/);
    expect(check('./rake test', ['./rake'])).toMatch(/not an allowed/);
  });
});
