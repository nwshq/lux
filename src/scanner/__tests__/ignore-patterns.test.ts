// Lever A — configurable generated-artifact exclusion. Verifies the effective
// ignore-set resolver and that GeneralScanner honours it: generated bundles are
// dropped by default, dependencies are ALWAYS dropped, and the exclusion is
// configurable (opt-out + extra patterns).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GeneralScanner,
  resolveIgnorePatterns,
  GENERATED_ARTIFACT_PATTERNS,
  SOURCE_CODE_IGNORE_PATTERNS,
} from '../general.js';

describe('resolveIgnorePatterns', () => {
  it('includes generated-artifact patterns by default', () => {
    const patterns = resolveIgnorePatterns();
    for (const p of GENERATED_ARTIFACT_PATTERNS) expect(patterns).toContain(p);
    expect(patterns).toContain('vendor/**');
    expect(patterns).toContain('node_modules/**');
  });

  it('omits generated-artifact patterns when excludeGeneratedArtifacts is false', () => {
    const patterns = resolveIgnorePatterns({
      excludeGeneratedArtifacts: false,
      ignorePatterns: [],
    });
    expect(patterns).not.toContain('public/**');
    // Dependencies stay excluded regardless of the flag.
    expect(patterns).toContain('vendor/**');
    expect(patterns).toContain('node_modules/**');
  });

  it('unions extra ignorePatterns with the built-ins', () => {
    const patterns = resolveIgnorePatterns({
      excludeGeneratedArtifacts: true,
      ignorePatterns: ['storage/**'],
    });
    expect(patterns).toContain('storage/**');
    expect(patterns).toContain('public/**');
  });
});

describe('GeneralScanner generated-artifact exclusion', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lux-ignore-'));
    writeFileSync(join(dir, 'package.json'), '{}'); // marks a source repo
    mkdirSync(join(dir, 'public'), { recursive: true });
    mkdirSync(join(dir, 'src'), { recursive: true });
    mkdirSync(join(dir, 'storage'), { recursive: true });
    writeFileSync(join(dir, 'public', 'app.js'), 'console.log(1);');
    writeFileSync(join(dir, 'src', 'index.ts'), 'export const x = 1;');
    writeFileSync(join(dir, 'src', 'app.bundle.js'), 'console.log(2);');
    writeFileSync(join(dir, 'storage', 'gen.ts'), 'export const y = 2;');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function titles(scanner: GeneralScanner) {
    return scanner
      .scan(dir)
      .then((r) => r.knowledge.filter((k) => k.type === 'source-code').map((k) => k.title));
  }

  it('excludes public/ bundles and *.bundle.js by default but keeps authored source', async () => {
    const scanner = new GeneralScanner(dir, resolveIgnorePatterns());
    const found = await titles(scanner);
    expect(found).toContain('src/index.ts');
    expect(found).not.toContain('public/app.js');
    expect(found).not.toContain('src/app.bundle.js');
  });

  it('re-includes public/app.js when excludeGeneratedArtifacts is false', async () => {
    const scanner = new GeneralScanner(
      dir,
      resolveIgnorePatterns({ excludeGeneratedArtifacts: false, ignorePatterns: [] })
    );
    const found = await titles(scanner);
    expect(found).toContain('public/app.js');
    expect(found).toContain('src/index.ts');
  });

  it('drops files matched by an extra ignorePatterns entry', async () => {
    const scanner = new GeneralScanner(
      dir,
      resolveIgnorePatterns({ excludeGeneratedArtifacts: true, ignorePatterns: ['storage/**'] })
    );
    const found = await titles(scanner);
    expect(found).not.toContain('storage/gen.ts');
    expect(found).toContain('src/index.ts');
  });

  it('defaults to the always-excluded base set when no ignore patterns are passed', () => {
    // Constructor default keeps existing zero-arg callers unchanged.
    const scanner = new GeneralScanner(dir);
    expect(scanner).toBeInstanceOf(GeneralScanner);
    expect(SOURCE_CODE_IGNORE_PATTERNS).toContain('node_modules/**');
  });
});
