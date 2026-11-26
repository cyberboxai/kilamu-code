import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Runtime } from '../../../src/runtime.ts';
import { chunkText } from '../../../src/knowledge/chunker.ts';
import { Indexer, LINK_CONFIDENCE, snakeCase } from '../../../src/knowledge/indexer.ts';
import { KnowledgeGraph } from '../../../src/knowledge/query.ts';
import { memoryRuntime, tempProject } from './helpers.ts';

let rt: Runtime | null = null;
let cleanup: (() => void) | null = null;
afterEach(() => {
  rt?.close();
  cleanup?.();
  rt = null;
  cleanup = null;
});

function setup(files: Record<string, string | Buffer>) {
  const p = tempProject(files);
  cleanup = p.cleanup;
  rt = memoryRuntime(p.root);
  return { p, rt, indexer: new Indexer(rt), kg: new KnowledgeGraph(rt.db) };
}

const count = (r: Runtime, sql: string, ...args: string[]) => Number((r.db.prepare(sql).get(...args) as { n: number }).n);

describe('chunkText', () => {
  it('uses 40-line windows with 5-line overlap', () => {
    const text = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n');
    expect(chunkText(text).map((c) => [c.lineStart, c.lineEnd])).toEqual([[1, 40], [36, 75], [71, 100]]);
  });

  it('skips blank windows and handles short files', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('one\ntwo\n').map((c) => [c.lineStart, c.lineEnd])).toEqual([[1, 2]]);
  });
});

describe('Indexer incremental behaviour', () => {
  it('indexes, skips unchanged, reindexes changed and removes deleted files', async () => {
    const { p, rt: r, indexer, kg } = setup({
      'src/a.ts': 'export function alpha() {}\n',
      'src/b.ts': "import { alpha } from './a';\nexport const beta = alpha;\n",
      'README.md': '# Readme\n',
    });

    const first = await indexer.index();
    expect(first).toMatchObject({ scanned: 3, indexed: 3, unchanged: 0, removed: 0, errors: 0 });
    expect(first.byLanguage).toEqual({ typescript: 2, markdown: 1 });
    expect(kg.findSymbols('alpha')[0]).toMatchObject({ path: 'src/a.ts', kind: 'function' });
    expect(kg.neighbors('file:src/a.ts', 'in')).toEqual([expect.objectContaining({ src: 'file:src/b.ts', rel: 'IMPORTS' })]);

    const second = await indexer.index();
    expect(second).toMatchObject({ scanned: 3, indexed: 0, unchanged: 3, removed: 0 });

    p.write('src/a.ts', 'export function gamma() {}\n');
    const third = await indexer.index();
    expect(third).toMatchObject({ indexed: 1, unchanged: 2 });
    expect(kg.findSymbols('alpha')).toEqual([]);
    expect(kg.findSymbols('gamma')).toHaveLength(1);
    expect(count(r, 'SELECT COUNT(*) AS n FROM symbols WHERE path = ?', 'src/a.ts')).toBe(1);
    expect(count(r, 'SELECT COUNT(*) AS n FROM chunks_fts WHERE path = ?', 'src/a.ts')).toBe(1);

    rmSync(join(p.root, 'src/b.ts'));
    const fourth = await indexer.index();
    expect(fourth).toMatchObject({ removed: 1, unchanged: 2 });
    expect(kg.fileInfo('src/b.ts')).toBeNull();
    expect(count(r, 'SELECT COUNT(*) AS n FROM edges WHERE path = ?', 'src/b.ts')).toBe(0);
    expect(count(r, 'SELECT COUNT(*) AS n FROM chunks_fts WHERE path = ?', 'src/b.ts')).toBe(0);
    expect(count(r, 'SELECT COUNT(*) AS n FROM symbols WHERE path = ?', 'src/b.ts')).toBe(0);
  });

  it('reindexes a file when its stored parser version differs', async () => {
    const { rt: r, indexer } = setup({ 'a.py': 'def f():\n    pass\n', 'b.py': 'x = 1\n' });
    await indexer.index();
    r.db.prepare('UPDATE files SET parser_version = parser_version - 1 WHERE path = ?').run('a.py');
    const again = await indexer.index();
    expect(again).toMatchObject({ indexed: 1, unchanged: 1 });
    expect(count(r, 'SELECT COUNT(*) AS n FROM symbols WHERE path = ?', 'a.py')).toBe(1);
  });

  it('rebuild reprocesses everything; paths restricts scope', async () => {
    const { p, indexer, kg } = setup({ 'a/x.ts': 'export const x = 1;\n', 'b/y.ts': 'export const y = 1;\n' });
    await indexer.index();
    expect(await indexer.index({ rebuild: true })).toMatchObject({ indexed: 2, unchanged: 0 });

    p.write('a/x.ts', 'export const x2 = 1;\n');
    p.write('b/y.ts', 'export const y2 = 1;\n');
    expect(await indexer.index({ paths: ['a'] })).toMatchObject({ scanned: 1, indexed: 1 });
    expect(kg.findSymbols('x2')).toHaveLength(1);
    expect(kg.findSymbols('y')).toHaveLength(1);
    await expect(indexer.index({ paths: ['../outside'] })).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
  });

  it('rejects concurrent runs on one indexer', async () => {
    const { indexer } = setup({ 'a.ts': 'export const a = 1;\n' });
    const first = indexer.index();
    await expect(indexer.index()).rejects.toMatchObject({ code: 'INDEX_BUSY' });
    await first;
  });

  it('never stores sensitive files', async () => {
    const { rt: r, indexer } = setup({ '.env': 'API_KEY=abcdefgh12345678\n', 'ok.ts': 'export const ok = 1;\n' });
    const stats = await indexer.index();
    expect(stats.skipped).toBe(1);
    expect(count(r, 'SELECT COUNT(*) AS n FROM files WHERE path = ?', '.env')).toBe(0);
  });
});

describe('redaction', () => {
  it('redacts secrets in FTS chunks and symbol signatures', async () => {
    const secret = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789';
    const { rt: r, indexer, kg } = setup({ 'src/config.ts': `export const ANTHROPIC = "${secret}";\nconst password = "hunter2hunter2";\n` });
    await indexer.index();
    const contents = (r.db.prepare('SELECT content FROM chunks_fts').all() as Array<{ content: string }>).map((c) => c.content).join('\n');
    expect(contents).not.toContain(secret);
    expect(contents).not.toContain('hunter2hunter2');
    expect(contents).toContain('[REDACTED:anthropic-key]');
    expect(kg.findSymbols('ANTHROPIC')[0]?.signature).not.toContain(secret);
    expect(kg.search('hunter2hunter2')).toEqual([]);
  });
});

describe('cross-layer column linking', () => {
  it('links code identifiers to SQL columns and recomputes when columns change', async () => {
    const { p, rt: r, indexer } = setup({
      'schema.sql': 'CREATE TABLE accounts (account_id INT PRIMARY KEY, name TEXT);\n',
      'src/a.ts': 'export function load(accountId: number) { return accountId; }\n',
      'src/b.py': 'def balance(account_id):\n    return account_id\n',
      'src/c.ts': 'export const nothing = 1;\n',
    });
    await indexer.index();
    const links = () => (r.db.prepare('SELECT src, dst, line, confidence FROM edges WHERE confidence = ? ORDER BY src, dst').all(LINK_CONFIDENCE) as Array<{ src: string; dst: string }>);
    expect(links().map((l) => [l.src, l.dst])).toEqual([
      ['file:src/a.ts', 'column:accounts.account_id'],
      ['file:src/b.py', 'column:accounts.account_id'],
    ]);

    p.write('schema.sql', 'CREATE TABLE accounts (account_id INT PRIMARY KEY, nothing_here INT);\nALTER TABLE accounts ADD COLUMN nothing INT;\n');
    await indexer.index();
    expect(links().map((l) => [l.src, l.dst])).toEqual([
      ['file:src/a.ts', 'column:accounts.account_id'],
      ['file:src/b.py', 'column:accounts.account_id'],
      ['file:src/c.ts', 'column:accounts.nothing'],
    ]);
  });

  it('snake-cases identifiers', () => {
    expect(snakeCase('customerId')).toBe('customer_id');
    expect(snakeCase('CustomerID')).toBe('customer_id');
    expect(snakeCase('CUSTOMER_ID')).toBe('customer_id');
    expect(snakeCase('HTTPServerError')).toBe('http_server_error');
  });
});

describe('PDF indexing', () => {
  it('marks PDFs SKIPPED when pdftotext is unavailable, then indexes once available', async () => {
    const { rt: r, indexer, kg } = setup({ 'docs/spec.pdf': Buffer.from('%PDF-1.4 not really a pdf') });
    const internals = indexer as unknown as { pdfAvailable: boolean | null };
    internals.pdfAvailable = false;
    const first = await indexer.index();
    expect(first).toMatchObject({ skipped: 1, indexed: 0 });
    expect(r.db.prepare('SELECT status, detail, parser FROM files').get()).toEqual({ status: 'SKIPPED', detail: 'pdftotext unavailable', parser: 'none' });
    expect(kg.coverage()).toEqual([{ language: 'pdf', files: 1, parser: 'none', parserVersion: 0, confidence: 'unsupported' }]);

    internals.pdfAvailable = true;
    const second = await indexer.index();
    // The parser identity changed, so the file is reprocessed (this fake PDF fails to parse).
    expect(second.unchanged).toBe(0);
    expect(second.indexed + second.errors).toBe(1);
  });
});
