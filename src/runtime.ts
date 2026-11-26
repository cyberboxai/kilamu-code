import { loadConfig, type KilamuConfig } from './core/config.ts';
import { KilamuError } from './core/errors.ts';
import { Logger } from './core/log.ts';
import { ensureDataDirs, findProjectRoot, projectPaths, type ProjectPaths } from './core/paths.ts';
import { isTrusted, trust } from './core/trust.ts';
import { openDb, type Db } from './persistence/db.ts';

/**
 * The runtime bundle passed to every module: resolved paths, validated
 * config, an open database and a logger. Modules receive only what they need
 * from it; they never reach for globals.
 */
export interface Runtime {
  paths: ProjectPaths;
  config: KilamuConfig;
  db: Db;
  log: Logger;
  /** Set when a corrupt DB was quarantined on open. */
  recoveredFrom: string | null;
  close(): void;
}

export interface OpenOptions {
  root?: string;
  dbFile?: string;
  /**
   * Create and trust the data directory (only `kilamu init` and tests).
   * Default false: commands never create state in directories the user did
   * not initialize, and never use an untrusted (e.g. cloned) `.kilamu/`.
   */
  create?: boolean;
}

export function openRuntime(opts: OpenOptions = {}): Runtime {
  const root = findProjectRoot(opts.root);
  const paths = projectPaths(root);
  if (opts.create) {
    ensureDataDirs(paths);
    if (!isTrusted(paths)) trust(paths);
  } else if (!isTrusted(paths)) {
    throw new KilamuError('NOT_INITIALIZED', `Kilamu Code is not initialized for ${root} (or its .kilamu/ was not created by this user). Run \`kilamu init\`.`);
  }
  const config = loadConfig(paths);
  const { db, recoveredFrom } = openDb(opts.dbFile ?? paths.dbFile);
  const log = new Logger(paths.logsDir, 'kilamu');
  if (recoveredFrom) log.warn('db.recovered', { quarantined: recoveredFrom });
  let closed = false;
  return {
    paths,
    config,
    db,
    log,
    recoveredFrom,
    close() {
      if (!closed) {
        closed = true;
        db.close();
      }
    },
  };
}
