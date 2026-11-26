import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolate the user-scope trust/policy directory per test worker so tests
// never read or write the developer's real ~/.config/kilamu-code.
process.env.KILAMU_CONFIG_HOME = mkdtempSync(join(tmpdir(), 'kilamu-cfg-'));
delete process.env.KILAMU_DATA_DIR;
delete process.env.KILAMU_PROJECT_DIR;
