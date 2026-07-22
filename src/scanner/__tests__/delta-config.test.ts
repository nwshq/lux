// The delta.gates section is the CI/local gate policy (spec 14 Part A, Decision 7). These tests
// pin the parse contract through loadLspConfig and confirm the other config sections are
// unaffected. Category *names* are intentionally NOT validated here — the unknown-category
// hard-error happens at gate-resolution time (see gate.test.ts), so both --fail-on and
// delta.gates hit the identical check.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadLspConfig } from '../config.js';

describe('loadLspConfig — delta.gates (spec 14 Part A)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lux-delta-cfg-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('parses delta.gates into a string[]', () => {
    writeFileSync(
      join(dir, 'lux.yaml'),
      'delta:\n  gates:\n    - overlay-not-complete\n    - budget-truncated\n'
    );
    expect(loadLspConfig(dir).delta).toEqual({
      gates: ['overlay-not-complete', 'budget-truncated'],
    });
  });

  it('returns undefined delta when no lux.yaml is present', () => {
    expect(loadLspConfig(dir).delta).toBeUndefined();
  });

  it('returns undefined delta when the section is absent', () => {
    writeFileSync(join(dir, 'lux.yaml'), 'lsp:\n  enabled: false\n');
    expect(loadLspConfig(dir).delta).toBeUndefined();
  });

  it('returns undefined delta when gates is not an array', () => {
    writeFileSync(join(dir, 'lux.yaml'), 'delta:\n  gates: overlay-not-complete\n');
    expect(loadLspConfig(dir).delta).toBeUndefined();
  });

  it('returns undefined delta when gates is an empty array', () => {
    writeFileSync(join(dir, 'lux.yaml'), 'delta:\n  gates: []\n');
    expect(loadLspConfig(dir).delta).toBeUndefined();
  });

  it('drops non-string gate entries but keeps the string ones (names validated later)', () => {
    writeFileSync(
      join(dir, 'lux.yaml'),
      'delta:\n  gates:\n    - overlay-not-complete\n    - 42\n    - not-a-known-category\n'
    );
    // Unknown *names* survive parse — the hard error is at gate-resolution time.
    expect(loadLspConfig(dir).delta).toEqual({
      gates: ['overlay-not-complete', 'not-a-known-category'],
    });
  });

  it('does not disturb the other config sections', () => {
    writeFileSync(
      join(dir, 'lux.yaml'),
      'delta:\n  gates:\n    - overlay-not-complete\nast:\n  enabled: false\n'
    );
    const config = loadLspConfig(dir);
    expect(config.delta).toEqual({ gates: ['overlay-not-complete'] });
    expect(config.ast?.enabled).toBe(false);
    expect(config.deps.enabled).toBe(true);
    expect(config.lsp.enabled).toBe(false);
  });
});
