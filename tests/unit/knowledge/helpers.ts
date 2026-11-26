import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DEFAULT_CONFIG } from '../../../src/core/config.ts';
import { Logger } from '../../../src/core/log.ts';
import { projectPaths } from '../../../src/core/paths.ts';
import { openDb } from '../../../src/persistence/db.ts';
import type { Runtime } from '../../../src/runtime.ts';

/**
 * In-memory runtime rooted at `root`. Nothing is written under the root:
 * the DB is `:memory:` and the logger is disabled, so fixtures stay pristine.
 */
export function memoryRuntime(root: string): Runtime {
  const { db } = openDb(':memory:');
  return {
    paths: projectPaths(root),
    config: structuredClone(DEFAULT_CONFIG),
    db,
    log: new Logger(null, 'test'),
    recoveredFrom: null,
    close: () => db.close(),
  };
}

export function tempProject(files: Record<string, string | Buffer> = {}): { root: string; write: (rel: string, content: string | Buffer) => void; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'kilamu-kg-'));
  const write = (rel: string, content: string | Buffer) => {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  };
  for (const [rel, content] of Object.entries(files)) write(rel, content);
  return { root, write, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
