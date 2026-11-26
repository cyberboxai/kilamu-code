import { redact } from '../core/redact.ts';

/**
 * Split text into overlapping line windows for full-text search. Every chunk
 * is redacted before it leaves this module, so callers cannot persist raw
 * secrets by accident.
 */
export interface Chunk {
  lineStart: number;
  lineEnd: number;
  content: string;
}

export const CHUNK_LINES = 40;
export const CHUNK_OVERLAP = 5;

export function chunkText(text: string, windowLines = CHUNK_LINES, overlap = CHUNK_OVERLAP): Chunk[] {
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const step = Math.max(1, windowLines - overlap);
  const chunks: Chunk[] = [];
  for (let start = 0; start < lines.length; start += step) {
    const end = Math.min(lines.length, start + windowLines);
    const body = lines.slice(start, end).join('\n');
    if (body.trim()) chunks.push({ lineStart: start + 1, lineEnd: end, content: redact(body).text });
    if (end === lines.length) break;
  }
  return chunks;
}

/** One chunk per PDF page (pdftotext separates pages with form feeds); lines = page numbers. */
export function chunkPages(text: string): Chunk[] {
  const chunks: Chunk[] = [];
  text.split('\f').forEach((page, i) => {
    if (page.trim()) chunks.push({ lineStart: i + 1, lineEnd: i + 1, content: redact(page).text });
  });
  return chunks;
}
