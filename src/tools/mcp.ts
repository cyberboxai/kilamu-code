import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

export interface McpServerInfo {
  name: string;
  transport: 'stdio' | 'http' | 'sse' | 'unknown';
  command?: string;
}

export interface McpDiscovery {
  servers: McpServerInfo[];
  sources: string[];
  note: string;
}

const NOTE =
  'Only the project-scope .mcp.json was read. User- and local-scope servers live in Claude Code\'s own config and are not read; run `claude mcp list` to see them. Env values, headers and args are never read into results.';

function transportOf(cfg: Record<string, unknown>): McpServerInfo['transport'] {
  const t = cfg.type;
  if (t === 'stdio' || t === 'http' || t === 'sse') return t;
  if (typeof cfg.command === 'string') return 'stdio';
  return 'unknown';
}

/** Discover project-scoped MCP servers. Exposes only name, transport and command basename. */
export function discoverMcp(root: string): McpDiscovery {
  const file = join(root, '.mcp.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return { servers: [], sources: [], note: NOTE };
  }
  const block = (parsed as { mcpServers?: unknown } | null)?.mcpServers;
  if (typeof block !== 'object' || block === null || Array.isArray(block)) return { servers: [], sources: ['.mcp.json'], note: NOTE };
  const servers: McpServerInfo[] = [];
  for (const [name, raw] of Object.entries(block)) {
    const cfg = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
    const info: McpServerInfo = { name, transport: transportOf(cfg) };
    if (typeof cfg.command === 'string' && cfg.command) info.command = basename(cfg.command);
    servers.push(info);
  }
  servers.sort((a, b) => a.name.localeCompare(b.name));
  return { servers, sources: ['.mcp.json'], note: NOTE };
}
