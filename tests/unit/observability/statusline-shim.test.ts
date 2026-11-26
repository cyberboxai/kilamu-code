import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cmdStatuslineAdmin, pluginRootPointer, recordPluginRoot, shimPath, statuslineCommand, statuslineDiagnostic } from '../../../src/cli/statusline.ts';

const REPO = resolve(import.meta.dirname, '..', '..', '..');

describe('update-safe statusline shim', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'kil-shim-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('installs a shim command and reports it as update-safe', () => {
    cmdStatuslineAdmin(root, ['install', '--scope', 'project']);
    const settings = JSON.parse(readFileSync(join(root, '.claude/settings.local.json'), 'utf8')) as { statusLine: { command: string } };
    expect(settings.statusLine.command).toBe(statuslineCommand());
    expect(existsSync(shimPath())).toBe(true);
    expect(readFileSync(pluginRootPointer(), 'utf8').trim()).toBe(REPO);
    expect(statuslineDiagnostic(root)).toMatchObject({ status: 'ok' });
  });

  it('follows the recorded plugin root after an "update" (new install path)', () => {
    cmdStatuslineAdmin(root, ['install', '--scope', 'project']);
    // Simulate a plugin update: a new version directory whose bin/kilamu prints a marker.
    const v2 = join(root, 'plugin-v2');
    mkdirSync(join(v2, 'bin'), { recursive: true });
    writeFileSync(join(v2, 'bin', 'kilamu'), '#!/bin/sh\necho "KILAMU v2 $1"\n');
    chmodSync(join(v2, 'bin', 'kilamu'), 0o755);
    recordPluginRoot(v2);
    const r = spawnSync(shimPath(), [], { input: '{}', encoding: 'utf8' });
    expect(r.stdout.trim()).toBe('KILAMU v2 statusline');
  });

  it('falls back to the install-time root when the recorded root vanished', () => {
    cmdStatuslineAdmin(root, ['install', '--scope', 'project']);
    writeFileSync(pluginRootPointer(), '/nonexistent/plugin\n');
    const r = spawnSync(shimPath(), [], { input: '{}', encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/KILAMU/);
  });

  it('ignores invalid roots', () => {
    recordPluginRoot('/definitely/not/a/plugin');
    recordPluginRoot('bad\nroot');
    if (existsSync(pluginRootPointer())) expect(readFileSync(pluginRootPointer(), 'utf8')).not.toMatch(/not\/a\/plugin|bad/);
  });
});
