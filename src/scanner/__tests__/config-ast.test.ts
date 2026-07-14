// The AST structural tier is part of Lux's zero-config baseline: on unless
// explicitly opted out. These tests pin that contract through loadLspConfig.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadLspConfig } from '../config.js';

describe('loadLspConfig — AST tier default-on / opt-out', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lux-cfg-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('defaults ast.enabled to true when no lux.yaml is present', () => {
    expect(loadLspConfig(dir).ast?.enabled).toBe(true);
  });

  it('defaults ast.enabled to true when lux.yaml omits the ast section', () => {
    writeFileSync(join(dir, 'lux.yaml'), 'lsp:\n  enabled: false\n');
    expect(loadLspConfig(dir).ast?.enabled).toBe(true);
  });

  it('honors an explicit opt-out (ast.enabled: false)', () => {
    writeFileSync(join(dir, 'lux.yaml'), 'ast:\n  enabled: false\n');
    expect(loadLspConfig(dir).ast?.enabled).toBe(false);
  });

  it('keeps ast enabled when the section is present but empty', () => {
    writeFileSync(join(dir, 'lux.yaml'), 'ast: {}\n');
    expect(loadLspConfig(dir).ast?.enabled).toBe(true);
  });
});
