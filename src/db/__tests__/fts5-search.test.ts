import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LuxDatabase } from '../index.js';

/**
 * FTS5 parity on the WASM engine. node-sqlite3-wasm compiles FTS5 from the same SQLite
 * source family as better-sqlite3, but the migration must preserve full-text behavior:
 * bm25 ranking ORDER, unicode61 tokenization of non-ASCII text, and prefix (`term*`)
 * queries — the pieces the general suite exercised only shallowly.
 */
describe('FTS5 search parity (WASM SQLite)', () => {
  let dir: string;
  let db: LuxDatabase;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lux-fts-'));
    db = new LuxDatabase(join(dir, 'lux.db'));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const add = (title: string, content: string, file: string) =>
    db.insertKnowledgeEntry({ type: 'document', title, file_path: file, content });

  it('ranks the more relevant document first (bm25 ORDER BY rank)', () => {
    add('Settlement Guide', 'settlement settlement settlement clearing settlement netting', 'a.md');
    add('Misc Notes', 'this document mentions settlement exactly once', 'b.md');

    const results = db.searchDocumentsRanked('settlement', { limit: 20 });
    expect(results.length).toBe(2);
    // the term-dense, title-matching doc must rank ahead of the incidental mention
    expect(results[0].title).toBe('Settlement Guide');
  });

  it('tokenizes and finds unicode / accented content', () => {
    add('Café Menu', 'The café serves crème brûlée and pain au chocolat in Zürich', 'c.md');

    expect(db.searchDocumentsRanked('café', { limit: 20 }).map((r) => r.title)).toContain(
      'Café Menu'
    );
    expect(db.searchDocumentsRanked('Zürich', { limit: 20 }).map((r) => r.title)).toContain(
      'Café Menu'
    );
    expect(db.searchDocumentsRanked('chocolat', { limit: 20 }).map((r) => r.title)).toContain(
      'Café Menu'
    );
  });

  it('supports prefix queries (term*)', () => {
    add('Refund Policy', 'refunded and refunding are both refund operations', 'd.md');
    add('Shipping', 'packages ship worldwide', 'e.md');

    const hits = db.searchDocumentsRanked('refund*', { limit: 20 }).map((r) => r.title);
    expect(hits).toContain('Refund Policy'); // matches refunded / refunding / refund
    expect(hits).not.toContain('Shipping');
  });

  it('returns empty (not an error) for a term with no matches', () => {
    add('Anything', 'some content here', 'f.md');
    expect(db.searchDocumentsRanked('zzzznonexistent', { limit: 20 })).toEqual([]);
  });
});
