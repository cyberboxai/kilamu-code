import type { TaskClass } from '../core/types.ts';
import type { McpServerInfo } from './mcp.ts';

export interface ToolRecommendation {
  local: string[];
  mcp: Array<{ name: string; reason: string }>;
  rationale: string[];
}

const LOCAL: Record<TaskClass, string[]> = {
  classification: ['kilamu search', 'Grep'],
  discovery: ['kilamu search', 'kilamu impact', 'Grep', 'Glob'],
  summarization: ['Read', 'kilamu artifact show'],
  research: ['Read', 'kilamu search', 'WebSearch'],
  implementation: ['kilamu search', 'kilamu impact', 'Read', 'Edit'],
  debugging: ['Grep', 'kilamu impact', 'Read', 'kilamu verify'],
  architecture: ['kilamu search', 'kilamu impact', 'Read'],
  security: ['Grep', 'kilamu search', 'Read'],
  verification: ['kilamu verify'],
};

interface McpRule {
  keywords: RegExp;
  classes: TaskClass[];
  reason: string;
}

const MCP_RULES: McpRule[] = [
  { keywords: /db|postgres|sqlite|mysql|database|sql/i, classes: ['implementation', 'debugging', 'architecture', 'discovery'], reason: 'database server for schema and query work' },
  { keywords: /github|gitlab/i, classes: ['verification', 'security', 'discovery'], reason: 'repository host for review and PR context' },
  { keywords: /docs|context7|documentation/i, classes: ['research', 'implementation', 'architecture'], reason: 'documentation server for authoritative API references' },
  { keywords: /browser|playwright|puppeteer/i, classes: ['verification', 'debugging'], reason: 'browser automation for end-to-end checks' },
];

export function recommendTools(taskClass: TaskClass, servers: Array<Pick<McpServerInfo, 'name'>>): ToolRecommendation {
  const mcp: ToolRecommendation['mcp'] = [];
  for (const s of servers) {
    const rule = MCP_RULES.find((r) => r.classes.includes(taskClass) && r.keywords.test(s.name));
    if (rule) mcp.push({ name: s.name, reason: rule.reason });
  }
  const rationale = [`${taskClass}: local tools first (no extra context cost, no external access)`];
  rationale.push(mcp.length > 0 ? `${mcp.length} MCP server(s) matched by name; use only if local tools cannot answer` : 'no MCP server matched this task class');
  return { local: [...LOCAL[taskClass]], mcp, rationale };
}
