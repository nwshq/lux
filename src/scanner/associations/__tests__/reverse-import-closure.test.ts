// Reverse-import closure tests (spec 13 Part E / Decision 14 / T3a.5).

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';
import { LuxDatabase } from '../../../db/index.js';
import { rebuildWithOverlay } from '../../rebuild-orchestrator.js';
import { computeReverseImportClosure } from '../overlay-refresh.js';

const roots: string[] = [];

function makeRepo(files: Record<string, string>): string {
  const repo = mkdtempSync(join(tmpdir(), 'lux-closure-'));
  roots.push(repo);
  execSync('git init -q && git config user.email a@b.c && git config user.name x', { cwd: repo });
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'closure-fx' }));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(repo, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }
  execSync('git add -A && git commit -q -m i', { cwd: repo });
  return repo;
}

function write(repo: string, rel: string, content: string): void {
  writeFileSync(join(repo, rel), content);
}

async function openRebuilt(repo: string): Promise<LuxDatabase> {
  const dbDir = mkdtempSync(join(tmpdir(), 'lux-closure-db-'));
  roots.push(dbDir);
  const db = new LuxDatabase(join(dbDir, 'lux.db'));
  await rebuildWithOverlay(db, repo);
  return db;
}

afterEach(() => {
  while (roots.length) {
    const p = roots.pop();
    if (p) rmSync(p, { recursive: true, force: true });
  }
});

describe('computeReverseImportClosure (spec 13 Part E)', () => {
  it('body-only edit (no symbol growth) → []', async () => {
    const repo = makeRepo({
      'a.ts': `export function existing(): number { return 1; }\n`,
      'c.ts': `import { existing } from './a.js';\nexport function use(): number { return existing(); }\n`,
    });
    const db = await openRebuilt(repo);
    // Disk unchanged from indexed state ⇒ persisted symbols == extracted symbols ⇒ no growth.
    const closure = await computeReverseImportClosure(db, repo, [
      { relPath: 'a.ts', status: 'modified' },
    ]);
    expect(closure).toEqual([]);
    db.close();
  });

  it('symbol-add → importer files appear (target-edge adjacency)', async () => {
    const repo = makeRepo({
      'a.ts': `export function existing(): number { return 1; }\n`,
      'c.ts': `import { existing } from './a.js';\nexport function use(): number { return existing(); }\n`,
    });
    const db = await openRebuilt(repo);
    // Add a new exported symbol on disk — the growth gate fires.
    write(
      repo,
      'a.ts',
      `export function existing(): number { return 1; }\nexport function added(): number { return 2; }\n`
    );
    const closure = await computeReverseImportClosure(db, repo, [
      { relPath: 'a.ts', status: 'modified' },
    ]);
    expect(closure).toContain('c.ts');
    expect(closure).not.toContain('a.ts'); // F itself excluded
    db.close();
  });

  it('deleted file → [] (a deletion removes symbols — no growth)', async () => {
    const repo = makeRepo({
      'a.ts': `export function existing(): number { return 1; }\n`,
      'c.ts': `import { existing } from './a.js';\nexport function use(): number { return existing(); }\n`,
    });
    const db = await openRebuilt(repo);
    const closure = await computeReverseImportClosure(db, repo, [
      { relPath: 'a.ts', status: 'deleted' },
    ]);
    expect(closure).toEqual([]);
    db.close();
  });

  it('symbol-add pulls a module importer with NO prior edge via the module-adjacency branch', async () => {
    // A `packages/{name}` module structure so module boundaries are detected. moduleA imports
    // moduleB's b2.ts but has NO structural edge into b1.ts — so when b1.ts GROWS, only the
    // module-adjacency branch (not the target-edge branch) can pull a1.ts into the closure. Flat-repo
    // fixtures never reach this branch because they detect no module boundary. The module dependency
    // moduleA→moduleB is written by `lux index rebuild` (cli/index.ts); rebuildWithOverlay does not
    // persist it, so it is seeded directly here exactly as that CLI path would.
    const repo = makeRepo({
      'packages/moduleA/a1.ts': `import { b2fn } from '../moduleB/b2.js';\nexport function a1fn(): number { return b2fn(); }\n`,
      'packages/moduleB/b1.ts': `export function b1fn(): number { return 1; }\n`,
      'packages/moduleB/b2.ts': `export function b2fn(): number { return 5; }\n`,
    });
    const db = await openRebuilt(repo);
    db.insertModuleDependency({
      source_module: 'moduleA',
      target_module: 'moduleB',
      reference_count: 1,
      sample_files: JSON.stringify(['packages/moduleA/a1.ts']),
    });
    // Precondition: moduleB is imported by moduleA (drives the module-adjacency importer set).
    expect(db.getModuleDependencies('moduleB', 'target').map((d) => d.source_module)).toContain(
      'moduleA'
    );
    // Grow b1.ts on disk (add a symbol) — the growth gate fires for moduleB.
    write(
      repo,
      'packages/moduleB/b1.ts',
      `export function b1fn(): number { return 1; }\nexport function b1extra(): number { return 2; }\n`
    );
    const closure = await computeReverseImportClosure(db, repo, [
      { relPath: 'packages/moduleB/b1.ts', status: 'modified' },
    ]);
    // a1.ts enters via module adjacency even though it has no edge into the changed file.
    expect(closure).toContain('packages/moduleA/a1.ts');
    expect(closure).not.toContain('packages/moduleB/b1.ts'); // F itself excluded
    db.close();
  });
});
