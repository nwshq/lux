// LUX_VERSION regression guard: the single version source must equal the real package manifest —
// a re-hardcode at any consumer (the pre-consolidation MCP '0.1.0') or a resolution-path drift
// (src/utils vs dist/utils layout) fails here.

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LUX_VERSION } from '../version.js';

describe('LUX_VERSION', () => {
  it('equals the package manifest version (single source of truth)', () => {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version: string };
    expect(LUX_VERSION).toBe(pkg.version);
    expect(LUX_VERSION.length).toBeGreaterThan(0);
  });

  // The compiled resolver walks dist/utils → package root; a tsconfig rootDir/outDir change would
  // pass every src-run test yet break `lux --version` and MCP server startup. Same skip-if-unbuilt
  // guard as the MCP wire tests (the `check` gate builds before testing, so CI always runs this).
  const DIST_CLI = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    'dist',
    'cli',
    'index.js'
  );
  it.skipIf(!existsSync(DIST_CLI))('resolves from the compiled dist layout', () => {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version: string };
    const res = spawnSync(process.execPath, [DIST_CLI, '--version'], { encoding: 'utf-8' });
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe(pkg.version);
  });
});
