/**
 * Architectural layer classification from path heuristics, used to order
 * impact reports from storage outward. Heuristic: a file is assigned the first
 * matching rule in CLASSIFY_ORDER; tests and docs are recognised first so that
 * `tests/test_models.py` is a test, not a model.
 */
export type Layer = 'database' | 'model' | 'repository' | 'service' | 'api' | 'frontend' | 'test' | 'docs' | 'config' | 'other';

/** Output order for impact reports. */
export const LAYER_ORDER: readonly Layer[] = ['database', 'model', 'repository', 'service', 'api', 'frontend', 'test', 'docs', 'config', 'other'];

const DOC_LANGS = new Set(['markdown', 'rst', 'text', 'pdf']);
const CONFIG_LANGS = new Set(['json', 'yaml', 'toml', 'dockerfile', 'terraform']);

const seg = (names: string) => new RegExp(`(?:^|/)(?:${names})(?:/|\\.[\\w.]+$|_[\\w.]*$)`);

const RULES: Array<{ layer: Layer; test: (p: string, lang: string) => boolean }> = [
  {
    layer: 'test',
    test: (p) => /(?:^|\/)(?:tests?|__tests__|specs?|e2e|testing)\//.test(p) || /\.(?:test|spec)\.\w+$/.test(p) || /(?:^|\/)test_[^/]*\.py$/.test(p) || /_test\.(?:go|py)$/.test(p) || /Tests?\.(?:java|kt|cs)$/i.test(p),
  },
  { layer: 'docs', test: (p, lang) => DOC_LANGS.has(lang) || /(?:^|\/)docs?\//.test(p) },
  {
    layer: 'database',
    test: (p, lang) => lang === 'sql' || /(?:^|\/)(?:migrations?|migrate|alembic|flyway|liquibase|db|database|schema)\//.test(p) || /(?:^|\/)schema\.(?:prisma|rb)$/.test(p),
  },
  { layer: 'model', test: (p) => seg('models?|entities|entity|orm|domain/model').test(p) || /\.(?:model|entity)\.\w+$/.test(p) },
  { layer: 'repository', test: (p) => seg('repositor(?:y|ies)|repos?|daos?|stores?|persistence|data[-_]?access').test(p) || /(?:repository|repo|dao|store)\.\w+$/i.test(p) },
  {
    layer: 'frontend',
    test: (p) => /\.(?:tsx|jsx|vue|svelte|astro|css|scss|sass|less|html)$/.test(p) || /(?:^|\/)(?:frontend|client|web|ui|components?|pages|views?\/components|app\/\(.*\)|public|static)\//.test(p),
  },
  {
    layer: 'api',
    test: (p) => seg('api|apis|routes?|routers?|controllers?|handlers?|endpoints?|views|resources|rest|graphql|resolvers?|urls').test(p) || /(?:controller|router|routes|handler|resolver|endpoints?)\.\w+$/i.test(p),
  },
  { layer: 'service', test: (p) => seg('services?|usecases?|use[-_]cases|business|logic|managers?|interactors?').test(p) || /service\.\w+$/i.test(p) },
  { layer: 'config', test: (p, lang) => CONFIG_LANGS.has(lang) || /(?:^|\/)(?:config|conf|settings|deploy|infra|\.github)\//.test(p) || /(?:^|\/)settings\.py$/.test(p) },
];

export function classifyLayer(path: string, language: string): Layer {
  const p = path.toLowerCase();
  for (const rule of RULES) if (rule.test(p, language)) return rule.layer;
  return 'other';
}
