import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { LuxDatabase } from '../../../db/index.js';
import { resolveKernel } from '../kernel-area.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lux-kernel-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A git worktree with a composer.json namespace, optionally carrying a built .lux index. */
function makeKernelWorktree(
  dir: string,
  opts: { indexed: boolean; ns?: string } = { indexed: true }
): void {
  const ns = opts.ns ?? 'Acme\\Core';
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'composer.json'),
    JSON.stringify({ autoload: { 'psr-4': { [`${ns}\\`]: 'src/' } } })
  );
  execSync('git init -q && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init', {
    cwd: dir,
  });
  if (opts.indexed) {
    new LuxDatabase(join(dir, '.lux', 'lux.db')).close(); // autoMigrate → current schema
  }
}

/** A client corpus that vendors `pkg` as a symlink to `kernelDir`. */
function makeClientCorpus(pkg: string, kernelDir: string): string {
  const corpus = join(root, 'client');
  mkdirSync(join(corpus, 'vendor', dirname(pkg)), { recursive: true });
  symlinkSync(kernelDir, join(corpus, 'vendor', pkg));
  return corpus;
}

describe('resolveKernel', () => {
  it('resolves the kernel from the vendor/<package> symlink', () => {
    const kernel = join(root, 'core');
    makeKernelWorktree(kernel);
    const corpus = makeClientCorpus('acme/core', kernel);

    const r = resolveKernel(corpus, { package: 'acme/core' });
    expect(existsSync(r.dbPath)).toBe(true);
    expect(r.dbPath.endsWith(join('.lux', 'lux.db'))).toBe(true);
    expect(r.namespace).toBe('Acme\\Core');
    expect(r.headCommit).toMatch(/^[0-9a-f]{40}$/);
  });

  it('throws when vendor/<package> is absent', () => {
    const corpus = join(root, 'client');
    mkdirSync(corpus, { recursive: true });
    expect(() => resolveKernel(corpus, { package: 'acme/core' })).toThrow(/not found/i);
  });

  it('throws when --kernel override disagrees with the symlink', () => {
    const kernel = join(root, 'core');
    makeKernelWorktree(kernel);
    const other = join(root, 'other');
    makeKernelWorktree(other);
    const corpus = makeClientCorpus('acme/core', kernel);
    expect(() => resolveKernel(corpus, { package: 'acme/core' }, other)).toThrow(/disagrees/i);
  });

  it('fails fast when the vendored kernel has no .lux index (FIX 3: names the worktree + commit)', () => {
    const kernel = join(root, 'core');
    makeKernelWorktree(kernel, { indexed: false });
    const corpus = makeClientCorpus('acme/core', kernel);
    let message = '';
    try {
      resolveKernel(corpus, { package: 'acme/core' });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/no Lux index/i);
    // FIX 3: the shipped message names the vendored worktree realpath and the short HEAD commit —
    // `(<worktree> @ <7-hex>)` — the suffix the sibling-resolver refactor had dropped.
    expect(message).toContain(realpathSync(kernel));
    expect(message).toMatch(/ @ [0-9a-f]{7}\)/);
  });
});

describe('LuxDatabase.attachKernel', () => {
  function freshDb(name: string): { db: LuxDatabase; path: string } {
    const path = join(root, name, '.lux', 'lux.db');
    return { db: new LuxDatabase(path), path };
  }

  it('attaches read-side, passes schema-parity, and detaches (re-attach works)', () => {
    const { db: client } = freshDb('client');
    const { db: kernel, path: kernelPath } = freshDb('kernel');
    kernel.close();
    const before = statSync(kernelPath).mtimeMs;

    // fn runs only if the schema-parity guard (client vs kernel schema_version) passed first
    const v = client.attachKernel(kernelPath, () => 42);
    expect(v).toBe(42);

    // detach happened → a second attach on the same handle succeeds
    expect(() => client.attachKernel(kernelPath, () => 1)).not.toThrow();

    // the kernel file was not written (read-only by discipline)
    expect(statSync(kernelPath).mtimeMs).toBe(before);
    expect(existsSync(`${kernelPath}-journal`)).toBe(false);
    client.close();
  });

  it('blocks writes during the attach window (query_only = ON)', () => {
    const { db: client } = freshDb('c2');
    const { db: kdb, path: kernelPath } = freshDb('k2');
    kdb.close();
    expect(() =>
      client.attachKernel(kernelPath, () => {
        client.upsertStructuralNode({ id: 'symbol:php:W', node_type: 'symbol', updated_at: 1 });
      })
    ).toThrow(/readonly|read.only/i);
    // NB: don't close() here — node-sqlite3-wasm re-throws the deferred write error when
    // finalizing the (deliberately) failed cached statement; the exit handler cleans up.
  });

  it('restores read-write after a clean attach window (query_only reset)', () => {
    const { db: client } = freshDb('c3');
    const { db: kdb, path: kernelPath } = freshDb('k3');
    kdb.close();
    client.attachKernel(kernelPath, () => 1); // read-only fn, no broken statements
    expect(() =>
      client.upsertStructuralNode({ id: 'symbol:php:Z', node_type: 'symbol', updated_at: 1 })
    ).not.toThrow();
    client.close();
  });
});
