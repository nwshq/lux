// openFederationHandles — FIX 1 per-sibling open-fault isolation + no handle leak (Decision 6 / SC-7).
// The long-lived MCP server opens ALL sibling handles and keeps them open until close(). Before the
// fix the open loop had no try/catch, so a post-resolve open fault on any sibling threw out of the
// loop and leaked every handle already opened in the batch. The fix degrades the faulted sibling to a
// refusal and continues, so the loop never throws and the returned close() reliably reaps every
// opened handle. Extracted from the server module (which connects stdio at import) to be testable.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LuxDatabase } from '../../db/index.js';
import { openFederationHandles } from '../federation-handles.js';

/** A minimal sibling `.lux` at the current schema (autoMigrate) with one node. */
function makeSibling(path: string, id: string): void {
  const db = new LuxDatabase(path);
  db.upsertStructuralNode({ id, node_type: 'symbol', updated_at: 1 });
  db.close();
}

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lux-fed-handles-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('openFederationHandles', () => {
  it('a mid-batch open fault degrades that sibling, keeps the healthy handle, and never leaks (FIX 1)', () => {
    const corpus = join(root, 'client');
    mkdirSync(corpus, { recursive: true });
    const primary = new LuxDatabase(join(corpus, '.lux', 'lux.db'));

    const okDb = join(root, 'ok', '.lux', 'lux.db');
    makeSibling(okDb, 'symbol:php:Ok');
    const faultDb = join(root, 'fault', '.lux', 'lux.db');
    makeSibling(faultDb, 'symbol:php:Fault');
    writeFileSync(
      join(corpus, 'lux.yaml'),
      `siblings:\n  ok:\n    db: ${okDb}\n  fault:\n    db: ${faultDb}\n`
    );

    // Both resolve cleanly; `fault` throws only on the post-resolve open (busy-timeout / TOCTOU).
    const realOpen = LuxDatabase.openSiblingReadOnly.bind(LuxDatabase);
    const openSpy = vi
      .spyOn(LuxDatabase, 'openSiblingReadOnly')
      .mockImplementation((dbPath: string, schema: number) => {
        if (dbPath === faultDb) throw new Error('database is locked');
        return realOpen(dbPath, schema);
      });

    // MUST NOT throw — the pre-fix loop would throw here and leak `ok`'s already-opened handle.
    const fed = openFederationHandles(primary, corpus, ['ok', 'fault']);
    openSpy.mockRestore();

    // only the healthy sibling has an open handle; the faulted one degraded to a refusal
    expect(fed.handles.map((h) => h.name)).toEqual(['ok']);
    expect(fed.federation.siblings.find((s) => s.name === 'ok')).toMatchObject({ attached: true });
    const faultRec = fed.federation.siblings.find((s) => s.name === 'fault');
    expect(faultRec).toMatchObject({ attached: false });
    expect(faultRec?.refusal?.reason).toBe('db-unreadable');

    // close() reaps the accumulated handle (no leak): spy on the captured handle's close, then assert
    // close() invoked it exactly once and the handle is unusable afterward.
    const okHandle = fed.handles[0].db;
    const closeSpy = vi.spyOn(okHandle, 'close');
    fed.close();
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(() => okHandle.getAppliedSchemaVersion()).toThrow();

    primary.close();
  });
});
