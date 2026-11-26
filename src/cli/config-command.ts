import { existsSync } from 'node:fs';
import { copyFileExclusive, writeFileAtomic } from '../core/fsx.ts';
import { DEFAULT_CONFIG, loadConfig, setConfigValue } from '../core/config.ts';
import { KilamuError } from '../core/errors.ts';
import { projectPaths } from '../core/paths.ts';
import { isInitialized } from '../core/trust.ts';
import { parse } from './args.ts';
import type { CommandResult } from './output.ts';

/**
 * `kilamu config` runs before the app opens so a broken config.json can still
 * be inspected and repaired (`config reset` keeps a backup).
 */
export function cmdConfig(root: string, argv: string[]): CommandResult {
  const p = parse(argv, {});
  const [sub, key, value] = p.positionals;
  const paths = projectPaths(root);
  if (!isInitialized(paths)) throw new KilamuError('NOT_INITIALIZED', `Kilamu Code is not initialized for ${root}. Run \`kilamu init\`.`);
  const lookup = (obj: unknown, dotted: string): unknown =>
    dotted.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj);
  switch (sub ?? 'get') {
    case 'get': {
      const cfg = loadConfig(paths);
      const v = key ? lookup(cfg, key) : cfg;
      if (v === undefined) throw new KilamuError('USAGE', `unknown config key ${JSON.stringify(key)}`);
      return { data: v, text: JSON.stringify(v, null, 2) };
    }
    case 'set': {
      if (!key || value === undefined) throw new KilamuError('USAGE', 'usage: kilamu config set <dotted.key> <json-value>');
      const cfg = setConfigValue(paths, key, value);
      return { data: cfg, text: `${key} = ${JSON.stringify(lookup(cfg, key))}` };
    }
    case 'reset': {
      let backup: string | null = null;
      if (existsSync(paths.configFile)) {
        backup = `${paths.configFile}.bak-${Date.now()}`;
        copyFileExclusive(paths.configFile, backup);
      }
      writeFileAtomic(paths.configFile, `${JSON.stringify({ version: 1 }, null, 2)}\n`, { refuseSymlinkTarget: true });
      return { data: { reset: true, backup, defaults: DEFAULT_CONFIG }, text: `config reset to defaults${backup ? ` (previous file kept at ${backup})` : ''}` };
    }
    default:
      throw new KilamuError('USAGE', 'usage: kilamu config get [key] | set <key> <value> | reset');
  }
}
