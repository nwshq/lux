import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';
import { LuxDatabase } from '../../db/index.js';
import type { StructuralEdge } from '../../db/types.js';
import {
  assessWorkingTreeFreshness,
  summarizeStaleSupport,
  staleSupportWarning,
} from '../freshness.js';
import { getHeadCommit } from '../git.js';

function git(repoPath: string, command: string): void {
  execSync(command, { cwd: repoPath, stdio: 'pipe' });
}

function initRepo(repoPath: string): void {
  git(repoPath, 'git init');
  git(repoPath, 'git config user.email "test@test.com"');
  git(repoPath, 'git config user.name "Test"');
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}

function edge(id: string, over: Partial<StructuralEdge> = {}): StructuralEdge {
  return {
    id,
    source_node_id: 'a',
    target_node_id: 'b',
    edge_type: 'calls',
    confidence: 0.9,
    confidence_class: 'framework-inferred',
    freshness_status: 'fresh',
    dirty_dependency_count: 0,
    updated_at: now(),
    ...over,
  };
}

describe('assessWorkingTreeFreshness (spec 10C — five fixtures)', () => {
  let repoDir: string;
  let dbDir: string;
  let db: LuxDatabase;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'lux-freshness-repo-'));
    dbDir = mkdtempSync(join(tmpdir(), 'lux-freshness-db-'));
    db = new LuxDatabase(join(dbDir, 'lux.db'));
  });

  afterEach(() => {
    db.close();
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(dbDir, { recursive: true, force: true });
  });

  it('clean: HEAD == indexed, tree clean', () => {
    initRepo(repoDir);
    writeFileSync(join(repoDir, 'README.md'), '# init\n');
    git(repoDir, 'git add -A');
    git(repoDir, 'git commit -m init');
    db.setIndexMetadata('last_indexed_commit', getHeadCommit(repoDir));

    const f = assessWorkingTreeFreshness(repoDir, db);
    expect(f.assessment).toBe('clean');
    expect(f.gitAvailable).toBe(true);
    expect(f.headMatchesIndex).toBe(true);
    expect(f.dirtyStructural).toEqual([]);
    expect(f.dirtyFiles).toEqual([]);
  });

  it('dirty-content: a dirty .md only', () => {
    initRepo(repoDir);
    writeFileSync(join(repoDir, 'README.md'), '# init\n');
    git(repoDir, 'git add -A');
    git(repoDir, 'git commit -m init');
    db.setIndexMetadata('last_indexed_commit', getHeadCommit(repoDir));
    // Dirty the markdown file (uncommitted) — non-structural.
    writeFileSync(join(repoDir, 'README.md'), '# init\nchanged\n');

    const f = assessWorkingTreeFreshness(repoDir, db);
    expect(f.assessment).toBe('dirty-content');
    expect(f.dirtyFiles).toHaveLength(1);
    expect(f.dirtyStructural).toEqual([]);
  });

  it('dirty-structural: a dirty source file', () => {
    initRepo(repoDir);
    mkdirSync(join(repoDir, 'src'), { recursive: true });
    writeFileSync(join(repoDir, 'src', 'app.ts'), 'export const a = 1;\n');
    git(repoDir, 'git add -A');
    git(repoDir, 'git commit -m init');
    db.setIndexMetadata('last_indexed_commit', getHeadCommit(repoDir));
    // Dirty the source file (uncommitted) — structural.
    writeFileSync(join(repoDir, 'src', 'app.ts'), 'export const a = 2;\n');

    const f = assessWorkingTreeFreshness(repoDir, db);
    expect(f.assessment).toBe('dirty-structural');
    expect(f.dirtyStructural).toContain('src/app.ts');
  });

  it('commit-lag: HEAD ahead of indexed (dominates dirt)', () => {
    initRepo(repoDir);
    writeFileSync(join(repoDir, 'README.md'), '# init\n');
    git(repoDir, 'git add -A');
    git(repoDir, 'git commit -m c1');
    const firstCommit = getHeadCommit(repoDir);
    db.setIndexMetadata('last_indexed_commit', firstCommit);
    // Advance HEAD past the indexed commit AND leave a dirty structural file.
    mkdirSync(join(repoDir, 'src'), { recursive: true });
    writeFileSync(join(repoDir, 'src', 'app.ts'), 'export const a = 1;\n');
    git(repoDir, 'git add -A');
    git(repoDir, 'git commit -m c2');
    writeFileSync(join(repoDir, 'src', 'app.ts'), 'export const a = 2;\n');

    const f = assessWorkingTreeFreshness(repoDir, db);
    expect(f.assessment).toBe('commit-lag'); // dominates dirt
    expect(f.headMatchesIndex).toBe(false);
    expect(f.indexedCommit).toBe(firstCommit);
  });

  it('non-git: a non-repo corpus', () => {
    // repoDir is never `git init`-ed.
    const f = assessWorkingTreeFreshness(repoDir, db);
    expect(f.assessment).toBe('unknown');
    expect(f.gitAvailable).toBe(false);
  });

  it('read-only invariant (A4): idempotent, never mutates structural_edges', () => {
    initRepo(repoDir);
    mkdirSync(join(repoDir, 'src'), { recursive: true });
    writeFileSync(join(repoDir, 'src', 'app.ts'), 'export const a = 1;\n');
    git(repoDir, 'git add -A');
    git(repoDir, 'git commit -m init');
    db.setIndexMetadata('last_indexed_commit', getHeadCommit(repoDir));
    db.upsertStructuralEdge(edge('e:1', { freshness_status: 'fresh' }));
    db.upsertStructuralEdge(edge('e:2', { freshness_status: 'stale' }));
    // Leave a dirty structural file so the assessment path does real work.
    writeFileSync(join(repoDir, 'src', 'app.ts'), 'export const a = 2;\n');

    const before = db.countEdgesByFreshness();
    const first = assessWorkingTreeFreshness(repoDir, db);
    const second = assessWorkingTreeFreshness(repoDir, db);
    const after = db.countEdgesByFreshness();

    expect(after).toEqual(before); // no status path mutated an edge mark
    expect(second).toEqual(first); // idempotent, side-effect-free
    expect(first.edgeFreshness).toEqual({
      fresh: 1,
      'dirty-dependent': 0,
      stale: 1,
      unknown: 0,
      other: 0,
    });
  });
});

describe('summarizeStaleSupport / staleSupportWarning (spec 11C — authored in Phase 1)', () => {
  it('counts only stale-supporting edges and caps ids at 20', () => {
    const edges = [
      edge('e:fresh', { freshness_status: 'fresh' }),
      edge('e:stale-1', { freshness_status: 'stale' }),
      edge('e:stale-2', { freshness_status: 'stale' }),
      edge('e:dirty', { freshness_status: 'dirty-dependent' }),
    ];
    const summary = summarizeStaleSupport(edges);
    expect(summary.staleCount).toBe(2);
    expect(summary.staleEdgeIds).toEqual(['e:stale-1', 'e:stale-2']);

    const manyStale = Array.from({ length: 25 }, (_, i) =>
      edge(`e:s${i}`, { freshness_status: 'stale' })
    );
    expect(summarizeStaleSupport(manyStale).staleEdgeIds).toHaveLength(20);
  });

  it('warns only when at least one supporting edge is stale', () => {
    expect(staleSupportWarning({ staleCount: 0, staleEdgeIds: [] })).toBeNull();
    const warning = staleSupportWarning({ staleCount: 3, staleEdgeIds: ['a', 'b', 'c'] });
    expect(warning).toContain('3 supporting edge(s) are marked stale');
    expect(warning).toContain('lux index sync --scoped');
  });
});
