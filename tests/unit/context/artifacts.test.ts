import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ArtifactStore } from '../../../src/context/artifacts.ts';
import { openRuntime, type Runtime } from '../../../src/runtime.ts';

let root: string;
let rt: Runtime;
let store: ArtifactStore;

beforeEach(() => {
  delete process.env.KILAMU_DATA_DIR;
  root = mkdtempSync(join(tmpdir(), 'kilamu-art-'));
  rt = openRuntime({ root, create: true });
  store = new ArtifactStore(rt);
});

afterEach(() => {
  rt.close();
  rmSync(root, { recursive: true, force: true });
});

const FAKE_KEY = `sk-ant-api03-${'A1b2C3d4E5'.repeat(4)}`;

describe('ArtifactStore', () => {
  it('stores under the temp project, content-addressed, with owner-only permissions', () => {
    const ref = store.put('line1\nline2\nline3\n', { kind: 'log', source: 'test' });
    expect(ref.id).toMatch(/^a_[0-9a-f]{16}$/);
    expect(ref.lines).toBe(3);
    expect(ref.bytes).toBe(18);
    const file = join(rt.paths.artifactsDir, ref.id.slice(2, 4), `${ref.id}.txt`);
    expect(file.startsWith(root)).toBe(true);
    expect(existsSync(file)).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('dedups identical content', () => {
    const a = store.put('same content', { kind: 'log', source: 'one' });
    const b = store.put('same content', { kind: 'report', source: 'two' });
    expect(b.id).toBe(a.id);
    expect(b.source).toBe('one');
    expect(store.list()).toHaveLength(1);
  });

  it('redacts secrets before writing and hashing', () => {
    const ref = store.put(`export ANTHROPIC=${FAKE_KEY}\nok\n`, { kind: 'command-output', source: 'env' });
    const { content } = store.get(ref.id);
    expect(content).not.toContain(FAKE_KEY);
    expect(content).toContain('[REDACTED:anthropic-key]');
    // Same secret-bearing input dedups to the same redacted artifact.
    expect(store.put(`export ANTHROPIC=${FAKE_KEY}\nok\n`, { kind: 'log', source: 'x' }).id).toBe(ref.id);
  });

  it('rejects malformed ids before touching the filesystem', () => {
    for (const bad of ['../../etc/passwd', 'a_../../../x', 'a_0123456789abcdeg', 'a_0123', `a_${'0'.repeat(16)}/../x`]) {
      expect(() => store.get(bad)).toThrow(expect.objectContaining({ code: 'ARTIFACT_ID_INVALID' }));
      expect(() => store.read(bad)).toThrow(expect.objectContaining({ code: 'ARTIFACT_ID_INVALID' }));
      expect(() => store.remove(bad)).toThrow(expect.objectContaining({ code: 'ARTIFACT_ID_INVALID' }));
    }
  });

  it('reads 1-based inclusive line ranges and reports the total', () => {
    const text = Array.from({ length: 100 }, (_, i) => `row ${i + 1}`).join('\n');
    const ref = store.put(text, { kind: 'log', source: 'rows' });
    const slice = store.read(ref.id, 10, 12);
    expect(slice.content).toBe('row 10\nrow 11\nrow 12');
    expect(slice.totalLines).toBe(100);
    expect(store.read(ref.id, 99, 500)).toMatchObject({ content: 'row 99\nrow 100', lineEnd: 100 });
    expect(store.read(ref.id, 200).content).toBe('');
    expect(() => store.read(ref.id, 0, 3)).toThrow(expect.objectContaining({ code: 'RANGE_INVALID' }));
    expect(() => store.read(ref.id, 5, 4)).toThrow(expect.objectContaining({ code: 'RANGE_INVALID' }));
  });

  it('errors with ARTIFACT_MISSING when the row exists but the file is gone', () => {
    const ref = store.put('will vanish', { kind: 'log', source: 't' });
    rmSync(join(rt.paths.artifactsDir, ref.id.slice(2, 4), `${ref.id}.txt`));
    expect(() => store.get(ref.id)).toThrow(expect.objectContaining({ code: 'ARTIFACT_MISSING' }));
  });

  it('errors with ARTIFACT_NOT_FOUND for unknown well-formed ids', () => {
    expect(() => store.get('a_0123456789abcdef')).toThrow(expect.objectContaining({ code: 'ARTIFACT_NOT_FOUND' }));
  });

  it('lists with filters, stores summaries, removes and prunes', () => {
    const a = store.put('alpha', { kind: 'log', source: 's', executionId: 'e1', taskId: 'T1' });
    const b = store.put('beta', { kind: 'report', source: 's', executionId: 'e2' });
    expect(store.list({ executionId: 'e1' }).map((r) => r.id)).toEqual([a.id]);
    expect(store.list({ kind: 'report' }).map((r) => r.id)).toEqual([b.id]);
    expect(store.list({ taskId: 'T1' })).toHaveLength(1);

    store.setSummary(a.id, {
      artifactId: a.id, source: 's', totalLines: 1, totalBytes: 5, detectedFormat: 'generic', status: 'unknown',
      findings: [], retrieval: `kilamu artifact show ${a.id}`, estimatedTokensSaved: { value: 0, label: 'ESTIMATED', source: 'x' },
    });
    expect(store.get(a.id).ref.summary?.detectedFormat).toBe('generic');

    expect(store.remove(b.id)).toBe(true);
    expect(store.remove(b.id)).toBe(false);
    expect(store.prune({ olderThanDays: 1 })).toBe(0);
    rt.db.prepare('UPDATE artifacts SET created_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', a.id);
    expect(store.prune({ olderThanDays: 1 })).toBe(1);
    expect(store.list()).toHaveLength(0);
    expect(() => store.prune({ olderThanDays: -1 })).toThrow(expect.objectContaining({ code: 'ARTIFACT_INVALID' }));
  });

  it('rejects unknown kinds', () => {
    expect(() => store.put('x', { kind: 'bogus' as never, source: 's' })).toThrow(expect.objectContaining({ code: 'ARTIFACT_INVALID' }));
  });
});
