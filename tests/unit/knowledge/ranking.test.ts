import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Indexer } from '../../../src/knowledge/indexer.ts';
import { KnowledgeGraph, queryWords } from '../../../src/knowledge/query.ts';
import { tempProject } from '../../helpers/tmp.ts';

describe('natural-language search ranking', () => {
  let ctx: ReturnType<typeof tempProject>;
  beforeEach(() => {
    ctx = tempProject();
    mkdirSync(join(ctx.root, 'src/verification'), { recursive: true });
    mkdirSync(join(ctx.root, 'docs'));
    writeFileSync(join(ctx.root, 'src/verification/engine.ts'), 'export function runCommand(cmd: string) {\n  // reject unsafe commands that need a shell\n  if (/[|&;]/.test(cmd)) throw new Error("unsafe");\n}\n');
    writeFileSync(join(ctx.root, 'docs/overview.md'), '# Overview\n\nHow does the verification engine work? The engine rejects unsafe commands. It does this and that, how the engine does it.\n');
    writeFileSync(join(ctx.root, 'src/other.ts'), 'export const how = "how does the thing do the work";\n');
  });
  afterEach(() => ctx.cleanup());

  it('drops stopwords from natural-language queries', () => {
    expect(queryWords('how does the verification engine reject unsafe commands')).toEqual(['verification', 'engine', 'reject', 'unsafe', 'commands']);
  });

  it('ranks the code file whose path names the topic above prose and stopword matches', async () => {
    await new Indexer(ctx.rt).index({});
    const hits = new KnowledgeGraph(ctx.rt.db).search('how does the verification engine reject unsafe commands', 5);
    expect(hits[0]!.path).toBe('src/verification/engine.ts');
    expect(hits.map((h) => h.path)).not.toContain('src/other.ts');
  });

  it('matches inflected forms through stemming', async () => {
    await new Indexer(ctx.rt).index({});
    const hits = new KnowledgeGraph(ctx.rt.db).search('rejecting command', 5);
    expect(hits.map((h) => h.path)).toContain('src/verification/engine.ts');
  });
});
