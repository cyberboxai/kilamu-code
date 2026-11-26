import { posix } from 'node:path';
import { detectLanguage } from '../languages.ts';
import { CONF, ResultBuilder, fileRef, symbolRef, type ExtractResult } from './common.ts';

/**
 * Config extractor (JSON/JSONC, YAML, TOML, Dockerfile, Terraform): top-level
 * keys become `key` symbols; dependency manifests give DEPENDS_ON edges;
 * docker-compose services give CONNECTS_TO edges. Line scanners only, no
 * full parsers: anchors, multi-line strings and inline tables are not interpreted.
 */
export const PARSER_NAME = 'config-lines';
export const PARSER_VERSION = 1;

export function extract(rel: string, text: string): ExtractResult {
  const b = new ResultBuilder(rel);
  const base = posix.basename(rel).toLowerCase();
  switch (detectLanguage(rel)) {
    case 'json':
      extractJson(b, text, base === 'package.json');
      break;
    case 'yaml':
      extractYaml(b, text, /^(docker-)?compose(\.[\w-]+)?\.ya?ml$/.test(base));
      break;
    case 'toml':
      extractToml(b, text);
      break;
    case 'dockerfile':
      extractDockerfile(b, text);
      break;
    case 'terraform':
      extractTerraform(b, text);
      break;
    default:
      break;
  }
  return b.result();
}

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

const NPM_DEP_KEYS = new Set(['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']);

interface JsonKey {
  key: string;
  depth: number;
  owner: string | null;
  line: number;
}

/** Tolerant JSON/JSONC key scanner: object keys with depth and the key that owns their object. */
export function scanJsonKeys(text: string): JsonKey[] {
  const keys: JsonKey[] = [];
  const stack: Array<{ type: '{' | '['; owner: string | null; lastKey: string | null }> = [];
  let line = 1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '\n') line++;
    else if (ch === '/' && text[i + 1] === '/') {
      while (i + 1 < text.length && text[i + 1] !== '\n') i++;
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 1;
      for (; i < stop; i++) if (text[i] === '\n') line++;
    } else if (ch === '"') {
      const startLine = line;
      let s = '';
      for (i++; i < text.length && text[i] !== '"'; i++) {
        if (text[i] === '\\') i++;
        else if (text[i] === '\n') line++;
        s += text[i] ?? '';
      }
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j]!)) j++;
      const top = stack[stack.length - 1];
      if (text[j] === ':' && top?.type === '{') {
        keys.push({ key: s, depth: stack.length, owner: top.owner, line: startLine });
        top.lastKey = s;
      }
    } else if (ch === '{' || ch === '[') {
      const top = stack[stack.length - 1];
      stack.push({ type: ch, owner: top?.type === '{' ? top.lastKey : (top?.owner ?? null), lastKey: null });
    } else if (ch === '}' || ch === ']') {
      stack.pop();
    }
  }
  return keys;
}

function extractJson(b: ResultBuilder, text: string, packageJson: boolean): void {
  for (const k of scanJsonKeys(text)) {
    if (k.depth === 1) b.symbol(k.key, 'key', k.line, k.line, `"${k.key}"`, true);
    else if (packageJson && k.depth === 2 && k.owner && NPM_DEP_KEYS.has(k.owner)) {
      b.edge(fileRef(b.rel), 'DEPENDS_ON', `module:${k.key}`, k.line, CONF.config);
    }
  }
}

// ---------------------------------------------------------------------------
// YAML (+ docker-compose)
// ---------------------------------------------------------------------------

const YAML_TOP_KEY_RE = /^([A-Za-z_][\w.-]*|"[^"]+"|'[^']+')\s*:(?:\s|$)/;
const YAML_CHILD_KEY_RE = /^\s*([\w.-]+)\s*:(?:\s|$)/;

function extractYaml(b: ResultBuilder, text: string, compose: boolean): void {
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    const m = YAML_TOP_KEY_RE.exec(line);
    if (m) b.symbol(m[1]!.replace(/^["']|["']$/g, ''), 'key', i + 1, i + 1, line, true);
  });
  if (compose) extractCompose(b, lines);
}

function extractCompose(b: ResultBuilder, lines: string[]): void {
  let inServices = false;
  let svcIndent = -1;
  let current: string | null = null;
  let depsIndent = -1;
  const connect = (to: string, ln: number) => {
    if (current) b.edge(symbolRef(b.rel, current), 'CONNECTS_TO', symbolRef(b.rel, to), ln, CONF.config);
  };
  lines.forEach((raw, i) => {
    const line = raw.replace(/\r$/, '');
    const ln = i + 1;
    if (!line.trim() || line.trim().startsWith('#')) return;
    const indent = line.length - line.trimStart().length;
    if (indent === 0) {
      inServices = /^services\s*:/.test(line);
      current = null;
      return;
    }
    if (!inServices) return;
    if (svcIndent < 0) svcIndent = indent;
    if (indent === svcIndent) {
      const m = YAML_CHILD_KEY_RE.exec(line);
      current = m ? m[1]! : null;
      depsIndent = -1;
      if (current) b.symbol(current, 'other', ln, ln, `service ${current}`, true);
      return;
    }
    if (!current || indent < svcIndent) return;
    if (depsIndent >= 0 && indent > depsIndent) {
      const item = /^\s*-\s*['"]?([\w.-]+)/.exec(line) ?? YAML_CHILD_KEY_RE.exec(line);
      if (item && !['condition', 'restart', 'required'].includes(item[1]!)) connect(item[1]!.split(':')[0]!, ln);
      return;
    }
    depsIndent = -1;
    const deps = /^\s*(depends_on|links)\s*:\s*(.*)$/.exec(line);
    if (deps) {
      depsIndent = indent;
      const inline = /^\[(.*)\]/.exec(deps[2]!.trim());
      if (inline) for (const name of inline[1]!.split(',')) if (name.trim()) connect(name.trim().replace(/^["']|["']$/g, ''), ln);
      return;
    }
    const image = /^\s*image\s*:\s*['"]?([^'"\s#]+)/.exec(line);
    if (image) b.edge(symbolRef(b.rel, current), 'DEPENDS_ON', `module:${image[1]!}`, ln, CONF.config);
  });
}

// ---------------------------------------------------------------------------
// TOML (pyproject.toml, Cargo.toml, ...)
// ---------------------------------------------------------------------------

const TOML_HEADER_RE = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*$/;
const TOML_KV_RE = /^\s*("[^"]+"|'[^']+'|[\w.-]+)\s*=\s*(.*)$/;
const TOML_DEP_TABLE_RE = /^(?:(?:dev-|build-)?dependencies|workspace\.dependencies|target\..+\.(?:dev-|build-)?dependencies|tool\.poetry\.(?:dev-)?dependencies|tool\.poetry\.group\.[^.]+\.dependencies)$/;

function extractToml(b: ResultBuilder, text: string): void {
  const lines = text.split('\n');
  const seenTables = new Set<string>();
  let table = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.replace(/\r$/, '');
    const ln = i + 1;
    const h = TOML_HEADER_RE.exec(line);
    if (h) {
      table = h[1]!.replace(/["']/g, '');
      if (!seenTables.has(table)) b.symbol(table, 'key', ln, ln, line.trim(), true);
      seenTables.add(table);
      continue;
    }
    const kv = TOML_KV_RE.exec(line);
    if (!kv) continue;
    const key = kv[1]!.replace(/^["']|["']$/g, '');
    if (table === '') b.symbol(key, 'key', ln, ln, line.trim(), true);
    if (TOML_DEP_TABLE_RE.test(table) && key !== 'python') {
      b.edge(fileRef(b.rel), 'DEPENDS_ON', `module:${key}`, ln, CONF.config);
    } else if ((table === 'project' && key === 'dependencies') || table === 'project.optional-dependencies') {
      let arr = kv[2]!;
      let j = i;
      while (!arr.includes(']') && j + 1 < lines.length && j - i < 500) arr += `\n${lines[++j]!}`;
      for (const s of arr.matchAll(/["']([A-Za-z0-9][A-Za-z0-9_.-]*)/g)) b.edge(fileRef(b.rel), 'DEPENDS_ON', `module:${s[1]!}`, ln, CONF.config);
      i = j;
    }
  }
}

// ---------------------------------------------------------------------------
// Dockerfile, Terraform
// ---------------------------------------------------------------------------

const FROM_RE = /^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?/i;

function extractDockerfile(b: ResultBuilder, text: string): void {
  const stages = new Set<string>();
  text.split('\n').forEach((line, i) => {
    const m = FROM_RE.exec(line);
    if (!m) return;
    const image = m[1]!;
    if (!stages.has(image.toLowerCase()) && image.toLowerCase() !== 'scratch') {
      b.edge(fileRef(b.rel), 'DEPENDS_ON', `module:${image}`, i + 1, CONF.config);
    }
    if (m[2]) {
      stages.add(m[2].toLowerCase());
      b.symbol(m[2], 'other', i + 1, i + 1, line.trim(), true);
    }
  });
}

const TF_BLOCK2_RE = /^(resource|data)\s+"([^"]+)"\s+"([^"]+)"/;
const TF_BLOCK1_RE = /^(module|variable|output|provider)\s+"([^"]+)"/;

function extractTerraform(b: ResultBuilder, text: string): void {
  let inModule = false;
  text.split('\n').forEach((line, i) => {
    const ln = i + 1;
    let m = TF_BLOCK2_RE.exec(line);
    if (m) {
      inModule = false;
      b.symbol(`${m[1] === 'data' ? 'data.' : ''}${m[2]!}.${m[3]!}`, 'key', ln, ln, line.trim(), true);
      return;
    }
    if ((m = TF_BLOCK1_RE.exec(line))) {
      inModule = m[1] === 'module';
      b.symbol(`${m[1]!}.${m[2]!}`, 'key', ln, ln, line.trim(), true);
      return;
    }
    const src = inModule ? /^\s*source\s*=\s*"([^"]+)"/.exec(line) : null;
    if (src) b.edge(fileRef(b.rel), 'DEPENDS_ON', `module:${src[1]!}`, ln, CONF.config);
  });
}
