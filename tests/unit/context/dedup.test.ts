import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ReadTracker } from '../../../src/context/dedup.ts';
import { openRuntime, type Runtime } from '../../../src/runtime.ts';

let root: string;
let rt: Runtime;

beforeEach(() => {
  delete process.env.KILAMU_DATA_DIR;
  root = mkdtempSync(join(tmpdir(), 'kilamu-dedup-'));
  rt = openRuntime({ root, create: true });
});

afterEach(() => {
  rt.close();
  rmSync(root, { recursive: true, force: true });
});

describe('ReadTracker', () => {
  it('reports unseen files', () => {
    expect(new ReadTracker(rt.db).check('s1', 'src/a.ts', 'h1')).toEqual({ seen: false, sameContent: false, count: 0 });
  });

  it('detects duplicate reads of unchanged content', () => {
    const t = new ReadTracker(rt.db);
    t.recordRead('s1', 'src/a.ts', 'h1');
    expect(t.check('s1', 'src/a.ts', 'h1')).toEqual({ seen: true, sameContent: true, count: 1 });
    t.recordRead('s1', 'src/a.ts', 'h1');
    expect(t.check('s1', 'src/a.ts', 'h1').count).toBe(2);
  });

  it('flags changed or unknown content as not the same', () => {
    const t = new ReadTracker(rt.db);
    t.recordRead('s1', 'src/a.ts', 'h1');
    expect(t.check('s1', 'src/a.ts', 'h2').sameContent).toBe(false);
    expect(t.check('s1', 'src/a.ts', null).sameContent).toBe(false);
    t.recordRead('s1', 'src/b.ts', null);
    expect(t.check('s1', 'src/b.ts', null)).toEqual({ seen: true, sameContent: false, count: 1 });
    // The latest hash wins after a re-read.
    t.recordRead('s1', 'src/a.ts', 'h2');
    expect(t.check('s1', 'src/a.ts', 'h2').sameContent).toBe(true);
  });

  it('isolates sessions and computes stats', () => {
    const t = new ReadTracker(rt.db);
    t.recordRead('s1', 'a', 'x');
    t.recordRead('s1', 'a', 'x');
    t.recordRead('s1', 'a', 'x');
    t.recordRead('s1', 'b', 'y');
    t.recordRead('s2', 'a', 'x');
    expect(t.stats('s1')).toEqual({ files: 2, totalReads: 4, duplicateReads: 2 });
    expect(t.stats('s2')).toEqual({ files: 1, totalReads: 1, duplicateReads: 0 });
    expect(t.stats('none')).toEqual({ files: 0, totalReads: 0, duplicateReads: 0 });
    expect(t.check('s2', 'b', 'y').seen).toBe(false);
  });

  it('rejects empty keys', () => {
    const t = new ReadTracker(rt.db);
    expect(() => t.recordRead('', 'a', null)).toThrow(expect.objectContaining({ code: 'READ_INVALID' }));
    expect(() => t.check('s', ' ', null)).toThrow(expect.objectContaining({ code: 'READ_INVALID' }));
  });
});
