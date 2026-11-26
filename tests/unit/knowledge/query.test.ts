import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Runtime } from '../../../src/runtime.ts';
import { Indexer } from '../../../src/knowledge/indexer.ts';
import { KnowledgeGraph, ftsPhrases, type ImpactReport } from '../../../src/knowledge/query.ts';
import { memoryRuntime, tempProject } from './helpers.ts';

const FIXTURE = join(import.meta.dirname, '../../fixtures/kg-customer-app');

describe('FTS search safety', () => {
  let rt: Runtime;
  let kg: KnowledgeGraph;
  let cleanup: () => void;
  beforeAll(async () => {
    const p = tempProject({
      'a.md': 'foo bar baz\n',
      'b.md': 'content of another file mentions OR and NEAR\n',
      'c.md': 'only qux here\n',
    });
    cleanup = p.cleanup;
    rt = memoryRuntime(p.root);
    await new Indexer(rt).index();
    kg = new KnowledgeGraph(rt.db);
  });
  afterAll(() => {
    rt.close();
    cleanup();
  });

  it('quotes every token as a phrase', () => {
    // "OR" is dropped as an English stopword; the remaining words are quoted phrases.
    expect(ftsPhrases('foo" OR content:*')).toEqual(['"foo"', '"content"']);
    // A query made only of stopwords keeps its words (still quoted, never operators).
    expect(ftsPhrases('or and the')).toEqual(['"or"', '"and"', '"the"']);
    expect(ftsPhrases('  ***  ')).toEqual([]);
  });

  it.each([
    'foo" OR content:*',
    'content:qux',
    '"unterminated',
    'NEAR(foo bar)',
    'foo AND NOT bar',
    '* ^ - + ( ) { } :',
    "'; DROP TABLE files; --",
    '',
  ])('does not throw or interpret operators: %s', (q) => {
    expect(() => kg.search(q)).not.toThrow();
  });

  it('treats operator words and syntax as plain terms', () => {
    // As FTS syntax `fo*` is a prefix query matching "foo"; as a phrase it is the absent token "fo".
    expect(kg.search('fo*')).toEqual([]);
    // As FTS syntax `foo NOT qux` matches a.md; as phrases it needs the literal token "NOT", then falls back to any term.
    expect(kg.search('mentions NOT').map((h) => h.path)).toEqual(['b.md']);
    expect(kg.search('mentions OR').map((h) => h.path)).toEqual(['b.md']);
    // The injection string only ever matches documents containing one of its literal words.
    expect(kg.search('foo" OR content:*').map((h) => h.path).sort()).toEqual(['a.md', 'b.md']);
  });

  it('returns ranked hits with snippets, falling back to any-term matching', () => {
    const hits = kg.search('baz');
    expect(hits).toEqual([expect.objectContaining({ path: 'a.md', lineStart: 1, lineEnd: 1 })]);
    expect(hits[0]!.snippet).toContain('«baz»');
    expect(kg.search('qux zzzunknown').map((h) => h.path)).toEqual(['c.md']);
  });
});

describe('impact (end-to-end on kg-customer-app)', () => {
  let rt: Runtime;
  let kg: KnowledgeGraph;
  let root: string;
  beforeAll(async () => {
    // Copy the fixture so nothing (not even a git probe side effect) touches the repo.
    root = mkdtempSync(join(tmpdir(), 'kilamu-kg-e2e-'));
    cpSync(FIXTURE, root, { recursive: true });
    rt = memoryRuntime(root);
    const stats = await new Indexer(rt).index();
    expect(stats.errors).toBe(0);
    kg = new KnowledgeGraph(rt.db);
  });
  afterAll(() => {
    rt.close();
    rmSync(root, { recursive: true, force: true });
  });

  const layerOf = (r: ImpactReport, path: string) => r.layers.find((l) => l.entries.some((e) => e.path === path))?.layer;

  it('orders affected files database → model → repository → service → api → frontend', () => {
    const report = kg.impact('customer_id');
    expect(report.seeds).toEqual(expect.arrayContaining(['column:customers.customer_id', 'column:orders.customer_id']));
    const layers = report.layers.map((l) => l.layer);
    const required = ['database', 'model', 'repository', 'service', 'api', 'frontend'];
    expect(layers.filter((l) => required.includes(l))).toEqual(required);
    expect(layers.indexOf('docs')).toBeGreaterThan(layers.indexOf('frontend'));

    expect(layerOf(report, 'db/migrations/001_create_customers.sql')).toBe('database');
    expect(layerOf(report, 'app/models/customer.py')).toBe('model');
    expect(layerOf(report, 'app/repositories/customer_repository.py')).toBe('repository');
    expect(layerOf(report, 'app/services/customer_service.py')).toBe('service');
    expect(layerOf(report, 'app/api/routes.py')).toBe('api');
    expect(layerOf(report, 'frontend/src/components/CustomerCard.tsx')).toBe('frontend');
    expect(layerOf(report, 'docs/customers.md')).toBe('docs');
  });

  it('carries via-chains, lines and heuristic confidences', () => {
    const report = kg.impact('customer_id');
    for (const { entries } of report.layers) {
      for (const e of entries) {
        expect(e.via.length).toBeGreaterThan(0);
        expect(e.line).toBeGreaterThan(0);
        expect(e.confidence).toBeGreaterThan(0);
        expect(e.confidence).toBeLessThan(1);
      }
    }
    const model = report.layers.find((l) => l.layer === 'model')!.entries[0]!;
    expect(model.via.at(-1)).toMatch(/^symbol:app\/models\/customer\.py#(Customer|Order) -READS-> column:/);
    const db = report.layers.find((l) => l.layer === 'database')!.entries[0]!;
    expect(db.confidence).toBeGreaterThan(model.confidence);
  });

  it('is deterministic', () => {
    expect(kg.impact('customer_id')).toEqual(kg.impact('customer_id'));
  });

  it('resolves symbol and file seeds and respects limit', () => {
    const bySymbol = kg.impact('CustomerRepository');
    expect(bySymbol.seeds).toContain('symbol:app/repositories/customer_repository.py#CustomerRepository');
    expect(layerOf(bySymbol, 'app/services/customer_service.py')).toBe('service');
    const limited = kg.impact('customer_id', { limit: 2 });
    expect(limited.layers.flatMap((l) => l.entries)).toHaveLength(2);
    expect(limited.truncated).toBe(true);
    expect(() => kg.impact('   ')).toThrow(/non-empty/);
  });

  it('reports coverage and stats', () => {
    const cov = kg.coverage();
    expect(cov).toEqual(expect.arrayContaining([
      { language: 'python', files: 9, parser: 'python-regex', parserVersion: 1, confidence: 'structural-heuristic' },
      { language: 'sql', files: 1, parser: 'sql-regex', parserVersion: 1, confidence: 'structural-heuristic' },
    ]));
    const s = kg.stats();
    expect(s).toMatchObject({ files: 12, indexed: 12, errors: 0 });
    expect(s.symbols).toBeGreaterThan(10);
    expect(s.edges).toBeGreaterThan(10);
    expect(s.chunks).toBeGreaterThan(0);
  });
});

describe('neighbors', () => {
  let cleanup: (() => void) | null = null;
  afterEach(() => cleanup?.());
  it('returns in, out and both directions', async () => {
    const p = tempProject({ 'a.ts': "import './b';\n", 'b.ts': "import './c';\n", 'c.ts': 'export const c = 1;\n' });
    cleanup = p.cleanup;
    const rt = memoryRuntime(p.root);
    await new Indexer(rt).index();
    const kg = new KnowledgeGraph(rt.db);
    expect(kg.neighbors('file:b.ts', 'out').map((e) => e.dst)).toEqual(['file:c.ts']);
    expect(kg.neighbors('file:b.ts', 'in').map((e) => e.src)).toEqual(['file:a.ts']);
    expect(kg.neighbors('file:b.ts', 'both')).toHaveLength(2);
    rt.close();
  });
});
