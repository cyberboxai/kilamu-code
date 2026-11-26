import { KilamuError } from '../core/errors.ts';
import { redact } from '../core/redact.ts';
import { estimated, estimateTokens } from '../core/tokens.ts';
import type { ArtifactRef, ArtifactSink, CompressedSummary } from '../core/types.ts';
import { splitLines } from './artifacts.ts';

/**
 * Deterministic tool-output compression (directive §9). Detects common
 * test/build/lint formats and keeps only what an agent needs to act: failing
 * test names, assertion messages, locations and the summary line. Every
 * finding carries a 1-based line range into the ORIGINAL text so the exact
 * region can be fetched from the stored artifact.
 */

export type Finding = CompressedSummary['findings'][number];
export type Status = CompressedSummary['status'];
export type CompressResult = Omit<CompressedSummary, 'artifactId' | 'retrieval'>;

export interface CompressMeta {
  source: string;
  command?: string;
  exitCode?: number | null;
}

interface Extraction {
  findings: Finding[];
  /** Summary lines (e.g. "Tests 2 failed | 8 passed"): always kept, listed last. */
  summary: Finding[];
  status: Status;
}

interface Format {
  name: string;
  detect(lines: string[]): boolean;
  extract(lines: string[]): Extraction;
  /** Collapse key; generic output normalises digits (timestamps, counters). */
  key?(text: string): string;
}

export const MAX_FINDINGS = 25;
const MAX_FINDING_CHARS = 300;
const TAIL_LINES = 15;
const BLOCK_SCAN = 40;
const RENDER_MAX_LINES = 60;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

function clean(line: string): string {
  return line.replace(ANSI, '').replace(/\r$/, '').trimEnd();
}

function clip(text: string): string {
  const t = text.trim();
  return t.length > MAX_FINDING_CHARS ? `${t.slice(0, MAX_FINDING_CHARS - 1)}…` : t;
}

/** 0-based index → 1-based finding. */
function at(text: string, start: number, end = start): Finding {
  return { text: clip(text), lineStart: start + 1, lineEnd: end + 1 };
}

function indexesOf(lines: string[], re: RegExp): number[] {
  const out: number[] = [];
  lines.forEach((l, i) => { if (re.test(l)) out.push(i); });
  return out;
}

function anyLine(lines: string[], re: RegExp): boolean {
  return lines.some((l) => re.test(l));
}

/** Scan forward from `from` (exclusive) until `stop` matches or the window ends. */
function scanBlock(lines: string[], from: number, stop: RegExp, max = BLOCK_SCAN): number {
  let end = from;
  for (let i = from + 1; i < lines.length && i <= from + max; i++) {
    if (stop.test(lines[i] ?? '')) break;
    end = i;
  }
  return end;
}

function firstMatch(lines: string[], from: number, to: number, re: RegExp): { index: number; m: RegExpMatchArray } | null {
  for (let i = from; i <= to && i < lines.length; i++) {
    const m = (lines[i] ?? '').match(re);
    if (m) return { index: i, m };
  }
  return null;
}

function statusFrom(failed: boolean, passed: boolean): Status {
  if (failed) return 'failure';
  return passed ? 'success' : 'unknown';
}

// ---------------------------------------------------------------------------
// vitest / jest
// ---------------------------------------------------------------------------

const JS_SUMMARY = /^\s*(?:Test Files|Tests|Test Suites:|Tests:)\s+\S/;
const JS_HEADER_FAIL = /^\s*FAIL\s+\S/;
const JS_HEADER_JEST = /^\s*● (?!Console\b)(.+)$/;
const JS_HEADER_X = /^\s*[×✗✕]\s+(.+)$/;
const JS_MESSAGE = /^\s*(?:(?:Assertion|Type|Reference|Range|Syntax)?Error\b.*|\w+Error:.*|expect\(.*|Expected.*|Received.*)$/;
const JS_LOCATION = /(?:❯|\bat\b)\s*.*?((?:[A-Za-z]:)?[\w./\\@-]+\.(?:[cm]?[jt]sx?)):(\d+)(?::\d+)?/;
const JS_BLOCK_STOP = /^\s*(?:FAIL\s+\S|● (?!Console\b)|⎯{3,}|Test Files\s|Tests\s+\d|Test Suites:)/;

function jsBlock(lines: string[], header: number, name: string): Finding {
  const end = scanBlock(lines, header, JS_BLOCK_STOP);
  const msg = firstMatch(lines, header + 1, end, JS_MESSAGE);
  const loc = firstMatch(lines, header + 1, end, JS_LOCATION);
  const parts = [`FAIL ${name}`];
  if (msg) parts.push(msg.m[0].trim());
  if (loc) parts.push(`@ ${loc.m[1]}:${loc.m[2]}`);
  const last = Math.max(header, msg?.index ?? header, loc?.index ?? header);
  return at(parts.join(' — '), header, last);
}

const jsFormat = (name: 'vitest' | 'jest'): Format => ({
  name,
  detect: (lines) =>
    name === 'vitest'
      ? anyLine(lines, /^\s*Test Files\s+\d+\s+(?:passed|failed)/) || anyLine(lines, /^\s*(?:RUN\s+v\d|❯\s.+\.(?:test|spec)\.[cm]?[jt]sx?)/)
      : anyLine(lines, /^(?:Test Suites|Tests):\s+\d+/) || anyLine(lines, JS_HEADER_JEST),
  extract(lines) {
    const findings: Finding[] = [];
    let headers = indexesOf(lines, JS_HEADER_JEST).map((i) => ({ i, name: (lines[i] ?? '').match(JS_HEADER_JEST)?.[1] ?? '' }));
    if (!headers.length) headers = indexesOf(lines, JS_HEADER_FAIL).map((i) => ({ i, name: (lines[i] ?? '').replace(/^\s*FAIL\s+/, '') }));
    if (!headers.length) headers = indexesOf(lines, JS_HEADER_X).map((i) => ({ i, name: (lines[i] ?? '').match(JS_HEADER_X)?.[1] ?? '' }));
    for (const h of headers) findings.push(jsBlock(lines, h.i, h.name.trim()));
    const summaryIdx = indexesOf(lines, JS_SUMMARY);
    const summaryText = summaryIdx.map((i) => lines[i] ?? '').join('\n');
    return {
      findings,
      summary: summaryIdx.map((i) => at(lines[i] ?? '', i)),
      status: statusFrom(/\b[1-9]\d* failed\b/.test(summaryText), /\d+ passed\b/.test(summaryText)),
    };
  },
});

// ---------------------------------------------------------------------------
// pytest
// ---------------------------------------------------------------------------

const PY_RULE = /^={3,}.*={3,}$/;
const PY_SHORT = /^=+ short test summary info =+$/;
const PY_FAILED_LINE = /^(?:FAILED|ERROR)\s+\S+/;
const PY_SECTION = /^_{3,} (.+?) _{3,}$/;
const PY_E_LINE = /^E\s{2,}(.+)$/;
const PY_LOCATION = /^((?:[A-Za-z]:)?[\w./\\-]+\.py):(\d+):\s*(\w+)?/;
const PY_SECTION_STOP = new RegExp(`${PY_SECTION.source}|${PY_RULE.source}`);
const PY_FINAL = /^=+ .*\b\d+ (?:passed|failed|errors?|skipped|xfailed|deselected)\b.* in [\d.]+s.*=+$/;

const pytestFormat: Format = {
  name: 'pytest',
  detect: (lines) => anyLine(lines, /^=+ (?:test session starts|short test summary info|FAILURES|ERRORS) =+$/) || anyLine(lines, PY_FINAL),
  extract(lines) {
    const findings: Finding[] = [];
    for (const i of indexesOf(lines, PY_SECTION)) {
      const end = scanBlock(lines, i, PY_SECTION_STOP, 200);
      const e = firstMatch(lines, i + 1, end, PY_E_LINE);
      const loc = firstMatch(lines, i + 1, end, PY_LOCATION);
      const name = (lines[i] ?? '').match(PY_SECTION)?.[1] ?? '';
      const parts = [name];
      if (e) parts.push(e.m[1] ?? '');
      if (loc) parts.push(`@ ${loc.m[1]}:${loc.m[2]}${loc.m[3] ? ` (${loc.m[3]})` : ''}`);
      findings.push(at(parts.join(' — '), i, Math.max(i, e?.index ?? i, loc?.index ?? i)));
    }
    const short = lines.findIndex((l) => PY_SHORT.test(l));
    const failedLines = short >= 0
      ? indexesOf(lines, PY_FAILED_LINE).filter((i) => i > short)
      : indexesOf(lines, PY_FAILED_LINE);
    for (const i of failedLines) findings.push(at(lines[i] ?? '', i));
    const final = indexesOf(lines, PY_FINAL);
    const text = final.map((i) => lines[i] ?? '').join('\n');
    const failed = /\b\d+ (?:failed|errors?)\b/.test(text) || failedLines.length > 0;
    return {
      findings,
      summary: final.map((i) => at((lines[i] ?? '').replace(/^=+\s*|\s*=+$/g, ''), i)),
      status: statusFrom(failed, /\b\d+ passed\b/.test(text)),
    };
  },
};

// ---------------------------------------------------------------------------
// go test
// ---------------------------------------------------------------------------

const GO_FAIL = /^\s*--- FAIL: (\S+)/;
const GO_PKG = /^(?:FAIL|ok)\s+\S+\s+(?:[\d.]+s|\(cached\)|\[[^\]]+\])/;
const GO_MSG = /^\s+([\w./-]+\.go:\d+):\s*(.*)$/;

/** Index of the "=== RUN   <name>" line opening a failed test, or -1. */
function goRunLine(lines: string[], failIdx: number, name: string): number {
  const opener = new RegExp(`^=== (?:RUN|CONT)\\s+${escapeRe(name)}$`);
  for (let i = failIdx - 1; i >= 0 && i >= failIdx - BLOCK_SCAN; i--) {
    const l = lines[i] ?? '';
    if (opener.test(l)) return i;
    if (/^\s*--- (?:FAIL|PASS|SKIP): /.test(l)) return -1;
  }
  return -1;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const goFormat: Format = {
  name: 'go-test',
  detect: (lines) => anyLine(lines, /^\s*--- (?:FAIL|PASS|SKIP): /) || anyLine(lines, GO_PKG),
  extract(lines) {
    const findings: Finding[] = [];
    for (const i of indexesOf(lines, GO_FAIL)) {
      const name = (lines[i] ?? '').match(GO_FAIL)?.[1] ?? '';
      // Non-verbose output logs after "--- FAIL"; `-v` streams logs between "=== RUN" and "--- FAIL".
      const end = scanBlock(lines, i, /^\s*(?:--- |=== RUN|FAIL|ok\s|PASS$)/, 30);
      const after = firstMatch(lines, i + 1, end, GO_MSG);
      const run = after ? -1 : goRunLine(lines, i, name);
      const before = run >= 0 ? firstMatch(lines, run + 1, i - 1, GO_MSG) : null;
      const msg = after ?? before;
      const text = msg ? `--- FAIL ${name} — ${msg.m[2]} @ ${msg.m[1]}` : `--- FAIL ${name}`;
      findings.push(before ? at(text, before.index, i) : at(text, i, msg?.index ?? i));
    }
    for (const i of indexesOf(lines, /^panic: /)) findings.push(at(lines[i] ?? '', i));
    const pkgs = indexesOf(lines, GO_PKG);
    const failedPkgs = pkgs.filter((i) => (lines[i] ?? '').startsWith('FAIL'));
    const failed = findings.length > 0 || failedPkgs.length > 0 || anyLine(lines, /^FAIL$/);
    const passed = pkgs.some((i) => (lines[i] ?? '').startsWith('ok')) || anyLine(lines, /^PASS$/);
    return { findings, summary: failedPkgs.map((i) => at(lines[i] ?? '', i)), status: statusFrom(failed, passed) };
  },
};

// ---------------------------------------------------------------------------
// cargo test
// ---------------------------------------------------------------------------

const CARGO_RESULT = /^test result: (ok|FAILED)\./;
const CARGO_FAILED_TEST = /^test (\S+) \.\.\. FAILED$/;
const CARGO_STDOUT = /^---- (\S+) stdout ----$/;
const CARGO_PANIC = /panicked at (?:'[^']*', )?([\w./\\-]+\.rs:\d+(?::\d+)?)/;
const CARGO_COMPILE = /^error(?:\[E\d+\])?: (.+)$/;

const cargoFormat: Format = {
  name: 'cargo-test',
  detect: (lines) => anyLine(lines, CARGO_RESULT) || (anyLine(lines, /^running \d+ tests?$/) && anyLine(lines, /^test \S+ \.\.\. (?:ok|FAILED|ignored)$/)),
  extract(lines) {
    const findings: Finding[] = [];
    const stdoutBlocks = indexesOf(lines, CARGO_STDOUT);
    for (const i of stdoutBlocks) {
      const end = scanBlock(lines, i, /^(?:---- |failures:$|test result:)/, 30);
      const panic = firstMatch(lines, i + 1, end, CARGO_PANIC);
      const msgIdx = panic ? panic.index + 1 : -1;
      const msg = msgIdx > 0 && msgIdx <= end ? (lines[msgIdx] ?? '').trim() : '';
      const name = (lines[i] ?? '').match(CARGO_STDOUT)?.[1] ?? '';
      const parts = [`FAILED ${name}`];
      if (msg) parts.push(msg);
      if (panic) parts.push(`@ ${panic.m[1]}`);
      findings.push(at(parts.join(' — '), i, Math.max(i, msg ? msgIdx : (panic?.index ?? i))));
    }
    if (!stdoutBlocks.length) for (const i of indexesOf(lines, CARGO_FAILED_TEST)) findings.push(at(lines[i] ?? '', i));
    for (const i of indexesOf(lines, CARGO_COMPILE)) {
      const loc = firstMatch(lines, i + 1, i + 3, /^\s*--> (.+)$/);
      findings.push(at(loc ? `${lines[i]} @ ${loc.m[1]}` : (lines[i] ?? ''), i, loc?.index ?? i));
    }
    const results = indexesOf(lines, CARGO_RESULT);
    const text = results.map((i) => lines[i] ?? '').join('\n');
    const failed = /FAILED/.test(text) || anyLine(lines, CARGO_COMPILE);
    return { findings, summary: results.map((i) => at(lines[i] ?? '', i)), status: statusFrom(failed, /test result: ok/.test(text)) };
  },
};

// ---------------------------------------------------------------------------
// tsc
// ---------------------------------------------------------------------------

const TSC_ERR = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/;
const TSC_ERR_PRETTY = /^(.+?):(\d+):(\d+) - error (TS\d+): (.*)$/;
const TSC_FOUND = /^Found (\d+) errors?\b/;

const tscFormat: Format = {
  name: 'tsc',
  detect: (lines) => anyLine(lines, TSC_ERR) || anyLine(lines, TSC_ERR_PRETTY),
  extract(lines) {
    const findings: Finding[] = [];
    lines.forEach((l, i) => {
      const m = l.match(TSC_ERR) ?? l.match(TSC_ERR_PRETTY);
      if (!m) return;
      let end = i;
      // Plain-format continuation lines are indented message elaborations.
      if (TSC_ERR.test(l)) while (end + 1 < lines.length && /^\s{2,}\S/.test(lines[end + 1] ?? '')) end++;
      findings.push(at(`${m[1]}:${m[2]}:${m[3]} ${m[4]} ${m[5]}`, i, end));
    });
    const found = indexesOf(lines, TSC_FOUND);
    const zero = found.some((i) => /^Found 0 errors/.test(lines[i] ?? ''));
    return { findings, summary: found.map((i) => at(lines[i] ?? '', i)), status: statusFrom(findings.length > 0, zero) };
  },
};

// ---------------------------------------------------------------------------
// eslint (stylish)
// ---------------------------------------------------------------------------

const ESLINT_PROBLEM = /^\s+(\d+):(\d+)\s+(error|warning)\s+(.+?)(?:\s{2,}(\S+))?\s*$/;
const ESLINT_FILE = /^(?:[A-Za-z]:\\|\/|\.{0,2}[\w@-])\S*\.\w+$/;
const ESLINT_TOTAL = /^\s*✖ (\d+) problems? \((\d+) errors?, (\d+) warnings?\)/;

const eslintFormat: Format = {
  name: 'eslint',
  detect: (lines) => anyLine(lines, ESLINT_TOTAL) || (anyLine(lines, ESLINT_PROBLEM) && anyLine(lines, ESLINT_FILE)),
  extract(lines) {
    const errors: Finding[] = [];
    const warnings: Finding[] = [];
    let file = '';
    lines.forEach((l, i) => {
      if (ESLINT_FILE.test(l)) { file = l.trim(); return; }
      const m = l.match(ESLINT_PROBLEM);
      if (!m) return;
      const f = at(`${file}:${m[1]}:${m[2]} ${m[3]} ${m[4]}${m[5] ? ` (${m[5]})` : ''}`, i);
      (m[3] === 'error' ? errors : warnings).push(f);
    });
    const totals = indexesOf(lines, ESLINT_TOTAL);
    // Warnings are listed only when there are no errors; eslint exits 0 on warnings alone.
    return {
      findings: errors.length ? errors : warnings,
      summary: totals.map((i) => at(lines[i] ?? '', i)),
      status: statusFrom(errors.length > 0, true),
    };
  },
};

// ---------------------------------------------------------------------------
// npm
// ---------------------------------------------------------------------------

const NPM_ERR = /^npm (?:ERR!|error)\s?(.*)$/;

const npmFormat: Format = {
  name: 'npm',
  detect: (lines) => anyLine(lines, NPM_ERR),
  extract(lines) {
    const findings = indexesOf(lines, NPM_ERR)
      .filter((i) => ((lines[i] ?? '').match(NPM_ERR)?.[1] ?? '').trim() !== '')
      .map((i) => at(lines[i] ?? '', i));
    return { findings, summary: [], status: 'failure' };
  },
};

// ---------------------------------------------------------------------------
// Python traceback
// ---------------------------------------------------------------------------

const TB_START = /^\s*Traceback \(most recent call last\):$/;
const TB_FRAME = /^\s*File "([^"]+)", line (\d+)(?:, in (.+))?$/;
const TB_EXC = /^([A-Za-z_][\w.]*(?:Error|Exception|Interrupt|Exit|Warning)|[A-Za-z_][\w.]*)(?::\s?(.*))?$/;

const tracebackFormat: Format = {
  name: 'python-traceback',
  detect: (lines) => anyLine(lines, TB_START),
  extract(lines) {
    const findings: Finding[] = [];
    for (const start of indexesOf(lines, TB_START)) {
      let lastFrame = -1;
      let exc = -1;
      for (let i = start + 1; i < lines.length && i <= start + 500; i++) {
        const l = lines[i] ?? '';
        if (TB_FRAME.test(l)) { lastFrame = i; continue; }
        if (/^\s/.test(l) || l === '') continue;
        if (TB_EXC.test(l)) exc = i;
        break;
      }
      if (exc < 0) continue;
      const frame = lastFrame >= 0 ? (lines[lastFrame] ?? '').match(TB_FRAME) : null;
      const where = frame ? ` @ ${frame[1]}:${frame[2]}${frame[3] ? ` in ${frame[3]}` : ''}` : '';
      findings.push(at(`${(lines[exc] ?? '').trim()}${where}`, lastFrame >= 0 ? lastFrame : start, exc));
    }
    return { findings, summary: [], status: findings.length ? 'failure' : 'unknown' };
  },
};

// ---------------------------------------------------------------------------
// Generic fallback
// ---------------------------------------------------------------------------

const GENERIC_HIT = /\b(?:errors?|fail(?:s|ed|ure|ures)?|exceptions?|fatal|panic(?:ked)?)\b/i;
const GENERIC_NEGATIVE = /\b(?:0|no|zero) (?:errors?|failures?|failed)\b|\b0 failed\b/i;

const genericFormat: Format = {
  name: 'generic',
  detect: () => true,
  key: (text) => text.replace(/\d+/g, '#'),
  extract(lines) {
    const findings = indexesOf(lines, GENERIC_HIT)
      .filter((i) => !GENERIC_NEGATIVE.test(lines[i] ?? ''))
      .map((i) => at(lines[i] ?? '', i));
    const summary: Finding[] = [];
    let last = lines.length - 1;
    while (last >= 0 && (lines[last] ?? '').trim() === '') last--;
    if (last >= 0) {
      const first = Math.max(0, last - TAIL_LINES + 1);
      const tail = lines.slice(first, last + 1).map((l) => (l.length > 200 ? `${l.slice(0, 199)}…` : l)).join('\n');
      summary.push({ text: `last ${last - first + 1} lines:\n${tail}`, lineStart: first + 1, lineEnd: last + 1 });
    }
    return { findings, summary, status: 'unknown' };
  },
};

/** Ordered: specific runners before wrappers (npm) and the generic fallback. */
const FORMATS: Format[] = [
  jsFormat('vitest'), jsFormat('jest'), pytestFormat, goFormat, cargoFormat, tscFormat, eslintFormat,
  tracebackFormat, npmFormat, genericFormat,
];

// ---------------------------------------------------------------------------
// Dedupe, cap, status
// ---------------------------------------------------------------------------

/** Collapse repeated findings into "text (×N)", keeping the first range. */
export function collapseFindings(findings: Finding[], key: (t: string) => string = (t) => t): Finding[] {
  const order: string[] = [];
  const byKey = new Map<string, { f: Finding; n: number }>();
  for (const f of findings) {
    const k = key(f.text);
    const hit = byKey.get(k);
    if (hit) hit.n++;
    else { byKey.set(k, { f, n: 1 }); order.push(k); }
  }
  return order.map((k) => {
    const { f, n } = byKey.get(k)!;
    return n > 1 ? { ...f, text: `${f.text} (×${n})` } : f;
  });
}

/** Keep at most MAX_FINDINGS in total; summary lines are never dropped. */
function cap(findings: Finding[], summary: Finding[]): Finding[] {
  const room = Math.max(1, MAX_FINDINGS - summary.length);
  if (findings.length <= room) return [...findings, ...summary];
  const kept = findings.slice(0, room - 1);
  kept.push({ text: `… ${findings.length - kept.length} more findings omitted; open the artifact for the full output` });
  return [...kept, ...summary];
}

function resolveStatus(exitCode: number | null | undefined, inferred: Status): Status {
  if (typeof exitCode === 'number' && Number.isInteger(exitCode)) return exitCode === 0 ? 'success' : 'failure';
  return inferred;
}

function redactFindings(findings: Finding[]): Finding[] {
  return findings.map((f) => ({ ...f, text: redact(f.text).text }));
}

function savedTokens(fullText: string, rendered: string): ReturnType<typeof estimated> {
  return estimated(Math.max(0, estimateTokens(fullText) - estimateTokens(rendered)), 'heuristic:chars/4 (full output − rendered summary)');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function detectFormat(lines: string[]): Format {
  return FORMATS.find((f) => f.detect(lines)) ?? genericFormat;
}

/** Pure: summarise `text`. Line ranges refer to `text` as given. */
export function compressOutput(text: string, meta: CompressMeta): CompressResult {
  if (typeof text !== 'string') throw new KilamuError('COMPRESS_INVALID', 'Output must be a string');
  const lines = splitLines(text).map(clean);
  const format = lines.length ? detectFormat(lines) : genericFormat;
  const extraction: Extraction = lines.length ? format.extract(lines) : { findings: [], summary: [], status: 'unknown' };
  const findings = cap(
    collapseFindings(redactFindings(extraction.findings), format.key),
    collapseFindings(redactFindings(extraction.summary)),
  );
  const partial: CompressResult = {
    source: meta.command ? `${meta.source}: ${redact(meta.command).text}` : meta.source,
    totalLines: lines.length,
    totalBytes: Buffer.byteLength(text, 'utf8'),
    detectedFormat: format.name,
    status: resolveStatus(meta.exitCode, extraction.status),
    findings,
    estimatedTokensSaved: estimated(0),
  };
  partial.estimatedTokensSaved = savedTokens(text, renderSummary(partial));
  return partial;
}

/** Line range the retrieval hint points at: the first finding with context. */
function retrievalRange(s: CompressResult): string {
  if (s.totalLines === 0) return '';
  const first = s.findings.find((f) => f.lineStart !== undefined);
  if (!first || first.lineStart === undefined) {
    return ` --lines ${Math.max(1, s.totalLines - 49)}-${s.totalLines}`;
  }
  const a = Math.max(1, first.lineStart - 3);
  const b = Math.min(s.totalLines, (first.lineEnd ?? first.lineStart) + 10);
  return ` --lines ${a}-${b}`;
}

export type SummarySink = ArtifactSink & { setSummary(id: string, summary: CompressedSummary): void };

export interface StoreMeta extends CompressMeta {
  kind?: ArtifactRef['kind'];
  executionId?: string;
  taskId?: string;
}

/**
 * Redact, store and summarise. Compression runs on the redacted text so line
 * ranges match the stored artifact exactly (redaction may fold multi-line keys).
 */
export function compressAndStore(store: SummarySink, text: string, meta: StoreMeta): CompressedSummary {
  const stored = redact(text).text;
  const ref = store.put(stored, {
    kind: meta.kind ?? 'command-output',
    source: meta.source,
    ...(meta.executionId ? { executionId: meta.executionId } : {}),
    ...(meta.taskId ? { taskId: meta.taskId } : {}),
  });
  const partial = compressOutput(stored, meta);
  const summary: CompressedSummary = {
    ...partial,
    artifactId: ref.id,
    retrieval: `kilamu artifact show ${ref.id}${retrievalRange(partial)}`,
  };
  summary.estimatedTokensSaved = savedTokens(stored, renderSummary(summary));
  store.setSummary(ref.id, summary);
  return summary;
}

type Renderable = CompressResult & Partial<Pick<CompressedSummary, 'artifactId' | 'retrieval'>>;

function findingLines(f: Finding): string[] {
  const range = f.lineStart === undefined ? '' : f.lineEnd !== undefined && f.lineEnd !== f.lineStart ? `[L${f.lineStart}-${f.lineEnd}] ` : `[L${f.lineStart}] `;
  const [head = '', ...rest] = f.text.split('\n');
  return [`- ${range}${head}`, ...rest.map((l) => `    ${l}`)];
}

/** Compact markdown, at most ~60 lines. */
export function renderSummary(s: Renderable): string {
  const saved = s.estimatedTokensSaved.value ?? 0;
  const out = [
    `**${s.detectedFormat}** · ${s.status.toUpperCase()} · ${s.source}`,
    `${s.totalLines} lines, ${s.totalBytes} bytes${s.artifactId ? ` · artifact ${s.artifactId}` : ''} · ~${saved} tokens saved (${s.estimatedTokensSaved.label})`,
  ];
  const footer = s.retrieval ? [`Full output: \`${s.retrieval}\``] : [];
  const room = RENDER_MAX_LINES - out.length - footer.length - 1;
  const body: string[] = [];
  for (const f of s.findings) body.push(...findingLines(f));
  if (body.length > room) {
    const cut = body.length - room + 1;
    body.splice(room - 1, body.length, `- … ${cut} more lines truncated`);
  }
  if (!body.length) body.push('- no notable findings');
  return [...out, ...body, ...footer].join('\n');
}
