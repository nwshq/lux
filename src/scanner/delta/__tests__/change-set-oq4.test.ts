import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { LuxDatabase } from '../../../db/index.js';
import { resolveDeltaChangeSet } from '../change-set.js';
import type { BaseResolution } from '../preflight.js';
import type { StructuralEdge, StructuralNode } from '../../../db/types.js';

function git(cwd: string, args: string): void {
  execSync(`git ${args}`, { cwd, stdio: 'pipe' });
}
function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init -q');
  git(dir, 'config user.email test@example.com');
  git(dir, 'config user.name Test');
  git(dir, 'config commit.gpgsign false');
}
function head(dir: string): string {
  return execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf-8' }).trim();
}
function now(): number {
  return Math.floor(Date.now() / 1000);
}
function node(id: string, filePath: string): StructuralNode {
  return { id, node_type: 'symbol', file_path: filePath, updated_at: now() };
}
function edge(id: string, over: Partial<StructuralEdge>): StructuralEdge {
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

/**
 * SC-5 / OQ4 — the blocking gate. After a --mark-only sync advances last_indexed_commit to HEAD
 * while the overlay is still stale, a subsequent `lux delta` on the DEFAULT (index-pointer) base
 * must NOT read as "nothing changed" over the stale-overlay files. resolveDeltaChangeSet consults
 * the maintained marks and surfaces them; without Part B the set is empty (the regression guarded).
 */
describe('resolveDeltaChangeSet OQ4 mark-read (spec 12 Part B / SC-5)', () => {
  let repo: string;
  let db: LuxDatabase;
  let headSha: string;

  beforeEach(() => {
    repo = join(tmpdir(), `lux-oq4-cs-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    initRepo(repo);
    writeFileSync(join(repo, 'app.php'), '<?php // app\n');
    writeFileSync(join(repo, 'routes.php'), '<?php // routes\n');
    git(repo, 'add -A');
    git(repo, 'commit -q -m base');
    headSha = head(repo);

    db = new LuxDatabase(join(repo, '.lux', 'lux.db'));
    // Simulate a --mark-only sync: pointer at HEAD, but one file's edges are marked stale.
    db.setIndexMetadata('last_indexed_commit', headSha);
    db.upsertStructuralNode(node('sym:app', 'app.php'));
    db.upsertStructuralEdge(
      edge('edge:stale', {
        source_node_id: 'sym:app',
        target_node_id: 'sym:app',
        freshness_status: 'stale',
      })
    );
  });

  afterEach(() => {
    db.close();
    if (existsSync(repo)) rmSync(repo, { recursive: true, force: true });
  });

  function indexBase(): BaseResolution {
    return { ref: headSha, sha: headSha, source: 'index' };
  }
  function flagBase(): BaseResolution {
    return { ref: headSha, sha: headSha, source: 'flag' };
  }

  it('surfaces the stale-overlay file as index-stale with a base-honesty warning (index base, clean tree)', () => {
    const cs = resolveDeltaChangeSet(repo, db, { base: indexBase(), committedOnly: false });
    const stale = cs.files.find((f) => f.path === 'app.php');
    expect(stale).toBeDefined();
    expect(stale?.status).toBe('modified');
    expect(stale?.indexTrust).toBe('index-stale');
    expect(cs.indexPaths).toContain('app.php');
    expect(cs.warnings.some((w) => w.includes('maintained overlay staleness marks'))).toBe(true);
  });

  it('an explicit --base (source:flag) does NOT inject overlay-stale files', () => {
    const cs = resolveDeltaChangeSet(repo, db, { base: flagBase(), committedOnly: false });
    // HEAD..HEAD is empty, tree clean, flag base ⇒ overlay marks are NOT consulted.
    expect(cs.files.find((f) => f.path === 'app.php')).toBeUndefined();
    expect(cs.warnings.some((w) => w.includes('maintained overlay staleness marks'))).toBe(false);
  });

  it('reports an empty change-set once the overlay is repaired (edges fresh again)', () => {
    // repair: mark the edge fresh → the mark-read finds nothing to surface.
    db.upsertStructuralEdge(
      edge('edge:stale', {
        source_node_id: 'sym:app',
        target_node_id: 'sym:app',
        freshness_status: 'fresh',
      })
    );
    const cs = resolveDeltaChangeSet(repo, db, { base: indexBase(), committedOnly: false });
    expect(cs.files).toHaveLength(0);
  });
});
