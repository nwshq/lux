import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { confinedRead, AdapterRefusal } from '../path-policy.js';
import { DEFAULT_PARSER_LIMITS } from '../types.js';
const input = (root: string, filePath: string, maxBytes = 100) => ({
  corpusRoot: root,
  allowedRoots: [root],
  filePath,
  limits: { ...DEFAULT_PARSER_LIMITS, maxBytes },
});
describe('infrastructure path safety', () => {
  it('reads regular in-root files once', () => {
    const r = mkdtempSync(join(tmpdir(), 'lux-infra-'));
    writeFileSync(join(r, 'a.tf'), 'resource{}');
    expect(new TextDecoder().decode(confinedRead(input(r, 'a.tf')).bytes)).toBe('resource{}');
    rmSync(r, { recursive: true });
  });
  it('refuses traversal and byte overflow', () => {
    const r = mkdtempSync(join(tmpdir(), 'lux-infra-'));
    writeFileSync(join(r, 'a.tf'), '123');
    expect(() => confinedRead(input(r, '../a.tf'))).toThrow(AdapterRefusal);
    expect(() => confinedRead(input(r, 'a.tf', 2))).toThrow(AdapterRefusal);
    rmSync(r, { recursive: true });
  });
  it('allows only in-root symlink targets', () => {
    const r = mkdtempSync(join(tmpdir(), 'lux-infra-'));
    writeFileSync(join(r, 'a.tf'), 'x');
    symlinkSync(join(r, 'a.tf'), join(r, 'b.tf'));
    expect(confinedRead(input(r, 'b.tf')).bytes.length).toBe(1);
    rmSync(r, { recursive: true });
  });
});
