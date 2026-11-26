import { posix } from 'node:path';

/**
 * Language detection by extension or basename. Pure; no I/O.
 * Language ids are stable strings stored in `files.language`.
 */
export type Language =
  | 'typescript' | 'tsx' | 'javascript' | 'jsx'
  | 'python' | 'go' | 'rust' | 'java' | 'kotlin' | 'c' | 'cpp' | 'csharp' | 'ruby' | 'php'
  | 'sql' | 'markdown' | 'rst' | 'text'
  | 'json' | 'yaml' | 'toml' | 'dockerfile' | 'terraform'
  | 'pdf' | 'other';

const BY_EXTENSION: Record<string, Language> = {
  '.ts': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.jsx': 'jsx',
  '.py': 'python', '.pyi': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.kt': 'kotlin', '.kts': 'kotlin',
  '.c': 'c', '.h': 'c',
  '.cpp': 'cpp', '.hpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp', '.hh': 'cpp', '.hxx': 'cpp',
  '.cs': 'csharp',
  '.rb': 'ruby',
  '.php': 'php',
  '.sql': 'sql',
  '.md': 'markdown', '.mdx': 'markdown', '.markdown': 'markdown',
  '.rst': 'rst',
  '.txt': 'text',
  '.json': 'json', '.jsonc': 'json',
  '.yaml': 'yaml', '.yml': 'yaml',
  '.toml': 'toml',
  '.dockerfile': 'dockerfile',
  '.tf': 'terraform', '.tfvars': 'terraform',
  '.pdf': 'pdf',
};

/** Languages whose source text is "code" for cross-layer identifier linking. */
export const CODE_LANGUAGES: ReadonlySet<Language> = new Set<Language>([
  'typescript', 'tsx', 'javascript', 'jsx', 'python', 'go', 'rust', 'java', 'kotlin', 'c', 'cpp', 'csharp', 'ruby', 'php',
]);

export function detectLanguage(rel: string): Language {
  const base = posix.basename(rel);
  if (/^(Dockerfile|Containerfile)(\..+)?$/.test(base)) return 'dockerfile';
  const ext = posix.extname(base).toLowerCase();
  return BY_EXTENSION[ext] ?? 'other';
}
