/** A command returns structured data plus a human rendering; `--json` selects data. */
export interface CommandResult {
  data: unknown;
  text: string;
  exitCode?: number;
}

export function emit(r: CommandResult, json: boolean): number {
  const out = json ? JSON.stringify(r.data, null, 2) : r.text;
  if (out) process.stdout.write(out.endsWith('\n') ? out : `${out}\n`);
  return r.exitCode ?? 0;
}
