import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { LuxDatabase } from '../../../db/index.js';
import { resolveDeltaChangeSet, isIndexablePath } from '../change-set.js';
import type { BaseResolution } from '../preflight.js';

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

describe('delta change-set resolution (spec 10 Part C)', () => {
  let repo: string;
  let db: LuxDatabase;
  let baseSha: string;

  beforeEach(() => {
    repo = join(tmpdir(), `lux-delta-cs-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    initRepo(repo);
    // base commit with a substantial file so -M detects the later rename.
    const body = Array.from({ length: 40 }, (_, i) => `content line ${i}`).join('\n');
    writeFileSync(join(repo, 'oldname.php'), body);
    git(repo, 'add -A');
    git(repo, 'commit -q -m base');
    baseSha = execSync('git rev-parse HEAD', { cwd: repo, encoding: 'utf-8' }).trim();
    // committed rename in base..HEAD.
    git(repo, 'mv oldname.php newname.php');
    git(repo, 'commit -q -am rename');

    db = new LuxDatabase(join(repo, '.lux', 'lux.db'));
  });

  afterEach(() => {
    db.close();
    if (existsSync(repo)) rmSync(repo, { recursive: true, force: true });
  });

  function base(): BaseResolution {
    return { ref: baseSha, sha: baseSha, source: 'flag' };
  }

  it('records a committed rename as a single entry whose ORIGIN drives indexPaths', () => {
    const cs = resolveDeltaChangeSet(repo, db, { base: base(), committedOnly: true });
    const renamed = cs.files.filter((f) => f.status === 'renamed');
    expect(renamed).toHaveLength(1);
    expect(renamed[0].path).toBe('newname.php');
    expect(renamed[0].renamedFrom).toBe('oldname.php');
    expect(renamed[0].indexTrust).toBe('index-stale');
    // the index's facts live under the OLD path → indexPaths carries the origin.
    expect(cs.indexPaths).toContain('oldname.php');
    expect(cs.indexPaths).not.toContain('newname.php');
  });

  it('includes an untracked indexable file as index-absent and filters non-source untracked', () => {
    writeFileSync(join(repo, 'scratch.php'), '<?php // new');
    writeFileSync(join(repo, 'notes.log'), 'scratch');

    const cs = resolveDeltaChangeSet(repo, db, { base: base(), committedOnly: false });
    const scratch = cs.files.find((f) => f.path === 'scratch.php');
    expect(scratch?.status).toBe('untracked');
    expect(scratch?.indexTrust).toBe('index-absent');
    // .log is not an indexable extension → filtered out (Decision 11).
    expect(cs.files.find((f) => f.path === 'notes.log')).toBeUndefined();
    expect(isIndexablePath('notes.log')).toBe(false);
    expect(isIndexablePath('scratch.php')).toBe(true);
  });

  it('never hard-fails on an unscoped file — module is (unscoped)', () => {
    const cs = resolveDeltaChangeSet(repo, db, { base: base(), committedOnly: true });
    // root-level file → resolves to the (unscoped) fallback, never throws (SC-2).
    expect(cs.files[0].module).toBe('(unscoped)');
  });

  it('--committed-only drops working-tree entries', () => {
    writeFileSync(join(repo, 'scratch.php'), '<?php // new');

    const withWt = resolveDeltaChangeSet(repo, db, { base: base(), committedOnly: false });
    expect(withWt.files.find((f) => f.path === 'scratch.php')).toBeDefined();
    expect(withWt.head.workingTreeIncluded).toBe(true);

    const committedOnly = resolveDeltaChangeSet(repo, db, { base: base(), committedOnly: true });
    expect(committedOnly.files.find((f) => f.path === 'scratch.php')).toBeUndefined();
    expect(committedOnly.head.workingTreeIncluded).toBe(false);
  });
});
