import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { LuxDatabase } from '../../db/index.js';
import { buildAugmentedQuery, type FtsHit } from '../router.js';

describe('Router Module Enrichment', () => {
  const testDir = join(__dirname, 'fixtures', 'router-deps-test');
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

  it('should include module context in augmented query when provided', () => {
    const hits: FtsHit[] = [
      {
        filePath: '/test/src/Module/Users/UserService.php',
        rank: -1,
        content: 'class UserService {}',
        title: 'UserService.php',
      },
    ];

    const moduleContext =
      'module: Users\nmodule_coupling: Orders (10 refs), Auth (5 refs)\ncluster: Users (Users, Orders, Auth)';

    const augmented = buildAugmentedQuery(
      'How does user auth work?',
      hits,
      undefined,
      moduleContext
    );

    expect(augmented).toContain('## Module Context');
    expect(augmented).toContain('module: Users');
    expect(augmented).toContain('module_coupling: Orders (10 refs)');
    expect(augmented).toContain('cluster: Users');
  });

  it('should not include module context section when not provided', () => {
    const hits: FtsHit[] = [
      {
        filePath: '/test/file.php',
        rank: -1,
        content: 'some content',
        title: 'file.php',
      },
    ];

    const augmented = buildAugmentedQuery('test query', hits);

    expect(augmented).not.toContain('## Module Context');
  });

  it('should query module dependencies from database', () => {
    db.insertModuleDependency({
      source_module: 'Users',
      target_module: 'Orders',
      reference_count: 10,
      sample_files: null,
    });
    db.insertModuleDependency({
      source_module: 'Users',
      target_module: 'Auth',
      reference_count: 5,
      sample_files: null,
    });

    const deps = db.getAllModuleDependencies();
    expect(deps).toHaveLength(2);

    const userDeps = deps.filter((d) => d.source_module === 'Users');
    expect(userDeps).toHaveLength(2);
  });
});
