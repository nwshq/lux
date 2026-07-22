// refresh config tests (spec 15 Part B / Decisions 7,8 / T3b.2). The refresh section carries the
// scoped-refresh budgets. Absent ⇒ the shipped defaults; a non-positive maxScopedFiles or a
// negative lspBudgetMs is a hard error (a zero/negative budget silently disables a tier); the
// other config sections are unaffected.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadLspConfig, DEFAULT_REFRESH_CONFIG } from '../config.js';

let dir: string;

function writeConfig(yaml: string): string {
  dir = mkdtempSync(join(tmpdir(), 'lux-refresh-cfg-'));
  writeFileSync(join(dir, 'lux.yaml'), yaml);
  return dir;
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('loadLspConfig — refresh (spec 15 Part B)', () => {
  it('defaults to 100 / 30000 when the section is absent', () => {
    const d = writeConfig('lsp:\n  enabled: false\n');
    expect(loadLspConfig(d).refresh).toEqual({ maxScopedFiles: 100, lspBudgetMs: 30000 });
    expect(loadLspConfig(d).refresh).toEqual(DEFAULT_REFRESH_CONFIG);
  });

  it('omits refresh when no lux.yaml is present (matching the delta convention; the decision layer applies DEFAULT_REFRESH_CONFIG)', () => {
    const d = mkdtempSync(join(tmpdir(), 'lux-refresh-nocfg-'));
    dir = d;
    // No lux.yaml short-circuits to DEFAULT_CONFIG, which carries no optional sections — the
    // sync-escalation decision guards this with `config.refresh ?? DEFAULT_REFRESH_CONFIG`.
    expect(loadLspConfig(d).refresh).toBeUndefined();
  });

  it('parses explicit budgets', () => {
    const d = writeConfig('refresh:\n  maxScopedFiles: 25\n  lspBudgetMs: 5000\n');
    expect(loadLspConfig(d).refresh).toEqual({ maxScopedFiles: 25, lspBudgetMs: 5000 });
  });

  it('fills a partially-specified section from the defaults', () => {
    const d = writeConfig('refresh:\n  maxScopedFiles: 10\n');
    expect(loadLspConfig(d).refresh).toEqual({ maxScopedFiles: 10, lspBudgetMs: 30000 });
  });

  it('allows lspBudgetMs: 0 (a valid opt-out of the LSP tier)', () => {
    const d = writeConfig('refresh:\n  lspBudgetMs: 0\n');
    expect(loadLspConfig(d).refresh).toEqual({ maxScopedFiles: 100, lspBudgetMs: 0 });
  });

  it('rejects a non-positive maxScopedFiles', () => {
    const d = writeConfig('refresh:\n  maxScopedFiles: 0\n');
    expect(() => loadLspConfig(d)).toThrow(/refresh.maxScopedFiles/);
  });

  it('rejects a non-integer maxScopedFiles', () => {
    const d = writeConfig('refresh:\n  maxScopedFiles: 2.5\n');
    expect(() => loadLspConfig(d)).toThrow(/refresh.maxScopedFiles/);
  });

  it('rejects a negative lspBudgetMs', () => {
    const d = writeConfig('refresh:\n  lspBudgetMs: -1\n');
    expect(() => loadLspConfig(d)).toThrow(/refresh.lspBudgetMs/);
  });

  it('rejects a non-mapping refresh section', () => {
    const d = writeConfig('refresh: not-a-mapping\n');
    expect(() => loadLspConfig(d)).toThrow(/"refresh" must be a mapping/);
  });

  it('leaves the other config sections unaffected', () => {
    const d = writeConfig(
      'lsp:\n  enabled: false\ndelta:\n  gates:\n    - overlay-not-complete\nrefresh:\n  maxScopedFiles: 7\n'
    );
    const cfg = loadLspConfig(d);
    expect(cfg.refresh).toEqual({ maxScopedFiles: 7, lspBudgetMs: 30000 });
    expect(cfg.delta).toEqual({ gates: ['overlay-not-complete'] });
    expect(cfg.lsp.enabled).toBe(false);
  });
});
