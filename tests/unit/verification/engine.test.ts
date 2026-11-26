import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openRuntime, type Runtime } from '../../../src/runtime.ts';
import { getRun, latestRun, renderReport, VerificationEngine } from '../../../src/verification/engine.ts';
import type { AcceptanceCriterion, ArtifactSink, TaskRecord } from '../../../src/core/types.ts';

let root: string;
let rt: Runtime;
let puts: Array<{ content: string; meta: Parameters<ArtifactSink['put']>[1] }>;
let engine: VerificationEngine;

const sink: ArtifactSink = {
  put(content, meta) {
    puts.push({ content, meta });
    return { id: `art_${puts.length}`, kind: meta.kind, bytes: content.length, lines: 1, source: meta.source, createdAt: '' };
  },
};

function task(acceptance: AcceptanceCriterion[], outputArtifacts: string[] = []): TaskRecord {
  return {
    executionId: 'ex1', id: 'T1', title: 't', description: 'd', role: 'developer', taskClass: 'implementation',
    complexity: 'small', priority: 1, dependsOn: [], files: [], inputs: [], expectedOutput: '', acceptance,
    maxRetries: 1, status: 'VERIFYING', owner: null, attempts: 0, checkpointId: null, resultSummary: null,
    outputArtifacts, createdAt: '', updatedAt: '',
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kil-verify-'));
  writeFileSync(join(root, 'fail.js'), 'console.log("boom"); process.exit(1);');
  writeFileSync(join(root, 'ok.js'), 'console.log(process.version);');
  writeFileSync(join(root, 'sleep.js'), 'setTimeout(() => {}, 20000);');
  writeFileSync(join(root, 'hello.txt'), 'hello world\n');
  rt = openRuntime({ root, create: true });
  puts = [];
  engine = new VerificationEngine(rt, sink);
});
afterEach(() => {
  rt.close();
  rmSync(root, { recursive: true, force: true });
});

const cmd = (command: string, extra: Partial<Extract<AcceptanceCriterion, { kind: 'command' }>> = {}): AcceptanceCriterion => ({
  id: 'c1', kind: 'command', command, ...extra,
});

describe('command criteria', () => {
  it('passes a succeeding command and stores output as an artifact', async () => {
    const r = await engine.verifyTask(task([cmd('node ok.js')]));
    expect(r.results[0]?.status).toBe('PASS');
    expect(r.verdict).toBe('VERIFIED');
    expect(r.results[0]?.artifactId).toBe('art_1');
    expect(puts[0]?.meta).toMatchObject({ kind: 'command-output', source: 'node ok.js', executionId: 'ex1', taskId: 'T1' });
    expect(puts[0]?.content).toMatch(/^v\d+/);
  });

  it('fails a non-zero exit', async () => {
    const r = await engine.verifyTask(task([cmd('node fail.js')]));
    expect(r.results[0]).toMatchObject({ status: 'FAIL', exitCode: 1 });
    expect(r.verdict).toBe('FAILED');
    expect(puts[0]?.content).toContain('boom');
  });

  it('rejects programs outside the allowlist', async () => {
    const r = await engine.verifyTask(task([cmd('curl http://example.com')]));
    expect(r.results[0]?.status).toBe('ERROR');
    expect(r.results[0]?.detail).toMatch(/^not allowed: /);
  });

  it.each([
    'node -e 1', 'node --eval=1', 'node -pe 1', 'node --import x.js ok.js', 'node -r ./x ok.js', 'node /tmp/x.js',
    'python3 -c pass', "python3 '-cimport os'", 'python3 -Ic pass', 'python3 -m http.server',
    'npx -y cowsay', 'npx cowsay', 'npm exec --yes cowsay', "npm exec -c 'id'", 'pnpm dlx cowsay',
    "git -c 'alias.x=!id' x", 'docker run alpine', 'make -f /abs/Makefile', 'deno eval 1', 'php -r 1', 'bun -e 1',
    'go test -exec /bin/sh ./...', 'cargo --config runner=x test', 'sh -c id',
  ])('rejects arbitrary-code vector: %s', async (c) => {
    const r = await engine.verifyTask(task([cmd(c)]));
    expect(r.results[0]?.status).toBe('ERROR');
    expect(puts).toHaveLength(0);
  });

  it('rejects shell metacharacters', async () => {
    const r = await engine.verifyTask(task([cmd('node --version; rm -rf x')]));
    expect(r.results[0]?.status).toBe('ERROR');
    expect(r.results[0]?.detail).toMatch(/metacharacter/);
  });

  it('times out', async () => {
    const r = await engine.verifyTask(task([cmd('node sleep.js', { timeoutSec: 1 })]));
    expect(r.results[0]).toMatchObject({ status: 'FAIL', detail: 'timed out after 1s' });
  });

  it('errors when cwd escapes the root', async () => {
    const r = await engine.verifyTask(task([cmd('node ok.js', { cwd: '../..' })]));
    expect(r.results[0]?.status).toBe('ERROR');
  });

  it('dry run skips execution and is never VERIFIED', async () => {
    const r = await engine.verifyTask(task([cmd('node fail.js')]), { dryRun: true });
    expect(r.results[0]?.status).toBe('SKIPPED');
    expect(r.results[0]?.detail).toMatch(/^dry run: would execute/);
    expect(r.verdict).toBe('FAILED');
    expect(puts).toHaveLength(0);
    expect(latestRun(rt.db, 'ex1', 'T1')).toBeNull();
  });
});

describe('file and artifact criteria', () => {
  it('file_exists passes and fails; path escape is ERROR', async () => {
    const r = await engine.verifyTask(task([
      { id: 'a', kind: 'file_exists', path: 'hello.txt' },
      { id: 'b', kind: 'file_exists', path: 'nope.txt' },
      { id: 'c', kind: 'file_exists', path: '../../etc/passwd' },
    ]));
    expect(r.results.map((x) => x.status)).toEqual(['PASS', 'FAIL', 'ERROR']);
  });

  it('file_contains handles substring, regex, miss and invalid regex', async () => {
    const r = await engine.verifyTask(task([
      { id: 'a', kind: 'file_contains', path: 'hello.txt', pattern: 'hello' },
      { id: 'b', kind: 'file_contains', path: 'hello.txt', pattern: '^hel+o\\s', regex: true },
      { id: 'c', kind: 'file_contains', path: 'hello.txt', pattern: 'absent' },
      { id: 'd', kind: 'file_contains', path: 'hello.txt', pattern: '(', regex: true },
      { id: 'e', kind: 'file_contains', path: 'missing.txt', pattern: 'x' },
    ]));
    expect(r.results.map((x) => x.status)).toEqual(['PASS', 'PASS', 'FAIL', 'ERROR', 'FAIL']);
  });

  it('artifact criterion needs output artifacts', async () => {
    const c: AcceptanceCriterion = { id: 'a', kind: 'artifact' };
    expect((await engine.verifyTask(task([c]))).results[0]?.status).toBe('FAIL');
    expect((await engine.verifyTask(task([c], ['art_x']))).results[0]?.status).toBe('PASS');
  });
});

describe('attestation and verdict', () => {
  const att: AcceptanceCriterion = { id: 'att', kind: 'attestation', description: 'reviewed by a human' };

  it('requires a non-empty note', async () => {
    const none = await engine.verifyTask(task([att]));
    expect(none.results[0]).toMatchObject({ status: 'FAIL', detail: 'attestation required: pass --attest att="note"' });
    const blank = await engine.verifyTask(task([att]), { attestations: { att: '   ' } });
    expect(blank.results[0]?.status).toBe('FAIL');
    const ok = await engine.verifyTask(task([att]), { attestations: { att: 'checked manually' } });
    expect(ok.results[0]?.status).toBe('ATTESTED');
    expect(ok.verdict).toBe('VERIFIED');
  });

  it('mixed PASS + FAIL is FAILED; no criteria is FAILED', async () => {
    const mixed = await engine.verifyTask(task([cmd('node ok.js'), { id: 'f', kind: 'file_exists', path: 'nope' }]));
    expect(mixed.verdict).toBe('FAILED');
    expect((await engine.verifyTask(task([]))).verdict).toBe('FAILED');
  });
});

describe('persistence and rendering', () => {
  it('persists runs bound to the attempt, latest and lookup', async () => {
    const a = await engine.verifyTask({ ...task([{ id: 'f', kind: 'file_exists', path: 'nope' }]), checkpointId: 'cp9' });
    const b = await engine.verifyTask(task([{ id: 'f', kind: 'file_exists', path: 'hello.txt' }]));
    expect(latestRun(rt.db, 'ex1', 'T1')?.runId).toBe(b.runId);
    expect(latestRun(rt.db, 'ex1', 'T1')?.verdict).toBe('VERIFIED');
    expect(getRun(rt.db, a.runId)).toEqual({ verdict: 'FAILED', executionId: 'ex1', taskId: 'T1', checkpointId: 'cp9' });
    expect(getRun(rt.db, 'vr_missing')).toBeNull();
  });

  it('renders details and artifact ids for non-PASS results', async () => {
    const r = await engine.verifyTask(task([cmd('node ok.js', { id: 'ok' }), cmd('node fail.js', { id: 'bad' })]));
    const text = renderReport(r);
    expect(text).toContain('TASK T1');
    expect(text).toContain('ok: PASS');
    expect(text).toContain('bad: FAIL');
    expect(text).toContain('artifact: art_2');
    expect(text).toContain('FINAL STATUS: FAILED');
  });
});

