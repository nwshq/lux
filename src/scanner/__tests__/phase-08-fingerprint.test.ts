import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LuxDatabase } from '../../db/index.js';
import {
  computeStructuralConfigFingerprint,
  rememberProjectResolutionFingerprintInputs,
} from '../config-fingerprint.js';

const roots: string[] = [];

afterEach(() => {
  forEachRoot((root) => rmSync(root, { recursive: true, force: true }));
});

function fixture(): { root: string; db: LuxDatabase } {
  const root = mkdtempSync(join(tmpdir(), 'lux-p08-fingerprint-'));
  roots.push(root);
  mkdirSync(join(root, 'packages/pkg'), { recursive: true });
  writeFileSync(join(root, 'lux.yaml'), 'lsp:\n  enabled: false\n');
  writeFileSync(join(root, 'tsconfig.json'), '{"compilerOptions":{"baseUrl":"."}}\n');
  writeFileSync(join(root, 'packages/pkg/package.json'), '{"name":"@acme/pkg"}\n');
  return { root, db: new LuxDatabase(join(root, 'lux.db')) };
}

function forEachRoot(operation: (root: string) => void): void {
  for (const root of roots.splice(0)) operation(root);
}

describe('Phase 8 project-resolution config fingerprint', () => {
  it('hashes sorted dependency paths and raw bytes', () => {
    const { root, db } = fixture();
    rememberProjectResolutionFingerprintInputs(root, [
      'packages/pkg/package.json',
      'tsconfig.json',
    ]);
    const first = computeStructuralConfigFingerprint(root, db);
    writeFileSync(join(root, 'tsconfig.json'), '{"compilerOptions":{"baseUrl":"src"}}\n');
    const second = computeStructuralConfigFingerprint(root, db);
    expect(second).not.toBe(first);
    db.close();
  });

  it('changes when a prior dependency is removed', () => {
    const { root, db } = fixture();
    rememberProjectResolutionFingerprintInputs(root, ['packages/pkg/package.json']);
    const first = computeStructuralConfigFingerprint(root, db);
    rmSync(join(root, 'packages/pkg/package.json'));
    expect(computeStructuralConfigFingerprint(root, db)).not.toBe(first);
    db.close();
  });
});
