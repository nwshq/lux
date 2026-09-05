import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LuxDatabase } from '../index.js';
import { MigrationRunner } from '../migrations.js';
import { openIndex } from '../open-policy.js';
import { LuxSqlite } from '../sqlite-adapter.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lux-open-policy-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function pathFor(name: string): string {
  return join(root, name, '.lux', 'lux.db');
}

function makeVersioned(path: string, version: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const db = new LuxSqlite(path);
  db.exec('CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER)');
  db.run('INSERT INTO schema_version (version, applied_at) VALUES (?, 1)', version);
  db.close();
}

function fingerprint(path: string): { hash: string; mtimeMs: number; entries: string[] } {
  const stat = statSync(path);
  return {
    hash: createHash('sha256').update(readFileSync(path)).digest('hex'),
    mtimeMs: stat.mtimeMs,
    entries: readdirSync(dirname(path)).sort(),
  };
}

function expectRefusal(
  result: ReturnType<typeof openIndex>,
  refusal: 'index-absent' | 'schema-too-old' | 'schema-too-new' | 'db-unreadable'
): void {
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.refusal).toBe(refusal);
}

describe('openIndex policy', () => {
  it.each(['read-existing', 'write-existing'] as const)(
    '%s refuses an absent index without creating its parent tree',
    (mode) => {
      const path = pathFor(mode);
      expectRefusal(openIndex(path, mode), 'index-absent');
      expect(existsSync(path)).toBe(false);
      expect(existsSync(join(root, mode))).toBe(false);
    }
  );

  it.each(['read-existing', 'write-existing'] as const)(
    '%s refuses an old schema without migrating or changing the file',
    (mode) => {
      const path = pathFor(`old-${mode}`);
      makeVersioned(path, MigrationRunner.latestVersion() - 1);
      const before = fingerprint(path);

      const result = openIndex(path, mode);

      expectRefusal(result, 'schema-too-old');
      expect(fingerprint(path)).toEqual(before);
    }
  );

  it.each(['read-existing', 'write-existing', 'create-or-migrate'] as const)(
    '%s refuses a future schema without changing the file',
    (mode) => {
      const path = pathFor(`new-${mode}`);
      makeVersioned(path, MigrationRunner.latestVersion() + 1);
      const before = fingerprint(path);

      const result = openIndex(path, mode);

      expectRefusal(result, 'schema-too-new');
      expect(fingerprint(path)).toEqual(before);
    }
  );

  it.each(['read-existing', 'write-existing', 'create-or-migrate'] as const)(
    '%s returns db-unreadable for corrupt bytes and leaves them untouched',
    (mode) => {
      const path = pathFor(`corrupt-${mode}`);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, 'not a sqlite database\n');
      const before = fingerprint(path);

      const result = openIndex(path, mode);

      expectRefusal(result, 'db-unreadable');
      expect(fingerprint(path)).toEqual(before);
    }
  );

  it('read-existing opens a current index strictly read-only', () => {
    const path = pathFor('read-current');
    const writer = new LuxDatabase(path);
    writer.close();
    const before = fingerprint(path);

    const result = openIndex(path, 'read-existing');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.schemaVersion).toBe(MigrationRunner.latestVersion());
    expect(() => result.db.setIndexMetadata('read-policy-probe', 'x')).toThrow(
      /readonly|read.only/i
    );
    // A failed cached write can be re-thrown while the WASM adapter finalizes it, so this test
    // intentionally leaves cleanup to the adapter's process hook.
    expect(fingerprint(path)).toEqual(before);
  });

  it('write-existing opens a current index without running migrations', () => {
    const path = pathFor('write-current');
    const seed = new LuxDatabase(path);
    seed.close();

    const result = openIndex(path, 'write-existing');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.schemaVersion).toBe(MigrationRunner.latestVersion());
    result.db.setIndexMetadata('write-policy-probe', 'ok');
    expect(result.db.getIndexMetadata('write-policy-probe')).toBe('ok');
    result.db.close();
  });

  it('create-or-migrate creates and migrates an absent index', () => {
    const path = pathFor('create');

    const result = openIndex(path, 'create-or-migrate');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(existsSync(path)).toBe(true);
    expect(result.schemaVersion).toBe(MigrationRunner.latestVersion());
    result.db.close();
  });

  it('create-or-migrate advances an old index to the packaged schema', () => {
    const path = pathFor('migrate');
    makeVersioned(path, 0);

    const result = openIndex(path, 'create-or-migrate');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.schemaVersion).toBe(MigrationRunner.latestVersion());
    result.db.close();
  });
});
