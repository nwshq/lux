// siblings config tests (spec 10 Part A / Decision 1 / T1.1). The `siblings:` registry is
// fail-loud at config load: name grammar, reserved names, exactly-one-of package|path|db, role,
// the single-kernel invariant, and the kernel-sugar non-conflict all throw. The other sections
// (notably `refresh:`, shipped by #67) are unaffected — validateConfig MERGES the siblings key.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadLspConfig } from '../config.js';

let dir: string;

function writeConfig(yaml: string): string {
  dir = mkdtempSync(join(tmpdir(), 'lux-siblings-cfg-'));
  writeFileSync(join(dir, 'lux.yaml'), yaml);
  return dir;
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('validateSiblingsConfig (spec 10 Part A)', () => {
  it('parses package/path/db entries with role default peer', () => {
    const d = writeConfig(
      'siblings:\n' +
        '  auctic-core:\n    package: acme/core\n' +
        '  res:\n    path: ../res\n' +
        '  cached:\n    db: ./artifacts/res.db\n'
    );
    const cfg = loadLspConfig(d);
    expect(cfg.siblings).toBeDefined();
    expect(cfg.siblings!['auctic-core'].package).toBe('acme/core');
    expect(cfg.siblings!['auctic-core'].role).toBe('peer');
    expect(cfg.siblings!['res'].path).toBe('../res');
    expect(cfg.siblings!['res'].role).toBe('peer');
    expect(cfg.siblings!['cached'].db).toBe('./artifacts/res.db');
    expect(cfg.siblings!['cached'].role).toBe('peer');
  });

  it('accepts an explicit role: kernel', () => {
    const d = writeConfig('siblings:\n  core:\n    package: acme/core\n    role: kernel\n');
    expect(loadLspConfig(d).siblings!['core'].role).toBe('kernel');
  });

  it('leaves refresh: (and the other sections) unaffected — MERGE not replace', () => {
    const d = writeConfig(
      'refresh:\n  maxScopedFiles: 7\n' + 'siblings:\n  res:\n    path: ../res\n'
    );
    const cfg = loadLspConfig(d);
    expect(cfg.refresh).toEqual({ maxScopedFiles: 7, lspBudgetMs: 30000 });
    expect(cfg.siblings!['res'].path).toBe('../res');
  });

  it('returns undefined when no siblings section is present', () => {
    const d = writeConfig('lsp:\n  enabled: false\n');
    expect(loadLspConfig(d).siblings).toBeUndefined();
  });

  it('throws when two siblings declare role: kernel (single-kernel invariant)', () => {
    const d = writeConfig(
      'siblings:\n' +
        '  k1:\n    package: a/b\n    role: kernel\n' +
        '  k2:\n    package: c/d\n    role: kernel\n'
    );
    expect(() => loadLspConfig(d)).toThrow(/at most one sibling may declare role: kernel/);
  });

  it('throws when a role: kernel sibling coexists with overlay.kernel.package', () => {
    const d = writeConfig(
      'overlay:\n  kernel:\n    package: acme/core\n' +
        'siblings:\n  other:\n    package: foo/bar\n    role: kernel\n'
    );
    expect(() => loadLspConfig(d)).toThrow(/ambiguous/);
  });

  it('throws on zero-of package|path|db', () => {
    const d = writeConfig('siblings:\n  bad:\n    role: peer\n');
    expect(() => loadLspConfig(d)).toThrow(/exactly one of package\|path\|db/);
  });

  it('throws on two-of package|path|db', () => {
    const d = writeConfig('siblings:\n  bad:\n    package: a/b\n    path: ../x\n');
    expect(() => loadLspConfig(d)).toThrow(/exactly one of package\|path\|db/);
  });

  it('throws on a reserved name (baseline)', () => {
    const d = writeConfig('siblings:\n  baseline:\n    package: a/b\n');
    expect(() => loadLspConfig(d)).toThrow(/reserved name/);
  });

  it('throws on an invalid registry name (1x)', () => {
    const d = writeConfig('siblings:\n  "1x":\n    package: a/b\n');
    expect(() => loadLspConfig(d)).toThrow(/invalid name/);
  });

  it('throws on a malformed composer package', () => {
    const d = writeConfig('siblings:\n  okname:\n    package: NotAValidPackage\n');
    expect(() => loadLspConfig(d)).toThrow(/not a valid composer package/);
  });

  it('throws on an invalid role value', () => {
    const d = writeConfig('siblings:\n  s:\n    package: a/b\n    role: overlord\n');
    expect(() => loadLspConfig(d)).toThrow(/role must be 'kernel' or 'peer'/);
  });
});
