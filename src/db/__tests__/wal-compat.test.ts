import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  closeSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LuxDatabase } from '../index.js';
import { LuxSqlite } from '../sqlite-adapter.js';

/**
 * node-sqlite3-wasm cannot open a WAL-mode database. Lux indexes built under v2.0.0
 * (better-sqlite3) are WAL; the adapter must convert a checkpointed WAL file to rollback
 * mode on writable open so this engine can read it. (WAL header = format-version bytes at
 * offsets 18/19 == 2; rollback == 1.)
 */
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lux-wal-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function makeDbWithData(path: string): void {
  const db = new LuxDatabase(path);
  db.upsertStructuralNode({ id: 'symbol:php:X', node_type: 'symbol', updated_at: 1 });
  db.close();
}
function setFormatVersion(path: string, v: number): void {
  const fd = openSync(path, 'r+');
  writeSync(fd, Buffer.from([v, v]), 0, 2, 18);
  closeSync(fd);
}
function formatVersion(path: string): number {
  const fd = openSync(path, 'r');
  const b = Buffer.alloc(1);
  readSync(fd, b, 0, 1, 18);
  closeSync(fd);
  return b[0];
}

describe('WAL-mode compatibility', () => {
  it('auto-converts a checkpointed WAL db to rollback on a writable open', () => {
    const p = join(dir, 'lux.db');
    makeDbWithData(p);
    setFormatVersion(p, 2); // simulate a v2.0.0 WAL index (no -wal sidecar)
    expect(formatVersion(p)).toBe(2);

    const db = new LuxSqlite(p); // writable open → converts + opens
    const n = db.get('SELECT COUNT(*) c FROM structural_nodes') as { c: number };
    db.close();

    expect(n.c).toBe(1);
    expect(formatVersion(p)).toBe(1); // flipped to rollback in place
  });

  it('does NOT modify a WAL-header db on a read-only open', () => {
    const p = join(dir, 'ro.db');
    makeDbWithData(p);
    setFormatVersion(p, 2);
    try {
      new LuxSqlite(p, { readonly: true, fileMustExist: true }).close();
    } catch {
      // the engine may still fail to open a WAL file read-only — acceptable; the point is no mutation
    }
    expect(formatVersion(p)).toBe(2); // unchanged — read-only opens never mutate the target
  });

  it('refuses a WAL db that still has an un-checkpointed -wal sidecar', () => {
    const p = join(dir, 'pending.db');
    makeDbWithData(p);
    setFormatVersion(p, 2);
    writeFileSync(`${p}-wal`, 'uncommitted frames');
    expect(() => new LuxSqlite(p)).toThrow(/un-checkpointed|-wal/i);
  });

  it('leaves a normal rollback-mode db untouched', () => {
    const p = join(dir, 'normal.db');
    makeDbWithData(p); // LuxDatabase writes journal_mode=delete → format version 1
    expect(formatVersion(p)).toBe(1);
    const db = new LuxSqlite(p);
    db.close();
    expect(formatVersion(p)).toBe(1);
  });
});
