import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { run } from '../core/exec.ts';
import type { CapabilityReport } from '../core/types.ts';

const MIN_NODE = [22, 18, 0] as const;
const TEAMS_ENV = 'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS';
const TEAMS_NOTE = 'Agent teams are experimental in Claude Code; Kilamu never enables them itself.';

function nodeAtLeast(version: string): boolean {
  const parts = version.replace(/^v/, '').split('.').map((p) => Number.parseInt(p, 10));
  for (let i = 0; i < 3; i++) {
    const have = parts[i] ?? 0;
    const need = MIN_NODE[i] ?? 0;
    if (have !== need) return have > need;
  }
  return true;
}

async function probe(cmd: string, args: string[], cwd: string): Promise<string | null> {
  try {
    const r = await run([cmd, ...args], { cwd, timeoutMs: 5000, maxOutputBytes: 64 * 1024 });
    if (r.exitCode !== 0) return null;
    return (r.stdout || r.stderr).trim().split('\n')[0] ?? '';
  } catch {
    return null;
  }
}

async function probeSqlite(): Promise<{ sqlite: boolean; fts5: boolean }> {
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(':memory:');
    try {
      db.exec('CREATE VIRTUAL TABLE t USING fts5(x)');
      return { sqlite: true, fts5: true };
    } catch {
      return { sqlite: true, fts5: false };
    } finally {
      db.close();
    }
  } catch {
    return { sqlite: false, fts5: false };
  }
}

function settingsSetsTeams(file: string): boolean {
  try {
    const j = JSON.parse(readFileSync(file, 'utf8')) as { env?: Record<string, unknown> };
    const v = j.env?.[TEAMS_ENV];
    return v === '1' || v === 1;
  } catch {
    return false;
  }
}

export function detectTeams(root: string): CapabilityReport['agentTeams'] {
  if (process.env[TEAMS_ENV] === '1') return { available: true, source: `env ${TEAMS_ENV}`, note: TEAMS_NOTE };
  const files = [join(homedir(), '.claude', 'settings.json'), join(root, '.claude', 'settings.json'), join(root, '.claude', 'settings.local.json')];
  const hit = files.find(settingsSetsTeams);
  if (hit) return { available: true, source: hit, note: TEAMS_NOTE };
  return { available: false, source: 'not set', note: `${TEAMS_NOTE} Not enabled in env or settings.` };
}

export async function collectCapabilities(root: string): Promise<CapabilityReport> {
  const [claude, git, pdf, sql] = await Promise.all([
    probe('claude', ['--version'], root),
    probe('git', ['--version'], root),
    probe('pdftotext', ['-v'], root),
    probeSqlite(),
  ]);
  return {
    claudeCodeVersion: claude,
    nodeVersion: process.versions.node,
    nodeSupported: nodeAtLeast(process.versions.node),
    sqliteAvailable: sql.sqlite,
    fts5Available: sql.fts5,
    agentTeams: detectTeams(root),
    git: git !== null,
    pdftotext: pdf !== null,
    platform: `${process.platform}-${process.arch}`,
  };
}

export interface DoctorExtra {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
}

export function renderDoctor(report: CapabilityReport, extra: DoctorExtra[] = []): string {
  const row = (status: string, name: string, detail: string) => `[${status.padEnd(4)}] ${name}: ${detail}`;
  const lines = [
    row(report.claudeCodeVersion ? 'ok' : 'warn', 'claude', report.claudeCodeVersion ?? 'not found on PATH'),
    row(report.nodeSupported ? 'ok' : 'fail', 'node', `${report.nodeVersion} (requires >= ${MIN_NODE.join('.')})`),
    row(report.sqliteAvailable ? 'ok' : 'fail', 'node:sqlite', report.sqliteAvailable ? 'available' : 'unavailable'),
    row(report.fts5Available ? 'ok' : 'fail', 'fts5', report.fts5Available ? 'available' : 'unavailable'),
    row(report.agentTeams.available ? 'ok' : 'warn', 'agent teams', `${report.agentTeams.available ? 'enabled' : 'disabled'} (${report.agentTeams.source}). ${report.agentTeams.note}`),
    row(report.git ? 'ok' : 'warn', 'git', report.git ? 'available' : 'not found'),
    row(report.pdftotext ? 'ok' : 'warn', 'pdftotext', report.pdftotext ? 'available' : 'not found (PDF indexing disabled)'),
    row('ok', 'platform', report.platform),
    ...extra.map((e) => row(e.status, e.name, e.detail)),
  ];
  return lines.join('\n');
}
