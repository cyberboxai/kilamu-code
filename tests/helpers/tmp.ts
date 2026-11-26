import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openRuntime, type Runtime } from '../../src/runtime.ts';

/** Fresh temp project root plus an open runtime; call cleanup() in afterEach. */
export function tempProject(prefix = 'kilamu-test-'): { root: string; rt: Runtime; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const rt = openRuntime({ root, create: true });
  return {
    root,
    rt,
    cleanup: () => {
      rt.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
