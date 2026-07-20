import { describe, it, expect } from 'vitest';
import { LuxSqlite } from '../sqlite-adapter.js';

/**
 * Adapter-level validation of the reconciliations that make `LuxSqlite` a faithful
 * better-sqlite3 stand-in over node-sqlite3-wasm — the crux fixes from the
 * WASM-SQLite migration payload (variadic positional binds, savepoint nesting +
 * RELEASE, get()→undefined, one-shot auto-finalized statements).
 */
function freshDb(): LuxSqlite {
  const db = new LuxSqlite(':memory:');
  db.exec(`CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT, b TEXT)`);
  return db;
}

describe('LuxSqlite adapter', () => {
  it('binds multiple positional params on run/get (B1)', () => {
    const db = freshDb();
    const r = db.prepare('INSERT INTO t (a, b) VALUES (?, ?)').run('x', 'y');
    expect(r.changes).toBe(1);
    expect(Number(r.lastInsertRowid)).toBeGreaterThan(0);

    const row = db.prepare('SELECT a, b FROM t WHERE a = ? AND b = ?').get('x', 'y');
    expect(row).toEqual({ a: 'x', b: 'y' });

    // the setEdgeOwnershipBatch shape: UPDATE ... = ? WHERE id = ?
    expect(db.prepare('UPDATE t SET a = ? WHERE b = ?').run('z', 'y').changes).toBe(1);
    expect((db.prepare('SELECT a FROM t WHERE b = ?').get('y') as { a: string }).a).toBe('z');
    db.close();
  });

  it('binds 2 positionals on all() — the getStructuralEdgesForNode shape', () => {
    const db = freshDb();
    db.prepare('INSERT INTO t (a, b) VALUES (?, ?)').run('k', 'other'); // node as source
    db.prepare('INSERT INTO t (a, b) VALUES (?, ?)').run('other', 'k'); // node as target
    const rows = db.prepare('SELECT id FROM t WHERE a = ? OR b = ?').all('k', 'k');
    expect(rows.length).toBe(2); // BOTH source- and target-matches (would be 1 if the 2nd bind were dropped)
    db.close();
  });

  it('reconciles named params via @-prefixing', () => {
    const db = freshDb();
    db.prepare('INSERT INTO t (a, b) VALUES (@a, @b)').run({ a: 'n1', b: 'n2' });
    expect((db.prepare('SELECT b FROM t WHERE a = @a').get({ a: 'n1' }) as { b: string }).b).toBe(
      'n2'
    );
    db.close();
  });

  it('returns undefined (not null) for a missing row', () => {
    const db = freshDb();
    expect(db.prepare('SELECT * FROM t WHERE id = ?').get(999)).toBeUndefined();
    db.close();
  });

  it('nests transactions: inner throw rolls back to savepoint, outer continues, savepoint released', () => {
    const db = freshDb();
    db.prepare('INSERT INTO t (a) VALUES (?)').run('outer-before');

    const failingInner = db.transaction(() => {
      db.prepare('INSERT INTO t (a) VALUES (?)').run('inner-doomed');
      throw new Error('boom');
    });

    db.transaction(() => {
      db.prepare('INSERT INTO t (a) VALUES (?)').run('outer-during');
      expect(() => failingInner()).toThrow('boom'); // inner rolls back its savepoint only
      // A SECOND nested transaction after the caught one must succeed — proving the
      // failed savepoint was RELEASEd (not left dangling on the stack).
      db.transaction(() => db.prepare('INSERT INTO t (a) VALUES (?)').run('inner-ok'))();
    })();

    const names = (db.prepare('SELECT a FROM t ORDER BY id').all() as { a: string }[]).map(
      (r) => r.a
    );
    expect(names).toEqual(['outer-before', 'outer-during', 'inner-ok']); // 'inner-doomed' gone
    db.close();
  });

  it('rolls the whole outer transaction back when it throws', () => {
    const db = freshDb();
    db.prepare('INSERT INTO t (a) VALUES (?)').run('kept');
    const tx = db.transaction(() => {
      db.prepare('INSERT INTO t (a) VALUES (?)').run('discarded');
      throw new Error('outer-fail');
    });
    expect(() => tx()).toThrow('outer-fail');
    expect((db.prepare('SELECT COUNT(*) AS c FROM t').get() as { c: number }).c).toBe(1);
    db.close();
  });

  it('supports one-shot run/all/get(sql, values) that auto-finalize', () => {
    const db = freshDb();
    expect(db.run('INSERT INTO t (a, b) VALUES (?, ?)', ['p', 'q']).changes).toBe(1);
    expect((db.get('SELECT a FROM t WHERE b = ?', 'q') as { a: string }).a).toBe('p');
    expect(db.all('SELECT * FROM t').length).toBe(1);
    db.close();
  });
});
