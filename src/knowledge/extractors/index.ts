import type { Language } from '../languages.ts';
import type { Extractor } from './common.ts';
import * as cfamily from './cfamily.ts';
import * as config from './config.ts';
import * as csharp from './csharp.ts';
import * as go from './go.ts';
import * as jvm from './jvm.ts';
import * as markdown from './markdown.ts';
import * as python from './python.ts';
import * as rust from './rust.ts';
import * as sql from './sql.ts';
import * as typescript from './typescript.ts';

export type { ExtractContext, ExtractResult, Extractor } from './common.ts';

const asExtractor = (m: { PARSER_NAME: string; PARSER_VERSION: number; extract: Extractor['extract'] }): Extractor => ({
  name: m.PARSER_NAME,
  version: m.PARSER_VERSION,
  extract: m.extract,
});

const TS = asExtractor(typescript);
const MD = asExtractor(markdown);
const CFG = asExtractor(config);
const JVM = asExtractor(jvm);
const CF = asExtractor(cfamily);

/** Structural extractor per language. Languages absent here are indexed as text only. */
export const EXTRACTORS: Partial<Record<Language, Extractor>> = {
  typescript: TS, tsx: TS, javascript: TS, jsx: TS,
  python: asExtractor(python),
  go: asExtractor(go),
  rust: asExtractor(rust),
  java: JVM, kotlin: JVM,
  c: CF, cpp: CF,
  csharp: asExtractor(csharp),
  sql: asExtractor(sql),
  markdown: MD, rst: MD,
  json: CFG, yaml: CFG, toml: CFG, dockerfile: CFG, terraform: CFG,
};

/** Parser identity for text-only files (FTS chunks, no symbols/edges). */
export const TEXT_PARSER = { name: 'text', version: 1 } as const;
export const PDF_PARSER = { name: 'pdftotext', version: 1 } as const;
export const NO_PARSER = { name: 'none', version: 0 } as const;
