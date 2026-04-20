import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { LuxDatabase } from '../../db/index.js';
import { enrichContext } from '../enrich.js';

describe('Discovery Enrichment with Module Dependencies', () => {
  const testDir = join(__dirname, 'fixtures', 'enrich-deps-test');
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

  it('should include moduleCoupling when dependencies exist', () => {
    db.insertModuleDependency({
      source_module: 'Users',
      target_module: 'Orders',
      reference_count: 10,
      sample_files: null,
    });
    db.insertModuleDependency({
      source_module: 'Orders',
      target_module: 'Users',
      reference_count: 5,
      sample_files: null,
    });

    const context = enrichContext('tree output', db, { rootPath: testDir });

    expect(context.moduleCoupling).toBeDefined();
    expect(context.moduleCoupling!.length).toBe(2);
    expect(context.moduleCoupling![0].source_module).toBe('Users');
  });

  it('should include clusters when dependencies exist', () => {
    db.insertModuleDependency({
      source_module: 'Auth',
      target_module: 'Users',
      reference_count: 8,
      sample_files: null,
    });
    db.insertModuleDependency({
      source_module: 'Users',
      target_module: 'Auth',
      reference_count: 6,
      sample_files: null,
    });

    const context = enrichContext('tree output', db, { rootPath: testDir });

    expect(context.clusters).toBeDefined();
    expect(context.clusters!.length).toBeGreaterThan(0);
    // Each cluster has a name and members
    for (const cluster of context.clusters!) {
      expect(cluster.name).toBeTruthy();
      expect(cluster.members.length).toBeGreaterThan(0);
    }
  });

  it('should not include moduleCoupling when no dependencies', () => {
    const context = enrichContext('tree output', db, { rootPath: testDir });

    expect(context.moduleCoupling).toBeUndefined();
    expect(context.clusters).toBeUndefined();
  });

  it('should preserve existing enrichment fields', () => {
    // Insert a knowledge entry so fileCountsByDirectory is populated
    db.insertKnowledgeEntry({
      type: 'source-code',
      title: 'test.php',
      file_path: join(testDir, 'src', 'test.php'),
      content: 'test',
    });

    db.insertModuleDependency({
      source_module: 'A',
      target_module: 'B',
      reference_count: 1,
      sample_files: JSON.stringify([join(testDir, 'src', 'test.php')]),
    });

    const context = enrichContext('tree output', db, { rootPath: testDir });

    expect(context.tree).toBe('tree output');
    expect(context.fileCountsByDirectory).toBeDefined();
    expect(context.existingExperts).toBeDefined();
    expect(context.moduleCoupling).toBeDefined();
  });

  it('should ignore module dependencies whose sample files are outside the active root when the db is mixed', () => {
    db.insertKnowledgeEntry({
      type: 'source-code',
      title: 'inside.php',
      file_path: join(testDir, 'src', 'inside.php'),
      content: 'test',
    });

    db.insertModuleDependency({
      source_module: 'Inside',
      target_module: 'Shared',
      reference_count: 3,
      sample_files: JSON.stringify([join(testDir, 'src', 'inside.php')]),
    });
    db.insertModuleDependency({
      source_module: 'Outside',
      target_module: 'Shared',
      reference_count: 9,
      sample_files: JSON.stringify(['/elsewhere/outside.php']),
    });

    const context = enrichContext('tree output', db, { rootPath: testDir });

    expect(context.moduleCoupling).toBeDefined();
    expect(context.moduleCoupling).toHaveLength(1);
    expect(context.moduleCoupling![0].source_module).toBe('Inside');
  });
});
