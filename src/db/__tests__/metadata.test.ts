import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { LuxDatabase } from '../index.js';

describe('Index Metadata Operations', () => {
  const testDir = join(__dirname, 'fixtures', 'metadata-test');
  const dbPath = join(testDir, 'test.db');
  let db: LuxDatabase;

  beforeEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    mkdirSync(testDir, { recursive: true });
    db = new LuxDatabase(dbPath);
  });

  afterEach(() => {
    if (db) db.close();
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should return undefined for missing key', () => {
    const value = db.getIndexMetadata('nonexistent');
    expect(value).toBeUndefined();
  });

  it('should set and get metadata round-trip', () => {
    db.setIndexMetadata('last_indexed_commit', 'abc123def456');
    const value = db.getIndexMetadata('last_indexed_commit');
    expect(value).toBe('abc123def456');
  });

  it('should overwrite existing value', () => {
    db.setIndexMetadata('last_indexed_commit', 'first');
    db.setIndexMetadata('last_indexed_commit', 'second');
    const value = db.getIndexMetadata('last_indexed_commit');
    expect(value).toBe('second');
  });

  it('should handle multiple keys independently', () => {
    db.setIndexMetadata('key1', 'value1');
    db.setIndexMetadata('key2', 'value2');
    expect(db.getIndexMetadata('key1')).toBe('value1');
    expect(db.getIndexMetadata('key2')).toBe('value2');
  });
});
