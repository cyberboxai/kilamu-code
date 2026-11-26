import { ArtifactStore } from './context/artifacts.ts';
import { UsageStore } from './cost/usage.ts';
import { ExecutionStore } from './execution/store.ts';
import { KnowledgeGraph } from './knowledge/query.ts';
import { MemoryStore } from './memory/store.ts';
import { EventLog } from './observability/events.ts';
import { VerificationEngine } from './verification/engine.ts';
import { getMeta, setMeta } from './persistence/db.ts';
import { openRuntime, type Runtime } from './runtime.ts';

const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Composition root: wires module services around one Runtime. Services are
 * created lazily so short-lived processes (hooks, statusline) only pay for
 * what they touch.
 */
export class App {
  readonly rt: Runtime;
  private cache = new Map<string, unknown>();

  constructor(rt: Runtime) {
    this.rt = rt;
  }

  static open(root?: string, opts: { create?: boolean } = {}): App {
    return new App(openRuntime({ ...(root ? { root } : {}), ...(opts.create ? { create: true } : {}) }));
  }

  private once<T>(key: string, make: () => T): T {
    if (!this.cache.has(key)) this.cache.set(key, make());
    return this.cache.get(key) as T;
  }

  get executions(): ExecutionStore {
    return this.once('exec', () => new ExecutionStore(this.rt.db, (type, data, executionId) => this.events.emit(type, data, { executionId })));
  }
  get artifacts(): ArtifactStore { return this.once('art', () => new ArtifactStore(this.rt)); }
  get memory(): MemoryStore { return this.once('mem', () => new MemoryStore(this.rt)); }
  get knowledge(): KnowledgeGraph { return this.once('kg', () => new KnowledgeGraph(this.rt.db)); }
  get usage(): UsageStore { return this.once('usage', () => new UsageStore(this.rt.db)); }
  get events(): EventLog { return this.once('events', () => new EventLog(this.rt.db)); }
  get verifier(): VerificationEngine { return this.once('verif', () => new VerificationEngine(this.rt, this.artifacts)); }

  /**
   * The Claude Code session THIS process runs in, exported by the SessionStart
   * hook through CLAUDE_ENV_FILE as KILAMU_SESSION_ID. Null when unknown — task
   * ownership is then left unattributed (never guessed from shared state).
   */
  get sessionId(): string | null {
    const v = process.env.KILAMU_SESSION_ID;
    return v && SESSION_ID.test(v) ? v : null;
  }

  /** Session last seen by a hook or the statusline; for HUD/usage attribution only. */
  get lastSeenSessionId(): string | null {
    return getMeta(this.rt.db, 'last_session_id');
  }

  setSessionId(id: string): void {
    if (!SESSION_ID.test(id)) return;
    setMeta(this.rt.db, 'last_session_id', id);
  }

  close(): void {
    this.rt.close();
  }
}
