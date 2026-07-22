import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LuxDatabase } from '../index.js';
import { LuxSqlite } from '../sqlite-adapter.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lux-attach-sibling-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A fresh, current-schema `.lux` (autoMigrate → the current schema version). */
function freshDb(name: string): { db: LuxDatabase; path: string } {
  const path = join(root, name, '.lux', 'lux.db');
  return { db: new LuxDatabase(path), path };
}

describe('LuxDatabase.attachSibling (spec 17 Part A)', () => {
  it('attaches read-side under the given alias, runs fn, and detaches (re-attach works)', () => {
    const { db: primary } = freshDb('primary');
    const { db: baseline, path: baselinePath } = freshDb('baseline');
    baseline.close();

    // fn runs only if the schema-parity guard (main vs sibling schema_version) passed first
    const v = primary.attachSibling(baselinePath, 'baseline', () => 42);
    expect(v).toBe(42);

    // detach happened → a second attach under the same alias on the same handle succeeds
    expect(() => primary.attachSibling(baselinePath, 'baseline', () => 1)).not.toThrow();
    primary.close();
  });

  it('rejects an unsafe alias before touching the database', () => {
    const { db: primary } = freshDb('p2');
    const { db: baseline, path: baselinePath } = freshDb('b2');
    baseline.close();
    for (const bad of ['1bad', 'has space', 'drop;', 'a-b', 'x)']) {
      expect(() => primary.attachSibling(baselinePath, bad, () => 1)).toThrow(/unsafe alias/);
    }
    primary.close();
  });

  it('throws on a schema-parity mismatch (baseline rolled back to v(N-1))', () => {
    const { db: primary } = freshDb('p3');
    const { db: baseline, path: baselinePath } = freshDb('b3');
    baseline.close();
    // Roll the baseline back one schema version WITHOUT migrating the primary — the (base SHA,
    // schema_version) cache-key contract: an old-SHA baseline needs a current-schema rebuild.
    const raw = new LuxSqlite(baselinePath);
    raw.run('DELETE FROM schema_version WHERE version = (SELECT MAX(version) FROM schema_version)');
    raw.close();

    expect(() => primary.attachSibling(baselinePath, 'baseline', () => 1)).toThrow(
      /schema v\d+ != main v\d+/
    );
    primary.close();
  });

  it('blocks writes during the attach window (query_only = ON)', () => {
    const { db: primary } = freshDb('p4');
    const { db: baseline, path: baselinePath } = freshDb('b4');
    baseline.close();
    expect(() =>
      primary.attachSibling(baselinePath, 'baseline', () => {
        primary.upsertStructuralNode({ id: 'symbol:php:W', node_type: 'symbol', updated_at: 1 });
      })
    ).toThrow(/readonly|read.only/i);
    // NB: don't close() here — node-sqlite3-wasm re-throws the deferred write error when
    // finalizing the (deliberately) failed cached statement; the exit handler cleans up.
  });

  it('leaves the baseline file byte-unmodified after a full pass (mtime + no journal/wal)', () => {
    const { db: primary } = freshDb('p5');
    const { db: baseline, path: baselinePath } = freshDb('b5');
    baseline.upsertStructuralNode({
      id: 'surface:http:GET:/x',
      node_type: 'capability-surface',
      file_path: 'packages/a/X.php',
      updated_at: 1,
    });
    baseline.close();
    const before = statSync(baselinePath).mtimeMs;

    // A full attach → diff → detach pass reads baseline.* only (engine-enforced query_only).
    primary.baselineStructuralDiff(baselinePath);

    expect(statSync(baselinePath).mtimeMs).toBe(before);
    expect(existsSync(`${baselinePath}-journal`)).toBe(false);
    expect(existsSync(`${baselinePath}-wal`)).toBe(false);
    primary.close();
  });
});
