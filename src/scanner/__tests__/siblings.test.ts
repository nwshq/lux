// sibling resolution tests (spec 10 Part B / Decisions 1,6,7,8 / T1.2). resolveSibling resolves
// each mode (package via a vendor symlink, path, db). resolveSiblings degrades each sibling
// independently — unregistered / db-absent / worktree-missing / schema-skew are RETURNED as
// structured refusals, never thrown (SC-8). buildSiblingRegistry injects the kernel sugar; the
// alias/name helpers and the federation freshness block have fixed, tested shapes (SC-9).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { LuxDatabase } from '../../db/index.js';
import { LuxSqlite } from '../../db/sqlite-adapter.js';
import { loadLspConfig } from '../config.js';
import {
  buildFederationBlock,
  buildSiblingRegistry,
  packageToSiblingName,
  resolveSibling,
  resolveSiblings,
  siblingAlias,
  siblingFreshness,
} from '../siblings.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lux-siblings-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A git worktree with a composer namespace, optionally carrying a built (current-schema) .lux. */
function makeWorktree(dir: string, opts: { indexed?: boolean; ns?: string } = {}): void {
  const ns = opts.ns ?? 'acme\\Core';
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'composer.json'),
    JSON.stringify({ autoload: { 'psr-4': { [`${ns}\\`]: 'src/' } } })
  );
  execSync('git init -q && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init', {
    cwd: dir,
  });
  if (opts.indexed ?? true) {
    new LuxDatabase(join(dir, '.lux', 'lux.db')).close(); // autoMigrate → current schema
  }
}

/** Roll a worktree's built index back one schema version (skew fixture). */
function rollbackSchema(dir: string): void {
  const raw = new LuxSqlite(join(dir, '.lux', 'lux.db'));
  raw.run('DELETE FROM schema_version WHERE version = (SELECT MAX(version) FROM schema_version)');
  raw.close();
}

/** The current schema version (the primary's applied version). */
function currentSchema(): number {
  const p = join(root, 'schemaprobe', '.lux', 'lux.db');
  const db = new LuxDatabase(p);
  const v = db.getAppliedSchemaVersion();
  db.close();
  return v;
}

/** A corpus that vendors `pkg` as a symlink to `kernelDir`. */
function vendorSymlink(corpus: string, pkg: string, kernelDir: string): void {
  mkdirSync(join(corpus, 'vendor', dirname(pkg)), { recursive: true });
  symlinkSync(kernelDir, join(corpus, 'vendor', pkg));
}

describe('siblingAlias / packageToSiblingName', () => {
  it('derives the sib_ alias and the sugar registry name', () => {
    expect(siblingAlias('auctic-core')).toBe('sib_auctic_core');
    expect(siblingAlias('res')).toBe('sib_res');
    expect(packageToSiblingName('acme/core')).toBe('auctic-core');
  });
});

describe('resolveSibling (per mode)', () => {
  it('resolves package mode via the vendor symlink (kernel role → namespace)', () => {
    const kernel = join(root, 'core');
    makeWorktree(kernel);
    const corpus = join(root, 'client');
    mkdirSync(corpus, { recursive: true });
    vendorSymlink(corpus, 'acme/core', kernel);

    const s = resolveSibling(corpus, 'auctic-core', { package: 'acme/core', role: 'kernel' });
    expect(s.alias).toBe('sib_auctic_core');
    expect(s.role).toBe('kernel');
    expect(s.namespace).toBe('acme\\Core');
    expect(s.dbPath.endsWith(join('.lux', 'lux.db'))).toBe(true);
    expect(s.headCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(typeof s.schemaVersion).toBe('number');
  });

  it('resolves path mode (peer role → no namespace)', () => {
    const res = join(root, 'res');
    makeWorktree(res, { ns: 'acme\\Res' });
    const corpus = join(root, 'client');
    mkdirSync(corpus, { recursive: true });

    const s = resolveSibling(corpus, 'res', { path: res });
    expect(s.role).toBe('peer');
    expect(s.namespace).toBeUndefined();
    expect(s.worktree).toBe(realpathSync(res)); // resolveSibling realpaths the worktree
  });

  it('resolves db mode (no worktree → drift unknown)', () => {
    const idx = join(root, 'artifact');
    makeWorktree(idx);
    const corpus = join(root, 'client');
    mkdirSync(corpus, { recursive: true });

    const s = resolveSibling(corpus, 'cached', { db: join(idx, '.lux', 'lux.db') });
    expect(s.worktree).toBeUndefined();
    expect(s.headCommit).toBeUndefined();
    expect(typeof s.schemaVersion).toBe('number');
  });
});

describe('resolveSiblings (degrade per sibling — SC-8, never throws)', () => {
  function makeCorpus(): { corpus: string; schema: number } {
    const schema = currentSchema();
    const corpus = join(root, 'client');
    mkdirSync(corpus, { recursive: true });

    // registered, resolvable
    const res = join(root, 'res');
    makeWorktree(res, { ns: 'acme\\Res' });
    // registered, worktree present but no .lux → db-absent
    const noidx = join(root, 'noidx');
    makeWorktree(noidx, { indexed: false });
    // registered, schema rolled back → schema-skew
    const skew = join(root, 'skew');
    makeWorktree(skew);
    rollbackSchema(skew);

    writeFileSync(
      join(corpus, 'lux.yaml'),
      'siblings:\n' +
        `  res:\n    path: ${res}\n` +
        `  noidx:\n    path: ${noidx}\n` +
        `  skew:\n    path: ${skew}\n` +
        `  gone:\n    path: ${join(root, 'does-not-exist')}\n`
    );
    return { corpus, schema };
  }

  it('returns a resolved sibling for a healthy entry', () => {
    const { corpus, schema } = makeCorpus();
    const [r] = resolveSiblings(corpus, ['res'], schema);
    expect('sibling' in r).toBe(true);
    if ('sibling' in r) expect(r.sibling.name).toBe('res');
  });

  it('returns an `unregistered` refusal for an unknown name', () => {
    const { corpus, schema } = makeCorpus();
    const [r] = resolveSiblings(corpus, ['nope'], schema);
    expect('refusal' in r && r.refusal.reason).toBe('unregistered');
  });

  it('returns a `db-absent` refusal for a worktree with no .lux', () => {
    const { corpus, schema } = makeCorpus();
    const [r] = resolveSiblings(corpus, ['noidx'], schema);
    expect('refusal' in r && r.refusal.reason).toBe('db-absent');
  });

  it('returns a `worktree-missing` refusal for an unresolvable path', () => {
    const { corpus, schema } = makeCorpus();
    const [r] = resolveSiblings(corpus, ['gone'], schema);
    expect('refusal' in r && r.refusal.reason).toBe('worktree-missing');
  });

  it('returns a `schema-skew` refusal when the sibling schema != primary', () => {
    const { corpus, schema } = makeCorpus();
    const [r] = resolveSiblings(corpus, ['skew'], schema);
    expect('refusal' in r && r.refusal.reason).toBe('schema-skew');
  });

  it('returns a `db-unreadable` refusal for a corrupt / non-lux db: file (FIX 1b — never throws)', () => {
    // The path exists (passes existsSync) but is not a readable SQLite/Lux index. resolveSibling's
    // raw schema-version read throws — FIX 1b converts it to a structured SiblingResolveError so
    // resolveSiblings degrades this one sibling instead of a raw throw aborting the whole call.
    const corpus = join(root, 'client');
    mkdirSync(corpus, { recursive: true });
    const bogus = join(root, 'bogus', '.lux', 'lux.db');
    mkdirSync(dirname(bogus), { recursive: true });
    writeFileSync(bogus, 'this is definitely not a sqlite database');
    writeFileSync(join(corpus, 'lux.yaml'), `siblings:\n  bad:\n    db: ${bogus}\n`);

    const [r] = resolveSiblings(corpus, ['bad'], currentSchema());
    expect('refusal' in r && r.refusal.reason).toBe('db-unreadable');
  });

  it('dedups a repeated requested name — one resolution, not two (FIX 2)', () => {
    const { corpus, schema } = makeCorpus();
    const rs = resolveSiblings(corpus, ['res', 'res'], schema);
    expect(rs).toHaveLength(1);
    expect('sibling' in rs[0] && rs[0].sibling.name).toBe('res');
  });

  it('degrades each independently in one pass (some resolve, some refuse)', () => {
    const { corpus, schema } = makeCorpus();
    const rs = resolveSiblings(corpus, ['res', 'noidx', 'gone', 'skew', 'nope'], schema);
    expect(rs.length).toBe(5);
    expect(rs.filter((r) => 'sibling' in r).length).toBe(1);
    expect(rs.filter((r) => 'refusal' in r).length).toBe(4);
  });
});

describe('buildSiblingRegistry (kernel sugar)', () => {
  it('injects the overlay.kernel.package sugar as a role: kernel entry', () => {
    const corpus = join(root, 'sugar');
    mkdirSync(corpus, { recursive: true });
    writeFileSync(join(corpus, 'lux.yaml'), 'overlay:\n  kernel:\n    package: acme/core\n');
    const registry = buildSiblingRegistry(loadLspConfig(corpus));
    expect(registry['auctic-core']).toEqual({ package: 'acme/core', role: 'kernel' });
  });

  it('does not inject sugar when an explicit role: kernel already exists', () => {
    const corpus = join(root, 'explicit');
    mkdirSync(corpus, { recursive: true });
    writeFileSync(
      join(corpus, 'lux.yaml'),
      'siblings:\n  mycore:\n    package: foo/bar\n    role: kernel\n'
    );
    const registry = buildSiblingRegistry(loadLspConfig(corpus));
    expect(Object.keys(registry)).toEqual(['mycore']);
  });
});

describe('federation block (SC-9)', () => {
  it('siblingFreshness marks fresh when indexed == HEAD, stale null when HEAD unknown', () => {
    const fresh = siblingFreshness({
      name: 'x',
      alias: 'sib_x',
      dbPath: '/x/.lux/lux.db',
      role: 'peer',
      indexedCommit: 'abc',
      headCommit: 'abc',
      schemaVersion: 5,
    });
    expect(fresh).toEqual({
      indexedCommit: 'abc',
      headCommit: 'abc',
      stale: false,
      dbSchemaVersion: 5,
    });

    const unknown = siblingFreshness({
      name: 'y',
      alias: 'sib_y',
      dbPath: '/y/.lux/lux.db',
      role: 'peer',
      indexedCommit: 'abc',
      schemaVersion: 5,
    });
    expect(unknown.stale).toBeNull();
    expect(unknown.headCommit).toBeNull();
  });

  it('buildFederationBlock carries attached freshness + a refusal record', () => {
    const block = buildFederationBlock([
      {
        name: 'res',
        sibling: {
          name: 'res',
          alias: 'sib_res',
          dbPath: '/res/.lux/lux.db',
          worktree: '/res',
          role: 'peer',
          indexedCommit: 'aaa',
          headCommit: 'bbb',
          schemaVersion: 5,
        },
      },
      {
        name: 'gone',
        refusal: {
          name: 'gone',
          reason: 'worktree-missing',
          message: 'nope',
          remediation: 'fix it',
        },
      },
    ]);
    expect(block.siblings[0]).toMatchObject({ name: 'res', attached: true, worktree: '/res' });
    expect(block.siblings[0].freshness).toMatchObject({ stale: true, dbSchemaVersion: 5 });
    expect(block.siblings[1]).toMatchObject({ name: 'gone', attached: false, worktree: null });
    expect(block.siblings[1].refusal).toMatchObject({ reason: 'worktree-missing' });
  });
});
