// LuxDatabaseOptions backward-compat + the read-only open guard (spec 11 Part A / T1.3 / SC-7).
// The new third constructor param defaults to {}, so every `new LuxDatabase(path)` and
// `new LuxDatabase(path, false)` call site is unchanged. `{ readOnly: true }` threads
// fileMustExist to the engine: a nonexistent file throws rather than being created (no mkdir).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LuxDatabase } from '../index.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lux-db-options-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('LuxDatabase constructor options (backward compat)', () => {
  it('new LuxDatabase(path) still creates + migrates the file (writable path)', () => {
    const p = join(root, 'a', '.lux', 'lux.db');
    const db = new LuxDatabase(p);
    expect(existsSync(p)).toBe(true);
    expect(db.getAppliedSchemaVersion()).toBeGreaterThan(0);
    db.close();
  });

  it('new LuxDatabase(path, false) still creates the file (mkdir ran, no auto-migration)', () => {
    const p = join(root, 'b', '.lux', 'lux.db');
    const db = new LuxDatabase(p, false);
    expect(existsSync(p)).toBe(true);
    // A normal writable handle — migrations can be run explicitly.
    expect(db.runMigrations()).toBeGreaterThan(0);
    expect(db.getAppliedSchemaVersion()).toBeGreaterThan(0);
    db.close();
  });

  it('{ readOnly: true } on a nonexistent file throws (fileMustExist) and creates nothing', () => {
    const ghost = join(root, 'ghost', '.lux', 'lux.db');
    expect(() => new LuxDatabase(ghost, false, { readOnly: true })).toThrow();
    expect(existsSync(ghost)).toBe(false);
    expect(existsSync(join(root, 'ghost'))).toBe(false); // mkdir skipped for read-only opens
  });
});
