import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ArtifactStore } from '../../../src/context/artifacts.ts';
import { compressAndStore, compressOutput, MAX_FINDINGS, renderSummary } from '../../../src/context/compress.ts';
import { openRuntime, type Runtime } from '../../../src/runtime.ts';

/** 1-based line number of the first line containing `needle`. */
function lineOf(text: string, needle: string, from = 1): number {
  const lines = text.split('\n');
  const idx = lines.findIndex((l, i) => i >= from - 1 && l.includes(needle));
  if (idx < 0) throw new Error(`fixture is missing: ${needle}`);
  return idx + 1;
}

const VITEST_FAIL = ` RUN  v2.1.8 /home/dev/proj

 ✓ tests/util.test.ts (3 tests) 4ms
 ❯ tests/math.test.ts (2 tests | 1 failed) 8ms
   × math > adds numbers 6ms
     → expected 3 to be 4 // Object.is equality

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/math.test.ts > math > adds numbers
AssertionError: expected 3 to be 4 // Object.is equality

- Expected
+ Received

- 4
+ 3

 ❯ tests/math.test.ts:7:19
      5|   it('adds numbers', () => {
      6|     const r = add(1, 2);
      7|     expect(r).toBe(4);
       |               ^
      8|   });

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed | 1 passed (2)
      Tests  1 failed | 4 passed (5)
   Start at  10:00:00
   Duration  412ms
`;

const PYTEST_FAIL = `============================= test session starts ==============================
platform linux -- Python 3.12.1, pytest-8.0.0, pluggy-1.4.0
rootdir: /home/dev/proj
collected 3 items

tests/test_calc.py .F.                                                   [100%]

=================================== FAILURES ===================================
_________________________________ test_divide __________________________________

    def test_divide():
>       assert divide(6, 3) == 3
E       assert 2.0 == 3
E        +  where 2.0 = divide(6, 3)

tests/test_calc.py:9: AssertionError
=========================== short test summary info ============================
FAILED tests/test_calc.py::test_divide - assert 2.0 == 3
========================= 1 failed, 2 passed in 0.03s ==========================
`;

const TSC_FAIL = `src/index.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.
src/util.ts(3,10): error TS2305: Module '"./types"' has no exported member 'Foo'.
src/util.ts(40,1): error TS2345: Argument of type 'number' is not assignable to parameter of type 'string'.
  Type 'number' is not assignable to type 'string'.
`;

const GO_FAIL = `--- FAIL: TestDivide (0.00s)
    calc_test.go:14: Divide(6, 3) = 3; want 2
FAIL
FAIL	example.com/calc	0.004s
`;

const GO_FAIL_VERBOSE = `=== RUN   TestAdd
--- PASS: TestAdd (0.00s)
=== RUN   TestDivide
    calc_test.go:14: Divide(6, 3) = 3; want 2
--- FAIL: TestDivide (0.00s)
FAIL
FAIL	example.com/calc	0.004s
`;

const CARGO_FAIL = `running 2 tests
test tests::adds ... ok
test tests::divides ... FAILED

failures:

---- tests::divides stdout ----
thread 'tests::divides' panicked at src/lib.rs:15:9:
assertion \`left == right\` failed
  left: 2
 right: 3
note: run with \`RUST_BACKTRACE=1\` environment variable to display a backtrace


failures:
    tests::divides

test result: FAILED. 1 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
`;

const ESLINT_FAIL = `
/home/dev/proj/src/app.js
   3:7   error    'unused' is assigned a value but never used  no-unused-vars
  10:1   warning  Unexpected console statement                no-console

/home/dev/proj/src/db.js
  22:15  error  'conn' is not defined  no-undef

✖ 3 problems (2 errors, 1 warning)
`;

const NPM_FAIL = `> proj@1.0.0 build
> node build.js

npm ERR! code ELIFECYCLE
npm ERR! errno 1
npm ERR! proj@1.0.0 build: \`node build.js\`
npm ERR! Exit status 1
npm ERR!
`;

const TRACEBACK = `Starting worker
Traceback (most recent call last):
  File "/app/main.py", line 42, in <module>
    run()
  File "/app/worker.py", line 17, in run
    value = int(raw)
ValueError: invalid literal for int() with base 10: 'abc'
`;

describe('compressOutput: format detection and extraction', () => {
  it('vitest: failed test, assertion, location and summary with exact line range', () => {
    const s = compressOutput(VITEST_FAIL, { source: 'bash', command: 'npx vitest run' });
    expect(s.detectedFormat).toBe('vitest');
    expect(s.status).toBe('failure');
    const f = s.findings[0]!;
    expect(f.text).toContain('FAIL tests/math.test.ts > math > adds numbers');
    expect(f.text).toContain('AssertionError: expected 3 to be 4');
    expect(f.text).toContain('@ tests/math.test.ts:7');
    expect(f.lineStart).toBe(lineOf(VITEST_FAIL, ' FAIL  tests/math.test.ts'));
    expect(f.lineEnd).toBe(lineOf(VITEST_FAIL, '❯ tests/math.test.ts:7:19'));
    expect(s.findings.some((x) => x.text.includes('Tests  1 failed | 4 passed (5)'))).toBe(true);
    expect(s.source).toBe('bash: npx vitest run');
  });

  it('pytest: failure section, short summary and final line', () => {
    const s = compressOutput(PYTEST_FAIL, { source: 'bash' });
    expect(s.detectedFormat).toBe('pytest');
    expect(s.status).toBe('failure');
    const section = s.findings.find((f) => f.text.startsWith('test_divide'))!;
    expect(section.text).toContain('assert 2.0 == 3');
    expect(section.text).toContain('@ tests/test_calc.py:9 (AssertionError)');
    expect(section.lineStart).toBe(lineOf(PYTEST_FAIL, '____ test_divide ____'));
    expect(section.lineEnd).toBe(lineOf(PYTEST_FAIL, 'tests/test_calc.py:9: AssertionError'));
    const failed = s.findings.find((f) => f.text.startsWith('FAILED tests/test_calc.py::test_divide'))!;
    expect(failed.lineStart).toBe(lineOf(PYTEST_FAIL, 'FAILED tests/'));
    expect(s.findings.at(-1)!.text).toBe('1 failed, 2 passed in 0.03s');
  });

  it('tsc: one finding per error, continuation lines included in the range', () => {
    const s = compressOutput(TSC_FAIL, { source: 'bash' });
    expect(s.detectedFormat).toBe('tsc');
    expect(s.status).toBe('failure');
    expect(s.findings.map((f) => f.text)).toEqual([
      "src/index.ts:12:5 TS2322 Type 'string' is not assignable to type 'number'.",
      `src/util.ts:3:10 TS2305 Module '"./types"' has no exported member 'Foo'.`,
      "src/util.ts:40:1 TS2345 Argument of type 'number' is not assignable to parameter of type 'string'.",
    ]);
    expect(s.findings[2]).toMatchObject({ lineStart: 3, lineEnd: 4 });
  });

  it('go test: --- FAIL with its log line, in both plain and -v order', () => {
    const plain = compressOutput(GO_FAIL, { source: 'bash' });
    expect(plain.detectedFormat).toBe('go-test');
    expect(plain.status).toBe('failure');
    expect(plain.findings[0]).toMatchObject({
      text: '--- FAIL TestDivide — Divide(6, 3) = 3; want 2 @ calc_test.go:14', lineStart: 1, lineEnd: 2,
    });
    expect(plain.findings.some((f) => f.text.startsWith('FAIL\texample.com/calc'))).toBe(true);

    const verbose = compressOutput(GO_FAIL_VERBOSE, { source: 'bash' });
    expect(verbose.findings[0]).toMatchObject({
      text: '--- FAIL TestDivide — Divide(6, 3) = 3; want 2 @ calc_test.go:14',
      lineStart: lineOf(GO_FAIL_VERBOSE, 'calc_test.go:14'),
      lineEnd: lineOf(GO_FAIL_VERBOSE, '--- FAIL'),
    });
  });

  it('cargo test: panic message and location, result line', () => {
    const s = compressOutput(CARGO_FAIL, { source: 'bash' });
    expect(s.detectedFormat).toBe('cargo-test');
    expect(s.status).toBe('failure');
    expect(s.findings[0]!.text).toBe('FAILED tests::divides — assertion `left == right` failed — @ src/lib.rs:15:9');
    expect(s.findings[0]!.lineStart).toBe(lineOf(CARGO_FAIL, '---- tests::divides stdout'));
    expect(s.findings.at(-1)!.text).toMatch(/^test result: FAILED\./);
  });

  it('eslint: errors with file, rule and the total', () => {
    const s = compressOutput(ESLINT_FAIL, { source: 'bash' });
    expect(s.detectedFormat).toBe('eslint');
    expect(s.status).toBe('failure');
    expect(s.findings.map((f) => f.text)).toEqual([
      "/home/dev/proj/src/app.js:3:7 error 'unused' is assigned a value but never used (no-unused-vars)",
      "/home/dev/proj/src/db.js:22:15 error 'conn' is not defined (no-undef)",
      '✖ 3 problems (2 errors, 1 warning)',
    ]);
  });

  it('npm ERR!: keeps non-empty error lines', () => {
    const s = compressOutput(NPM_FAIL, { source: 'bash' });
    expect(s.detectedFormat).toBe('npm');
    expect(s.status).toBe('failure');
    expect(s.findings.map((f) => f.text)).toContain('npm ERR! code ELIFECYCLE');
    expect(s.findings.some((f) => f.text === 'npm ERR!')).toBe(false);
  });

  it('python traceback: last frame plus exception line', () => {
    const s = compressOutput(TRACEBACK, { source: 'bash' });
    expect(s.detectedFormat).toBe('python-traceback');
    expect(s.findings).toEqual([{
      text: "ValueError: invalid literal for int() with base 10: 'abc' @ /app/worker.py:17 in run",
      lineStart: lineOf(TRACEBACK, 'File "/app/worker.py"'),
      lineEnd: lineOf(TRACEBACK, 'ValueError'),
    }]);
  });

  it('strips ANSI colour codes before matching', () => {
    const coloured = VITEST_FAIL.replace(' FAIL ', ' \u001b[31mFAIL\u001b[39m ');
    const s = compressOutput(coloured, { source: 'bash' });
    expect(s.findings[0]!.text).toContain('FAIL tests/math.test.ts > math > adds numbers');
  });
});

describe('compressOutput: large logs, dedupe and caps', () => {
  it('finds a vitest failure in the middle of a 5,000-line log with the right range', () => {
    const before = Array.from({ length: 2500 }, (_, i) => ` ✓ tests/gen/case${i}.test.ts > generated case ${i} 1ms`);
    const block = [
      '',
      ' FAIL  tests/gen/needle.test.ts > needle > finds the needle',
      'AssertionError: expected 41 to be 42 // Object.is equality',
      '',
      ' ❯ tests/gen/needle.test.ts:21:9',
      '',
    ];
    const after = Array.from({ length: 5000 - 2500 - block.length - 2 }, (_, i) => ` ✓ tests/gen/late${i}.test.ts > late ${i} 1ms`);
    const log = [...before, ...block, ...after, ' Test Files  1 failed | 4999 passed (5000)', '      Tests  1 failed | 4999 passed (5000)'].join('\n');
    expect(log.split('\n')).toHaveLength(5000);

    const s = compressOutput(log, { source: 'bash' });
    expect(s.totalLines).toBe(5000);
    expect(s.detectedFormat).toBe('vitest');
    expect(s.status).toBe('failure');
    const needle = s.findings.find((f) => f.text.includes('needle'))!;
    expect(needle.lineStart).toBe(2502);
    expect(needle.lineEnd).toBe(2505);
    expect(log.split('\n')[needle.lineStart! - 1]).toContain('FAIL  tests/gen/needle.test.ts');
    expect(needle.text).toContain('expected 41 to be 42');
    expect(needle.text).toContain('@ tests/gen/needle.test.ts:21');
    expect(s.estimatedTokensSaved.label).toBe('ESTIMATED');
    expect(s.estimatedTokensSaved.value!).toBeGreaterThan(50_000);
  });

  it('finds a generic error in the middle of a 5,000-line application log', () => {
    const lines = Array.from({ length: 5000 }, (_, i) => `2026-11-25T10:00:${String(i % 60).padStart(2, '0')} INFO request ${i} ok`);
    lines[2499] = '2026-11-25T10:41:39 FATAL database pool exhausted after 30s';
    const s = compressOutput(lines.join('\n'), { source: 'bash' });
    expect(s.detectedFormat).toBe('generic');
    expect(s.status).toBe('unknown');
    expect(s.findings[0]).toMatchObject({ lineStart: 2500, lineEnd: 2500 });
    expect(s.findings[0]!.text).toContain('database pool exhausted');
    const tail = s.findings.at(-1)!;
    expect(tail).toMatchObject({ lineStart: 4986, lineEnd: 5000 });
  });

  it('collapses repeated lines into "×N"', () => {
    const log = Array.from({ length: 200 }, (_, i) => `ERROR connection refused (attempt ${i + 1})`).join('\n');
    const s = compressOutput(log, { source: 'bash' });
    expect(s.findings[0]).toMatchObject({ text: 'ERROR connection refused (attempt 1) (×200)', lineStart: 1, lineEnd: 1 });
  });

  it('caps findings and keeps the summary line', () => {
    const errs = Array.from({ length: 60 }, (_, i) => `src/f${i}.ts(${i + 1},1): error TS2304: Cannot find name 'x${i}'.`);
    const s = compressOutput([...errs, '', 'Found 60 errors in 60 files.'].join('\n'), { source: 'bash' });
    expect(s.findings.length).toBeLessThanOrEqual(MAX_FINDINGS);
    expect(s.findings.at(-1)!.text).toBe('Found 60 errors in 60 files.');
    expect(s.findings.some((f) => /more findings omitted/.test(f.text))).toBe(true);
    expect(renderSummary(s).split('\n').length).toBeLessThanOrEqual(60);
  });

  it('redacts secrets that appear in findings', () => {
    const key = `sk-ant-api03-${'Zz9Yy8Xx7W'.repeat(4)}`;
    const s = compressOutput(`Error: auth failed for key ${key}\n`, { source: 'bash' });
    expect(JSON.stringify(s)).not.toContain(key);
  });
});

describe('compressOutput: status', () => {
  it('uses the exit code when known', () => {
    expect(compressOutput(VITEST_FAIL, { source: 'b', exitCode: 0 }).status).toBe('success');
    expect(compressOutput('all good\n', { source: 'b', exitCode: 2 }).status).toBe('failure');
  });

  it('infers from the format summary otherwise', () => {
    const passing = ' Test Files  2 passed (2)\n      Tests  5 passed (5)\n';
    expect(compressOutput(passing, { source: 'b' }).status).toBe('success');
    expect(compressOutput(PYTEST_FAIL, { source: 'b', exitCode: null }).status).toBe('failure');
    expect(compressOutput('ok  \texample.com/calc\t0.004s\n', { source: 'b' }).status).toBe('success');
  });

  it("is 'unknown' when neither is available", () => {
    expect(compressOutput('building...\ndone\n', { source: 'b' }).status).toBe('unknown');
    expect(compressOutput('', { source: 'b' })).toMatchObject({ status: 'unknown', totalLines: 0, findings: [] });
  });
});

describe('compressAndStore', () => {
  let root: string;
  let rt: Runtime;
  beforeEach(() => {
    delete process.env.KILAMU_DATA_DIR;
    root = mkdtempSync(join(tmpdir(), 'kilamu-cmp-'));
    rt = openRuntime({ root, create: true });
  });
  afterEach(() => {
    rt.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('stores the output, persists the summary and gives a retrievable range', () => {
    const store = new ArtifactStore(rt);
    const s = compressAndStore(store, PYTEST_FAIL, { source: 'bash', command: 'pytest -q', exitCode: 1, taskId: 'T1' });
    expect(s.artifactId).toMatch(/^a_[0-9a-f]{16}$/);
    const m = s.retrieval.match(/^kilamu artifact show (a_[0-9a-f]{16}) --lines (\d+)-(\d+)$/);
    expect(m).not.toBeNull();
    expect(m![1]).toBe(s.artifactId);
    const slice = store.read(s.artifactId, Number(m![2]), Number(m![3]));
    expect(slice.content).toContain('test_divide');
    expect(store.get(s.artifactId).ref.summary).toEqual(s);
    expect(store.list({ taskId: 'T1' })).toHaveLength(1);
    const rendered = renderSummary(s);
    expect(rendered).toContain(s.retrieval);
    expect(rendered).toContain('ESTIMATED');
  });

  it('keeps line ranges aligned with the stored (redacted) artifact', () => {
    const pem = ['-----BEGIN RSA PRIVATE KEY-----', 'MIIBOgIBAAJBAK', 'abcdef', '-----END RSA PRIVATE KEY-----'].join('\n');
    const text = `${pem}\nstep ok\nERROR: disk full\n`;
    const store = new ArtifactStore(rt);
    const s = compressAndStore(store, text, { source: 'bash' });
    const f = s.findings.find((x) => x.text.includes('disk full'))!;
    expect(store.read(s.artifactId, f.lineStart, f.lineEnd).content).toBe('ERROR: disk full');
  });
});
