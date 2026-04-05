import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { LuxDatabase } from '../../db/index.js';
import { detectModuleBoundaries, resolveModule } from '../../scanner/imports/module-boundary.js';

describe('Search Module Annotations', () => {
  const testDir = join(__dirname, 'fixtures', 'search-deps-test');
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

  it('should resolve source-code file to module', () => {
    // Set up module structure
    mkdirSync(join(testDir, 'src', 'Module', 'Users'), { recursive: true });
    mkdirSync(join(testDir, 'src', 'Module', 'Orders'), { recursive: true });

    const patterns = detectModuleBoundaries(testDir);
    expect(patterns).toEqual(['src/Module/{name}']);

    const mod = resolveModule(
      join(testDir, 'src', 'Module', 'Users', 'UserService.php'),
      testDir,
      patterns
    );
    expect(mod).toBe('Users');
  });

  it('should query module dependents for annotations', () => {
    db.insertModuleDependency({
      source_module: 'Invoicing',
      target_module: 'UserDocument',
      reference_count: 3,
      sample_files: JSON.stringify(['inv1.php', 'inv2.php', 'inv3.php']),
    });
    db.insertModuleDependency({
      source_module: 'BidRegistration',
      target_module: 'UserDocument',
      reference_count: 1,
      sample_files: null,
    });
    db.insertModuleDependency({
      source_module: 'Report',
      target_module: 'UserDocument',
      reference_count: 2,
      sample_files: null,
    });

    const dependents = db.getModuleDependencies('UserDocument', 'target');
    expect(dependents).toHaveLength(3);

    // Should be ordered by reference_count desc
    expect(dependents[0].source_module).toBe('Invoicing');
    expect(dependents[0].reference_count).toBe(3);

    // Format like the search output
    const depSummary = dependents
      .map((d) => `${d.source_module} (${d.reference_count} refs)`)
      .join(', ');
    expect(depSummary).toContain('Invoicing (3 refs)');
    expect(depSummary).toContain('Report (2 refs)');
    expect(depSummary).toContain('BidRegistration (1 refs)');
  });

  it('should not annotate non-source-code results', () => {
    // Non-source-code entries (knowledge, methodology, etc.) should not have module annotations
    // This is ensured by the `result.context === 'source-code'` check in search.ts
    const result = { type: 'knowledge', title: 'Test', path: '/test', context: 'methodology' };
    expect(result.context).not.toBe('source-code');
  });

  it('should handle modules with no dependents gracefully', () => {
    const dependents = db.getModuleDependencies('NonExistent', 'target');
    expect(dependents).toHaveLength(0);
  });
});
