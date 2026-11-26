import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openRuntime, type Runtime } from '../../../src/runtime.ts';
import { ToolCache } from '../../../src/tools/cache.ts';
import { discoverMcp } from '../../../src/tools/mcp.ts';
import { recommendTools } from '../../../src/tools/select.ts';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kil-tools-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('discoverMcp', () => {
  it('returns names/transports/command basename and never leaks env, args or headers', () => {
    writeFileSync(join(root, '.mcp.json'), JSON.stringify({
      mcpServers: {
        pg: { command: '/usr/local/bin/postgres-mcp', args: ['--dsn', 'postgres://u:hunter2@h/db'], env: { API_KEY: 'secret' } },
        docs: { type: 'http', url: 'https://x.test/mcp', headers: { Authorization: 'Bearer topsecret' } },
        weird: {},
      },
    }));
    const d = discoverMcp(root);
    expect(d.sources).toEqual(['.mcp.json']);
    expect(d.servers).toEqual([
      { name: 'docs', transport: 'http' },
      { name: 'pg', transport: 'stdio', command: 'postgres-mcp' },
      { name: 'weird', transport: 'unknown' },
    ]);
    const dump = JSON.stringify(d);
    for (const leak of ['secret', 'hunter2', 'topsecret', '--dsn', 'API_KEY', 'Authorization']) expect(dump).not.toContain(leak);
    expect(d.note).toContain('claude mcp list');
  });

  it('handles missing or malformed files', () => {
    expect(discoverMcp(root).servers).toEqual([]);
    writeFileSync(join(root, '.mcp.json'), '{bad');
    expect(discoverMcp(root).servers).toEqual([]);
    writeFileSync(join(root, '.mcp.json'), '{"mcpServers": []}');
    expect(discoverMcp(root).servers).toEqual([]);
  });
});

describe('recommendTools', () => {
  it('is local-first per class', () => {
    expect(recommendTools('discovery', []).local).toEqual(expect.arrayContaining(['kilamu search', 'kilamu impact', 'Grep', 'Glob']));
    expect(recommendTools('verification', []).local).toContain('kilamu verify');
    expect(recommendTools('research', []).local).toContain('Read');
  });

  it('matches MCP servers by name and class, and recommends none otherwise', () => {
    const servers = [{ name: 'context7' }, { name: 'postgres' }, { name: 'github' }, { name: 'playwright' }, { name: 'misc' }];
    expect(recommendTools('research', servers).mcp.map((m) => m.name)).toEqual(['context7']);
    expect(recommendTools('implementation', servers).mcp.map((m) => m.name)).toEqual(['context7', 'postgres']);
    expect(recommendTools('verification', servers).mcp.map((m) => m.name)).toEqual(['github', 'playwright']);
    expect(recommendTools('summarization', servers).mcp).toEqual([]);
    expect(recommendTools('research', [{ name: 'misc' }]).mcp).toEqual([]);
  });
});

describe('ToolCache', () => {
  let rt: Runtime;
  let cache: ToolCache;
  beforeEach(() => {
    rt = openRuntime({ root, create: true });
    cache = new ToolCache(rt.db);
  });
  afterEach(() => rt.close());

  it('hits only when fingerprint matches; key order of args is irrelevant', () => {
    cache.set('search', { q: 'a', n: 1 }, 'fp1', { hits: [1] });
    expect(cache.get('search', { n: 1, q: 'a' }, 'fp1')).toEqual({ hits: [1] });
    expect(cache.get('search', { q: 'a', n: 1 }, 'fp2')).toBeNull();
    expect(cache.get('search', { q: 'b', n: 1 }, 'fp1')).toBeNull();
    expect(cache.get('other', { q: 'a', n: 1 }, 'fp1')).toBeNull();
  });

  it('overwrites with new fingerprint and clears', () => {
    cache.set('t', {}, 'fp1', 1);
    cache.set('t', {}, 'fp2', 2);
    expect(cache.get('t', {}, 'fp1')).toBeNull();
    expect(cache.get('t', {}, 'fp2')).toBe(2);
    cache.clear();
    expect(cache.get('t', {}, 'fp2')).toBeNull();
  });
});
