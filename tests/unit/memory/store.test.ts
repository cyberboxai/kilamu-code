import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sha256 } from '../../../src/core/ids.ts';
import { MemoryStore, type MemoryInput } from '../../../src/memory/store.ts';
import { openRuntime, type Runtime } from '../../../src/runtime.ts';

const FAKE_KEY = `sk-ant-api03-${'M1n2B3v4C5'.repeat(4)}`;
const CACHE_SRC = 'export const TTL = 60;\n';

const opened: Array<{ root: string; rt: Runtime }> = [];

function project(): { root: string; rt: Runtime; store: MemoryStore } {
  const root = mkdtempSync(join(tmpdir(), 'kilamu-mem-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src/cache.ts'), CACHE_SRC);
  writeFileSync(join(root, '.env'), 'X=1\n');
  const rt = openRuntime({ root, create: true });
  opened.push({ root, rt });
  return { root, rt, store: new MemoryStore(rt) };
}

function input(over: Partial<MemoryInput> = {}): MemoryInput {
  return {
    category: 'technical',
    scope: 'src/cache.ts',
    description: 'Cache TTL must stay below the session timeout',
    problem: 'Stale sessions were served from cache after logout',
    solution: 'Keep TTL at 60s and invalidate on logout',
    sources: [{ path: 'src/cache.ts', lineStart: 1, lineEnd: 1 }],
    ...over,
  };
}

let p: ReturnType<typeof project>;

beforeEach(() => {
  delete process.env.KILAMU_DATA_DIR;
  p = project();
});

afterEach(() => {
  for (const { root, rt } of opened.splice(0)) {
    rt.close();
    rmSync(root, { recursive: true, force: true });
  }
});

describe('MemoryStore.add', () => {
  it('records an UNVERIFIED item with hashed, project-relative sources', () => {
    const m = p.store.add(input({ sources: [{ path: join(p.root, 'src/cache.ts') }] }));
    expect(m.id).toMatch(/^m_/);
    expect(m.validation).toBe('UNVERIFIED');
    expect(m.confidence).toBe(0.5);
    expect(m.sources).toEqual([{ path: 'src/cache.ts', sha256: sha256(CACHE_SRC) }]);
    expect(p.store.get(m.id)).toEqual(m);
    expect(p.store.add(input({ sources: [{ path: 'src/not-yet.ts' }] })).sources[0]!.sha256).toBeNull();
  });

  it('rejects secrets in any text field and stores nothing', () => {
    expect(() => p.store.add(input({ solution: `Set ANTHROPIC_API_KEY to ${FAKE_KEY}` })))
      .toThrow(expect.objectContaining({ code: 'SECRET_DETECTED' }));
    expect(() => p.store.add(input({ evidence: [`curl -H "x-api-key: ${FAKE_KEY}"`] })))
      .toThrow(expect.objectContaining({ code: 'SECRET_DETECTED' }));
    expect(p.store.list()).toHaveLength(0);
  });

  it('rejects sensitive and escaping sources', () => {
    expect(() => p.store.add(input({ sources: [{ path: '.env' }] }))).toThrow(expect.objectContaining({ code: 'SENSITIVE_PATH' }));
    expect(() => p.store.add(input({ sources: [{ path: '../outside.ts' }] }))).toThrow(expect.objectContaining({ code: 'UNSAFE_PATH' }));
    expect(() => p.store.add(input({ sources: [{ path: 'src/cache.ts', lineStart: 5, lineEnd: 2 }] })))
      .toThrow(expect.objectContaining({ code: 'MEMORY_INVALID' }));
  });

  it('caps field lengths to stop transcript dumping', () => {
    expect(() => p.store.add(input({ solution: 'x'.repeat(4001) }))).toThrow(expect.objectContaining({ code: 'MEMORY_INVALID' }));
    expect(() => p.store.add(input({ description: '' }))).toThrow(expect.objectContaining({ code: 'MEMORY_INVALID' }));
    expect(() => p.store.add(input({ confidence: 1.5 }))).toThrow(expect.objectContaining({ code: 'MEMORY_INVALID' }));
  });

  it('denies a pattern without evidence or below the promotion confidence', () => {
    expect(() => p.store.add(input({ category: 'pattern', confidence: 0.95 }))).toThrow(expect.objectContaining({ code: 'PROMOTION_DENIED' }));
    expect(() => p.store.add(input({ category: 'pattern', evidence: ['vr_1'], confidence: 0.5 })))
      .toThrow(expect.objectContaining({ code: 'PROMOTION_DENIED' }));
    expect(p.store.add(input({ category: 'pattern', evidence: ['vr_1'], confidence: 0.9 })).category).toBe('pattern');
  });
});

describe('validate → promote', () => {
  it('promotes only after verification with enough evidence and confidence', () => {
    const m = p.store.add(input({ confidence: 0.85 }));
    expect(() => p.store.promote(m.id)).toThrow(expect.objectContaining({
      code: 'PROMOTION_DENIED',
      message: expect.stringMatching(/must be VERIFIED.*at least 2 evidence/),
    }));

    const v1 = p.store.validate(m.id, ['vr_001']);
    expect(v1).toMatchObject({ validation: 'VERIFIED', evidence: ['vr_001'], confidence: 0.85 });
    expect(() => p.store.promote(m.id)).toThrow(expect.objectContaining({ code: 'PROMOTION_DENIED', message: expect.stringMatching(/has 1/) }));

    p.store.validate(m.id, ['vr_002', 'vr_001']);
    const promoted = p.store.promote(m.id);
    expect(promoted).toMatchObject({ category: 'pattern', validation: 'VERIFIED', evidence: ['vr_001', 'vr_002'] });
    expect(p.store.get(m.id)!.category).toBe('pattern');
  });

  it('bumps confidence to at least 0.7 but that alone does not reach the promotion threshold', () => {
    const m = p.store.add(input({ confidence: 0.2 }));
    expect(p.store.validate(m.id, ['vr_1']).confidence).toBe(0.7);
    p.store.validate(m.id, ['vr_2']);
    expect(() => p.store.promote(m.id)).toThrow(expect.objectContaining({ code: 'PROMOTION_DENIED', message: expect.stringMatching(/below promotion threshold 0.8/) }));
  });

  it('requires evidence to validate and refuses project memories and invalidated items', () => {
    const m = p.store.add(input({ category: 'project', confidence: 0.9 }));
    expect(() => p.store.validate(m.id, [])).toThrow(expect.objectContaining({ code: 'MEMORY_INVALID' }));
    p.store.validate(m.id, ['a', 'b']);
    expect(() => p.store.promote(m.id)).toThrow(expect.objectContaining({ code: 'PROMOTION_DENIED', message: expect.stringMatching(/category project/) }));
    p.store.invalidate(m.id, 'superseded by ADR-007');
    expect(() => p.store.validate(m.id, ['c'])).toThrow(expect.objectContaining({ code: 'MEMORY_STATE' }));
    expect(() => p.store.validate('m_doesnotexist000', ['c'])).toThrow(expect.objectContaining({ code: 'MEMORY_NOT_FOUND' }));
  });
});

describe('staleness and relevance', () => {
  it('marks items STALE when a source changes or disappears, recording the reason', () => {
    const changed = p.store.add(input());
    const removed = p.store.add(input({ description: 'DB helper', sources: [{ path: 'src/db.ts' }] }));
    writeFileSync(join(p.root, 'src/db.ts'), 'x');
    const tracked = p.store.add(input({ description: 'DB helper (present)', sources: [{ path: 'src/db.ts' }] }));
    const noSources = p.store.add(input({ description: 'No sources', sources: [] }));
    expect(p.store.checkStaleness()).toEqual({ checked: 3, stale: [removed.id].sort() });

    writeFileSync(join(p.root, 'src/cache.ts'), 'export const TTL = 3600;\n');
    rmSync(join(p.root, 'src/db.ts'));
    const res = p.store.checkStaleness();
    expect(res.checked).toBe(2);
    expect(res.stale.sort()).toEqual([changed.id, tracked.id].sort());
    const c = p.store.get(changed.id)!;
    expect(c.validation).toBe('STALE');
    expect(c.invalidationConditions.at(-1)).toMatch(/\[STALE\]: source src\/cache\.ts changed/);
    expect(p.store.get(tracked.id)!.invalidationConditions.at(-1)).toMatch(/src\/db\.ts is missing/);
    expect(p.store.get(noSources.id)!.validation).toBe('UNVERIFIED');
  });

  it('excludes STALE and INVALIDATED items from relevant(), VERIFIED first', () => {
    const plain = p.store.add(input({ description: 'cache eviction order', confidence: 0.9 }));
    const verified = p.store.add(input({ description: 'cache warmup', sources: [], confidence: 0.3 }));
    p.store.validate(verified.id, ['vr_1']);
    const gone = p.store.add(input({ description: 'cache legacy flag', sources: [] }));
    p.store.invalidate(gone.id, 'flag removed');
    expect(p.store.relevant('cache', 10).map((m) => m.id)).toEqual([verified.id, plain.id]);

    writeFileSync(join(p.root, 'src/cache.ts'), 'changed\n');
    p.store.checkStaleness();
    expect(p.store.relevant('cache', 10).map((m) => m.id)).toEqual([verified.id]);
    expect(p.store.relevant('unrelated-term', 10)).toEqual([]);
  });

  it('cannot promote an item whose sources changed', () => {
    const m = p.store.add(input({ confidence: 0.9 }));
    p.store.validate(m.id, ['a', 'b']);
    writeFileSync(join(p.root, 'src/cache.ts'), 'changed\n');
    expect(() => p.store.promote(m.id)).toThrow(expect.objectContaining({ code: 'PROMOTION_DENIED', message: expect.stringMatching(/sources changed/) }));
  });
});

describe('search and list', () => {
  it('uses parameterised LIKE with wildcards escaped', () => {
    const pct = p.store.add(input({ description: 'Coverage must stay at 100% for auth', sources: [] }));
    p.store.add(input({ description: 'Plain item', sources: [] }));
    expect(p.store.search('100%', 10).map((m) => m.id)).toEqual([pct.id]);
    expect(p.store.search('%', 10).map((m) => m.id)).toEqual([pct.id]);
    expect(p.store.search("'; DROP TABLE memory_items; --", 10)).toEqual([]);
    expect(p.store.list()).toHaveLength(2);
  });

  it('filters lists by category, validation and scope', () => {
    const a = p.store.add(input({ category: 'execution', scope: 'exec_1', sources: [] }));
    p.store.add(input({ sources: [] }));
    expect(p.store.list({ category: 'execution' }).map((m) => m.id)).toEqual([a.id]);
    expect(p.store.list({ scope: 'exec_1' }).map((m) => m.id)).toEqual([a.id]);
    expect(p.store.list({ validation: 'VERIFIED' })).toEqual([]);
  });
});

describe('export / import', () => {
  it('writes one markdown file per category into the memory dir', () => {
    const m = p.store.add(input());
    p.store.validate(m.id, ['vr_9']);
    const files = p.store.exportMarkdown();
    expect(files.map((f) => f.slice(p.rt.paths.memoryDir.length + 1)).sort()).toEqual(
      ['execution.md', 'pattern.md', 'project.md', 'technical.md'],
    );
    const tech = readFileSync(join(p.rt.paths.memoryDir, 'technical.md'), 'utf8');
    expect(tech).toContain('## Cache TTL must stay below the session timeout');
    expect(tech).toContain('**status:** VERIFIED');
    expect(tech).toContain('- vr_9');
    expect(tech).toContain('`src/cache.ts:1-1`');
    expect(readFileSync(join(p.rt.paths.memoryDir, 'pattern.md'), 'utf8')).toContain('_No entries._');
    expect(statSync(join(p.rt.paths.memoryDir, 'technical.md')).mode & 0o777).toBe(0o600);
    expect(() => p.store.exportMarkdown('../outside')).toThrow(expect.objectContaining({ code: 'UNSAFE_PATH' }));
  });

  it('round-trips through JSON into a fresh project', () => {
    const a = p.store.add(input({ evidence: ['vr_1'], invalidationConditions: ['TTL config changes'] }));
    p.store.validate(a.id, ['vr_2']);
    p.store.add(input({ category: 'execution', scope: 'exec_9', sources: [] }));
    const exported = JSON.parse(JSON.stringify(p.store.exportJson()));

    const q = project();
    expect(q.store.importJson(exported)).toEqual({ imported: exported.map((m: { id: string }) => m.id), stale: [] });
    expect(q.store.exportJson()).toEqual(exported);
  });

  it('rejects duplicates and invalid items atomically', () => {
    const a = p.store.add(input({ sources: [] }));
    const exported = p.store.exportJson();
    expect(() => p.store.importJson(exported)).toThrow(expect.objectContaining({ code: 'MEMORY_DUPLICATE' }));
    expect(() => p.store.importJson([...exported, ...exported])).toThrow(expect.objectContaining({ code: 'MEMORY_DUPLICATE' }));

    const q = project();
    const tainted = [{ ...exported[0]!, id: 'm_0000000001aaaaaaaa' }, { ...exported[0]!, id: 'm_0000000001bbbbbbbb', solution: `use ${FAKE_KEY}` }];
    expect(() => q.store.importJson(tainted)).toThrow(expect.objectContaining({ code: 'SECRET_DETECTED' }));
    expect(() => q.store.importJson([{ ...exported[0]!, id: '../../x' }])).toThrow(expect.objectContaining({ code: 'MEMORY_INVALID' }));
    expect(() => q.store.importJson([{ ...exported[0]!, sources: [{ path: '.env', sha256: null }] }]))
      .toThrow(expect.objectContaining({ code: 'SENSITIVE_PATH' }));
    expect(q.store.exportJson()).toEqual([]);
    expect(a.id).toBe(exported[0]!.id);
  });

  it('imports items whose sources no longer match as STALE', () => {
    const a = p.store.add(input());
    const exported = p.store.exportJson();
    const q = project();
    writeFileSync(join(q.root, 'src/cache.ts'), 'different\n');
    expect(q.store.importJson(exported)).toEqual({ imported: [a.id], stale: [a.id] });
    expect(q.store.get(a.id)!.validation).toBe('STALE');
  });
});
