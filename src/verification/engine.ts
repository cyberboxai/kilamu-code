import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import { errorMessage, KilamuError } from '../core/errors.ts';
import { parseCommand, run } from '../core/exec.ts';
import { newId, nowIso } from '../core/ids.ts';
import { safeResolve } from '../core/paths.ts';
import { redact } from '../core/redact.ts';
import { checkCommandPolicy, packageScripts, userExtraPrograms } from './policy.ts';
import { parseJson, type Db } from '../persistence/db.ts';
import type { Runtime } from '../runtime.ts';
import type { AcceptanceCriterion, ArtifactSink, CheckResult, TaskRecord, VerificationReport } from '../core/types.ts';

const MAX_FILE_BYTES = 5 * 1024 * 1024;

type CommandCriterion = Extract<AcceptanceCriterion, { kind: 'command' }>;
type FileExistsCriterion = Extract<AcceptanceCriterion, { kind: 'file_exists' }>;
type FileContainsCriterion = Extract<AcceptanceCriterion, { kind: 'file_contains' }>;
type AttestationCriterion = Extract<AcceptanceCriterion, { kind: 'attestation' }>;

export interface VerifyOptions {
  attestations?: Record<string, string>;
  dryRun?: boolean;
}

/** Policy check shared by `kilamu verify` and `kilamu plan create` (early rejection). */
export function commandPolicyError(argv: string[], root: string, cwd: string): string | null {
  return checkCommandPolicy(argv, { root, packageScripts: packageScripts(cwd), extraPrograms: userExtraPrograms() });
}

function result(c: AcceptanceCriterion, status: CheckResult['status'], detail: string, extra: Partial<CheckResult> = {}): CheckResult {
  return { criterionId: c.id, kind: c.kind, status, detail, ...extra };
}

function readCapped(file: string): string {
  const size = statSync(file).size;
  const len = Math.min(size, MAX_FILE_BYTES);
  const buf = Buffer.alloc(len);
  const fd = openSync(file, 'r');
  try {
    readSync(fd, buf, 0, len, 0);
  } finally {
    closeSync(fd);
  }
  return buf.toString('utf8');
}

export class VerificationEngine {
  private readonly rt: Runtime;
  private readonly artifacts: ArtifactSink;

  constructor(rt: Runtime, artifacts: ArtifactSink) {
    this.rt = rt;
    this.artifacts = artifacts;
  }

  async verifyTask(task: TaskRecord, opts: VerifyOptions = {}): Promise<VerificationReport> {
    const results: CheckResult[] = [];
    for (const c of task.acceptance) {
      try {
        results.push(await this.evaluate(task, c, opts));
      } catch (e) {
        results.push(result(c, 'ERROR', errorMessage(e)));
      }
    }
    const dry = opts.dryRun === true;
    const verified = !dry && results.length > 0 && results.every((r) => r.status === 'PASS' || r.status === 'ATTESTED');
    const report: VerificationReport = {
      executionId: task.executionId,
      taskId: task.id,
      results,
      verdict: verified ? 'VERIFIED' : 'FAILED',
      runId: newId(dry ? 'vdry' : 'vr'),
    };
    if (!dry) this.persist(report, task.checkpointId);
    return report;
  }

  /** Persist the run bound to the attempt (checkpoint) it verified; free text is redacted. */
  private persist(report: VerificationReport, checkpointId: string | null): void {
    this.rt.db
      .prepare('INSERT INTO verification_runs(id, execution_id, task_id, verdict, results_json, checkpoint_id, created_at) VALUES(?,?,?,?,?,?,?)')
      .run(report.runId, report.executionId, report.taskId, report.verdict, redact(JSON.stringify(report.results)).text, checkpointId, nowIso());
  }

  private evaluate(task: TaskRecord, c: AcceptanceCriterion, opts: VerifyOptions): Promise<CheckResult> | CheckResult {
    switch (c.kind) {
      case 'command':
        return this.checkCommand(task, c, opts.dryRun === true);
      case 'file_exists':
        return this.checkFileExists(c);
      case 'file_contains':
        return this.checkFileContains(c);
      case 'artifact':
        return task.outputArtifacts.length > 0
          ? result(c, 'PASS', `${task.outputArtifacts.length} output artifact(s) recorded`)
          : result(c, 'FAIL', 'no output artifacts recorded for this task');
      case 'attestation':
        return this.checkAttestation(c, opts.attestations);
    }
  }

  private async checkCommand(task: TaskRecord, c: CommandCriterion, dryRun: boolean): Promise<CheckResult> {
    let argv: string[];
    try {
      argv = parseCommand(c.command);
    } catch (e) {
      if (e instanceof KilamuError && e.code === 'UNSAFE_COMMAND') return result(c, 'ERROR', e.message, { command: c.command });
      throw e;
    }
    const cwd = safeResolve(this.rt.paths.root, c.cwd ?? '.');
    const denied = commandPolicyError(argv, this.rt.paths.root, cwd);
    if (denied) return result(c, 'ERROR', `not allowed: ${denied}`, { command: c.command });
    if (dryRun) return result(c, 'SKIPPED', `dry run: would execute ${JSON.stringify(argv)}`, { command: c.command });

    const timeoutSec = c.timeoutSec ?? this.rt.config.verification.defaultTimeoutSec;
    const r = await run(argv, { cwd, timeoutMs: timeoutSec * 1000 });
    const combined = r.stderr ? `${r.stdout}${r.stdout && !r.stdout.endsWith('\n') ? '\n' : ''}${r.stderr}` : r.stdout;
    const artifactId = this.storeOutput(combined, c.command, task);
    const passed = r.exitCode === 0 && !r.timedOut;
    const detail = r.timedOut ? `timed out after ${timeoutSec}s` : passed ? 'exit code 0' : `exit code ${r.exitCode ?? 'null'}${r.signal ? ` (signal ${r.signal})` : ''}`;
    return result(c, passed ? 'PASS' : 'FAIL', detail, {
      command: c.command,
      exitCode: r.exitCode,
      durationMs: r.durationMs,
      ...(artifactId ? { artifactId } : {}),
    });
  }

  private storeOutput(content: string, command: string, task: TaskRecord): string | undefined {
    try {
      return this.artifacts.put(content, { kind: 'command-output', source: command, executionId: task.executionId, taskId: task.id }).id;
    } catch (e) {
      this.rt.log.warn('verification.artifact_failed', { error: errorMessage(e) });
      return undefined;
    }
  }

  private checkFileExists(c: FileExistsCriterion): CheckResult {
    const abs = safeResolve(this.rt.paths.root, c.path);
    return existsSync(abs) ? result(c, 'PASS', `exists: ${c.path}`) : result(c, 'FAIL', `missing: ${c.path}`);
  }

  private checkFileContains(c: FileContainsCriterion): CheckResult {
    const abs = safeResolve(this.rt.paths.root, c.path);
    if (!existsSync(abs)) return result(c, 'FAIL', `missing: ${c.path}`);
    let matcher: (text: string) => boolean;
    if (c.regex) {
      let re: RegExp;
      try {
        re = new RegExp(c.pattern);
      } catch (e) {
        return result(c, 'ERROR', `invalid regex: ${errorMessage(e)}`);
      }
      matcher = (t) => re.test(t);
    } else {
      matcher = (t) => t.includes(c.pattern);
    }
    const text = readCapped(abs);
    return matcher(text) ? result(c, 'PASS', `pattern found in ${c.path}`) : result(c, 'FAIL', `pattern not found in ${c.path}`);
  }

  private checkAttestation(c: AttestationCriterion, attestations: Record<string, string> | undefined): CheckResult {
    const note = attestations?.[c.id]?.trim();
    if (note) return result(c, 'ATTESTED', `attested: ${note}`);
    return result(c, 'FAIL', `attestation required: pass --attest ${c.id}="note"`);
  }
}

interface RunRow {
  id: string;
  execution_id: string;
  task_id: string;
  verdict: 'VERIFIED' | 'FAILED';
  results_json: string;
}

function toReport(row: RunRow): VerificationReport {
  return {
    executionId: row.execution_id,
    taskId: row.task_id,
    results: parseJson<CheckResult[]>(row.results_json, []),
    verdict: row.verdict,
    runId: row.id,
  };
}

export function latestRun(db: Db, executionId: string, taskId: string): VerificationReport | null {
  const row = db
    .prepare('SELECT id, execution_id, task_id, verdict, results_json FROM verification_runs WHERE execution_id = ? AND task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1')
    .get(executionId, taskId) as RunRow | undefined;
  return row ? toReport(row) : null;
}

/** Look up one persisted run (used by the execution store to validate reports). */
export function getRun(db: Db, runId: string): { verdict: 'VERIFIED' | 'FAILED'; executionId: string; taskId: string; checkpointId: string | null } | null {
  const r = db.prepare('SELECT verdict, execution_id, task_id, checkpoint_id FROM verification_runs WHERE id = ?').get(runId) as
    | { verdict: 'VERIFIED' | 'FAILED'; execution_id: string; task_id: string; checkpoint_id: string | null } | undefined;
  return r ? { verdict: r.verdict, executionId: r.execution_id, taskId: r.task_id, checkpointId: r.checkpoint_id } : null;
}

/** Render a report as a plain-text block. Non-PASS results show detail and artifact id. */
export function renderReport(report: VerificationReport): string {
  const lines = [`TASK ${report.taskId}${report.runId.startsWith('vdry') ? ' (dry run — nothing executed or recorded)' : ''}`];
  for (const r of report.results) {
    lines.push(`${r.criterionId}: ${r.status}`);
    if (r.status !== 'PASS') {
      lines.push(`  detail: ${r.detail}`);
      if (r.artifactId) lines.push(`  artifact: ${r.artifactId}`);
    }
  }
  lines.push(`FINAL STATUS: ${report.runId.startsWith('vdry') ? 'NOT VERIFIED (dry run)' : report.verdict}`);
  return lines.join('\n');
}
