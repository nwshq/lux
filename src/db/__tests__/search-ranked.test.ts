// The ranked search contract (spec 10, D1–D4): real bm25 rank, LIMIT + projection in SQL, whole-
// expression content scoping, opt-in snippets, and structured refusals instead of a silent catch.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LuxDatabase, SearchRefusalError } from '../index.js';
import { LuxSqlite } from '../sqlite-adapter.js';

describe('searchDocumentsRanked (ranked contract)', () => {
  let dir: string;
  let dbPath: string;
  let db: LuxDatabase;

  const add = (title: string, content: string, file: string, type = 'document') =>
    db.insertKnowledgeEntry({ type, title, file_path: file, content });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lux-ranked-'));
    dbPath = join(dir, 'lux.db');
    db = new LuxDatabase(dbPath);
  });
  afterEach(() => {
    try {
      db.close();
    } catch {
      /* some cases close explicitly */
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns REAL bm25 rank (negative, lower = better), best-first', () => {
    add('Settlement Guide', 'settlement settlement settlement clearing netting', 'a.md');
    add('Misc', 'mentions settlement once', 'b.md');
    const results = db.searchDocumentsRanked('settlement', { limit: 20 });
    expect(results).toHaveLength(2);
    expect(results[0].title).toBe('Settlement Guide');
    // Never the old rank:0 lie — raw bm25 is negative.
    for (const r of results) expect(r.rank).toBeLessThan(0);
    expect(results[0].rank).toBeLessThanOrEqual(results[1].rank);
    // camelCase renamed shape (filePath/entryType), no content pass-through.
    expect(results[0].filePath).toBe('a.md');
    expect(results[0].entryType).toBe('document');
    expect(results[0]).not.toHaveProperty('content');
  });

  it('applies LIMIT in SQL (row cap), best-first', () => {
    for (let i = 0; i < 5; i++) add(`Doc ${i}`, `settlement token ${i}`, `d${i}.md`);
    expect(db.searchDocumentsRanked('settlement', { limit: 2 })).toHaveLength(2);
  });

  it('scopes the whole expression to content under contentOnly (D4)', () => {
    // The unique term lives ONLY in the title, never in content.
    add('Zzquux Report', 'this body has no such token', 'title-only.md');
    expect(db.searchDocumentsRanked('Zzquux', { limit: 20 })).toHaveLength(1); // matches title
    expect(db.searchDocumentsRanked('Zzquux', { contentOnly: true, limit: 20 })).toHaveLength(0);
  });

  it('emits an FTS5 snippet only when requested (D2)', () => {
    add('Guide', 'the settlement process clears and nets balances', 's.md');
    const plain = db.searchDocumentsRanked('settlement', { limit: 20 });
    expect(plain[0].snippet).toBeUndefined();
    const withSnip = db.searchDocumentsRanked('settlement', { snippets: true, limit: 20 });
    expect(withSnip[0].snippet).toContain('<mark>settlement</mark>');
  });

  it('returns [] for a genuine zero-result query (NOT a refusal)', () => {
    add('Anything', 'some body', 'f.md');
    expect(db.searchDocumentsRanked('zzznomatch', { limit: 20 })).toEqual([]);
  });

  it('throws SearchRefusalError(invalid-query) on a malformed FTS5 query and stays closeable', () => {
    add('Anything', 'some body', 'f.md');
    let refusal: unknown;
    try {
      db.searchDocumentsRanked('"unterminated phrase', { limit: 20 });
    } catch (e) {
      refusal = e;
    }
    expect(refusal).toBeInstanceOf(SearchRefusalError);
    expect((refusal as SearchRefusalError).reason).toBe('invalid-query');
    // Adapter guard: the failed statement's deferred error must NOT re-throw at finalize and crash.
    expect(() => db.close()).not.toThrow();
  });

  it('classifies a col:term filter on a bad column as invalid-query (FTS5 no-such-column)', () => {
    add('Doc', 'settlement clearing', 's.md');
    let refusal: unknown;
    try {
      db.searchDocumentsRanked('nosuchcol:settlement', { limit: 20 });
    } catch (e) {
      refusal = e;
    }
    expect(refusal).toBeInstanceOf(SearchRefusalError);
    expect((refusal as SearchRefusalError).reason).toBe('invalid-query');
  });

  it('a failed query does NOT poison the next query on the same handle (statement self-heals)', () => {
    add('Doc', 'settlement clearing netting', 's.md');
    // 1. valid
    expect(db.searchDocumentsRanked('settlement', { limit: 20 })).toHaveLength(1);
    // 2. bad-column query fails
    expect(() => db.searchDocumentsRanked('badcol:settlement', { limit: 20 })).toThrow(
      SearchRefusalError
    );
    // 3. the very next valid query must still work (pre-fix: "Could not reset statement …")
    expect(db.searchDocumentsRanked('settlement', { limit: 20 })).toHaveLength(1);
    expect(db.searchDocumentsRanked('clearing', { limit: 20 })).toHaveLength(1);
  });

  it('throws SearchRefusalError(fts-unavailable) when the FTS table is gone (query-time classifier)', () => {
    add('Anything', 'some body', 'f.md');
    // Drop the FTS table via a separate handle; the already-open `db`'s prepared MATCH statement then
    // hits a missing table at EXECUTION → the query-time classifier maps it to fts-unavailable
    // (searchDocumentsRanked's try/catch, spec 10 Part D — distinct from the CLI's prepare-time guard).
    const raw = new LuxSqlite(dbPath);
    raw.exec('DROP TABLE IF EXISTS knowledge_entries_fts;');
    raw.close();
    let refusal: unknown;
    try {
      db.searchDocumentsRanked('settlement', { limit: 20 });
    } catch (e) {
      refusal = e;
    }
    expect(refusal).toBeInstanceOf(SearchRefusalError);
    expect((refusal as SearchRefusalError).reason).toBe('fts-unavailable');
    expect(() => db.close()).not.toThrow();
  });
});
