// Vendor pack cache: key derivation stability, cache-dir precedence, path
// shape, and hit/miss/format-mismatch lookup.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join, sep } from 'path';
import {
  deriveComposerLockKey,
  derivePerPackageKey,
  lookupPack,
  packPathForKey,
  resolvePackCacheDir,
} from '../cache.js';
import { PACK_FORMAT_VERSION, VendorPackWriter, type VendorPackManifest } from '../pack-format.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lux-pack-cache-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const LOCK_A = JSON.stringify({
  packages: [
    { name: 'laravel/framework', version: 'v11.0.0', dist: { reference: 'abc' } },
    { name: 'acme/lib', version: '1.2.3', dist: { reference: 'def' } },
  ],
});
const LOCK_B = JSON.stringify({
  packages: [{ name: 'acme/lib', version: '9.9.9', dist: { reference: 'zzz' } }],
});

function projectWithLock(contents: string): string {
  const root = mkdtempSync(join(dir, 'proj-'));
  writeFileSync(join(root, 'composer.lock'), contents);
  return root;
}

describe('deriveComposerLockKey', () => {
  it('is stable for the same lock and changes when the lock changes', () => {
    const a1 = deriveComposerLockKey(projectWithLock(LOCK_A));
    const a2 = deriveComposerLockKey(projectWithLock(LOCK_A));
    const b = deriveComposerLockKey(projectWithLock(LOCK_B));

    expect(a1.digest).toBe(a2.digest);
    expect(a1.digest).not.toBe(b.digest);
    expect(a1.scheme).toBe('composer-lock');
    expect(a1.framework).toBe('laravel/framework@v11.0.0');
    expect(b.framework).toBeUndefined();
  });

  it('per-package scheme ignores lock byte-formatting and keys on the package set', () => {
    const pretty = JSON.parse(LOCK_A) as unknown;
    const key1 = derivePerPackageKey(projectWithLock(LOCK_A));
    const key2 = derivePerPackageKey(projectWithLock(JSON.stringify(pretty, null, 2)));
    expect(key1.scheme).toBe('per-package');
    expect(key1.digest).toBe(key2.digest); // whitespace differs, package set does not
  });
});

describe('resolvePackCacheDir', () => {
  it('honors precedence: --pack-cache > LUX_PACK_CACHE > ~/.lux/packs', () => {
    expect(resolvePackCacheDir({ packCache: '/explicit', env: { LUX_PACK_CACHE: '/env' } })).toBe(
      join(sep, 'explicit')
    );
    expect(resolvePackCacheDir({ env: { LUX_PACK_CACHE: '/env' } })).toBe(join(sep, 'env'));
    expect(resolvePackCacheDir({ env: {} })).toBe(join(homedir(), '.lux', 'packs'));
  });
});

describe('packPathForKey', () => {
  it('embeds the lockhash dir and the format version in the filename', () => {
    const key = deriveComposerLockKey(projectWithLock(LOCK_A));
    const path = packPathForKey(key, { packCache: dir });
    expect(path).toBe(join(dir, key.digest, `pack-v${PACK_FORMAT_VERSION}.db`));
  });
});

function writePack(packPath: string, manifest: VendorPackManifest): void {
  const writer = new VendorPackWriter(packPath);
  writer.write([], []);
  writer.finalize(manifest);
}

describe('lookupPack', () => {
  it('misses when no pack file exists', () => {
    const root = projectWithLock(LOCK_A);
    const lookup = lookupPack(root, { packCache: dir });
    expect(lookup.hit).toBe(false);
    expect(lookup.packPath).toBe(join(dir, lookup.key.digest, `pack-v${PACK_FORMAT_VERSION}.db`));
  });

  it('hits when a format-current pack for the matching key exists', () => {
    const root = projectWithLock(LOCK_A);
    const key = deriveComposerLockKey(root);
    writePack(packPathForKey(key, { packCache: dir }), {
      formatVersion: PACK_FORMAT_VERSION,
      keyScheme: 'composer-lock',
      key: key.digest,
      depth: 'ast-only',
      nodeCount: 0,
      edgeCount: 0,
      buildDurationMs: 1,
      builtAt: 1,
      luxVersion: 't',
    });
    expect(lookupPack(root, { packCache: dir }).hit).toBe(true);
  });

  it('misses on a format-version mismatch (stale schema)', () => {
    const root = projectWithLock(LOCK_A);
    const key = deriveComposerLockKey(root);
    writePack(packPathForKey(key, { packCache: dir }), {
      formatVersion: PACK_FORMAT_VERSION + 999,
      keyScheme: 'composer-lock',
      key: key.digest,
      depth: 'ast-only',
      nodeCount: 0,
      edgeCount: 0,
      buildDurationMs: 1,
      builtAt: 1,
      luxVersion: 't',
    });
    expect(lookupPack(root, { packCache: dir }).hit).toBe(false);
  });
});
