import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { LuxDatabase } from '../../../db/index.js';
import { LuxSqlite } from '../../../db/sqlite-adapter.js';
import { openDeltaDatabase, resolveDeltaBase, isRefusal } from '../preflight.js';
import type { DeltaRefusal } from '../types.js';

let root: string;

function tmp(name: string): string {
  return join(root, `${name}-${Math.random().toString(36).slice(2)}`);
}

function git(cwd: string, args: string): void {
  execSync(`git ${args}`, { cwd, stdio: 'pipe' });
}

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init -q');
  git(dir, 'config user.email test@example.com');
  git(dir, 'config user.name Test');
  git(dir, 'config commit.gpgsign false');
}

/** A stale-schema index: the migration ledger sits at v10 (predating migration 011/013), and the
 *  011/013 tables/columns are absent — so preparing the read queries WOULD throw. */
function makeStaleSchemaDb(dbPath: string): void {
  mkdirSync(join(dbPath, '..'), { recursive: true });
  const raw = new LuxSqlite(dbPath);
  raw.exec(
    `CREATE TABLE IF NOT EXISTS schema_version (
       version INTEGER PRIMARY KEY,
       applied_at INTEGER NOT NULL DEFAULT (unixepoch())
     )`
  );
  for (let v = 1; v <= 10; v++) raw.run('INSERT INTO schema_version (version) VALUES (?)', v);
  raw.close();
}

function maxSchemaVersion(dbPath: string): number {
  const raw = new LuxSqlite(dbPath);
  const row = raw.get('SELECT MAX(version) AS v FROM schema_version') as { v: number | null };
  raw.close();
  return row.v ?? 0;
}

describe('delta preflight (spec 10 Part B)', () => {
  beforeEach(() => {
    root = join(
      tmpdir(),
      `lux-delta-preflight-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    mkdirSync(root, { recursive: true });
  });
  afterEach(() => {
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  });

  describe('openDeltaDatabase', () => {
    it('refuses db-absent for a nonexistent path', () => {
      const opened = openDeltaDatabase(join(root, 'nope', 'lux.db'));
      expect('refusal' in opened).toBe(true);
      if ('refusal' in opened) expect(opened.refusal.reason).toBe('db-absent');
    });

    it('refuses a stale schema by RETURNING the refusal (not throwing) and does not migrate', () => {
      const dbPath = join(tmp('stale'), 'lux.db');
      makeStaleSchemaDb(dbPath);
      expect(maxSchemaVersion(dbPath)).toBe(10);

      let opened!: ReturnType<typeof openDeltaDatabase>;
      expect(() => {
        opened = openDeltaDatabase(dbPath);
      }).not.toThrow();

      expect('refusal' in opened).toBe(true);
      if ('refusal' in opened) expect(opened.refusal.reason).toBe('schema-stale');
      // refuse, never migrate — the ledger is untouched.
      expect(maxSchemaVersion(dbPath)).toBe(10);
    });

    it('opens a current-schema index and initializes read queries', () => {
      const dbPath = join(tmp('healthy'), 'lux.db');
      const seed = new LuxDatabase(dbPath); // autoMigrate=true → current schema
      seed.close();

      const opened = openDeltaDatabase(dbPath);
      expect('db' in opened).toBe(true);
      if ('db' in opened) {
        // read queries are prepared → a read works without throwing.
        expect(() => opened.db.getIndexMetadata('last_indexed_commit')).not.toThrow();
        opened.db.close();
      }
    });
  });

  describe('resolveDeltaBase', () => {
    function healthyDb(): LuxDatabase {
      return new LuxDatabase(join(tmp('db'), 'lux.db'));
    }

    it('returns not-a-git-repo (never throws) for a non-git corpus', () => {
      const corpus = tmp('plain');
      mkdirSync(corpus, { recursive: true });
      const db = healthyDb();
      let res!: ReturnType<typeof resolveDeltaBase>;
      expect(() => {
        res = resolveDeltaBase(corpus, db, undefined);
      }).not.toThrow();
      expect(isRefusal(res)).toBe(true);
      expect((res as DeltaRefusal).reason).toBe('not-a-git-repo');
      db.close();
    });

    it('returns baseline-unavailable for a malformed / leading-dash --base', () => {
      const corpus = tmp('repo');
      initRepo(corpus);
      const db = healthyDb();
      const res = resolveDeltaBase(corpus, db, '--output=/tmp/x');
      expect(isRefusal(res)).toBe(true);
      expect((res as DeltaRefusal).reason).toBe('baseline-unavailable');
      db.close();
    });

    it('defaults to last_indexed_commit when --base is omitted', () => {
      const corpus = tmp('repo');
      initRepo(corpus);
      execSync('git commit -q --allow-empty -m base', { cwd: corpus, stdio: 'pipe' });
      const head = execSync('git rev-parse HEAD', { cwd: corpus, encoding: 'utf-8' }).trim();
      const db = healthyDb();
      db.setIndexMetadata('last_indexed_commit', head);

      const res = resolveDeltaBase(corpus, db, undefined);
      expect(isRefusal(res)).toBe(false);
      if (!isRefusal(res)) {
        expect(res.source).toBe('index');
        expect(res.ref).toBe(head);
        expect(res.sha).toBe(head);
      }
      db.close();
    });

    it('returns baseline-unavailable when no --base and the index has no last_indexed_commit', () => {
      const corpus = tmp('repo');
      initRepo(corpus);
      const db = healthyDb();
      const res = resolveDeltaBase(corpus, db, undefined);
      expect(isRefusal(res)).toBe(true);
      expect((res as DeltaRefusal).reason).toBe('baseline-unavailable');
      db.close();
    });
  });
});
