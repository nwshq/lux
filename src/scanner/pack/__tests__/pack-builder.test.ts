// Vendor pack build pipeline (ast-only depth — no intelephense in unit tests;
// the full-lsp path is validated in Phase 5 on a real vendor/ tree). Builds a
// pack over a tiny hand-written vendor/ fixture and asserts nodes, edges, and
// the manifest; then asserts ensureVendorPack reuses the cached pack (REQ-6).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildVendorPack, ensureVendorPack } from '../pack-builder.js';

let dir: string;
let projectRoot: string;
let packCache: string;

const MONEY_PHP = `<?php
namespace Acme\\Lib;

class Money
{
    public function add(Money $other): Money
    {
        return $this->combine($other);
    }

    private function combine(Money $other): Money
    {
        return $this;
    }
}
`;

const WALLET_PHP = `<?php
namespace Acme\\Lib;

use Acme\\Lib\\Money;

class Wallet
{
    public function make(): Money
    {
        return new Money();
    }
}
`;

const COMPOSER_LOCK = JSON.stringify({
  packages: [{ name: 'laravel/framework', version: 'v11.0.0', dist: { reference: 'abc' } }],
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lux-pack-build-'));
  projectRoot = join(dir, 'project');
  packCache = join(dir, 'cache');
  const libDir = join(projectRoot, 'vendor', 'acme', 'lib');
  mkdirSync(libDir, { recursive: true });
  writeFileSync(join(libDir, 'Money.php'), MONEY_PHP);
  writeFileSync(join(libDir, 'Wallet.php'), WALLET_PHP);
  // A package test dir that must be excluded from the pack.
  const testDir = join(projectRoot, 'vendor', 'acme', 'lib', 'tests');
  mkdirSync(testDir, { recursive: true });
  writeFileSync(
    join(testDir, 'MoneyTest.php'),
    '<?php\nnamespace Acme\\Lib\\Tests;\nclass MoneyTest {}\n'
  );
  writeFileSync(join(projectRoot, 'composer.lock'), COMPOSER_LOCK);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('buildVendorPack (ast-only)', () => {
  it('builds a pack with vendor nodes, within-vendor edges, and a correct manifest', async () => {
    const { packPath, manifest } = await buildVendorPack(projectRoot, {
      depth: 'ast-only',
      packCache,
      luxVersion: '0.0.0-test',
    });

    expect(manifest.depth).toBe('ast-only');
    expect(manifest.keyScheme).toBe('composer-lock');
    expect(manifest.framework).toBe('laravel/framework@v11.0.0');
    expect(manifest.formatVersion).toBe(1);
    expect(manifest.nodeCount).toBeGreaterThanOrEqual(5);
    expect(manifest.edgeCount).toBeGreaterThanOrEqual(1);

    const db = new Database(packPath, { readonly: true, fileMustExist: true });

    // Manifest counts match what actually landed in the pack.
    const nodeCount = (
      db.prepare('SELECT count(*) AS c FROM structural_nodes').get() as {
        c: number;
      }
    ).c;
    const edgeCount = (
      db.prepare('SELECT count(*) AS c FROM structural_edges').get() as {
        c: number;
      }
    ).c;
    expect(nodeCount).toBe(manifest.nodeCount);
    expect(edgeCount).toBe(manifest.edgeCount);

    // Vendor symbols are present, FQN-identified, and stamped vendor-pack.
    const money = db
      .prepare('SELECT origin, file_path FROM structural_nodes WHERE id = ?')
      .get('symbol:php:Acme\\Lib\\Money') as { origin: string; file_path: string } | undefined;
    expect(money?.origin).toBe('vendor-pack');
    expect(money?.file_path).toBe('vendor/acme/lib/Money.php');

    // The excluded test dir contributed nothing.
    const testNode = db
      .prepare("SELECT count(*) AS c FROM structural_nodes WHERE file_path LIKE '%/tests/%'")
      .get() as { c: number };
    expect(testNode.c).toBe(0);

    // The same-file this-call edge (Money::add → Money::combine) resolved.
    const edge = db
      .prepare(
        'SELECT count(*) AS c FROM structural_edges WHERE source_node_id = ? AND target_node_id = ?'
      )
      .get('symbol:php:Acme\\Lib\\Money::add', 'symbol:php:Acme\\Lib\\Money::combine') as {
      c: number;
    };
    expect(edge.c).toBe(1);

    db.close();
  }, 20000);
});

describe('ensureVendorPack', () => {
  it('builds on a miss then reuses the cached pack on a hit (REQ-6)', async () => {
    const first = await ensureVendorPack(projectRoot, {
      depth: 'ast-only',
      packCache,
      luxVersion: '0.0.0-test',
    });
    expect(first.built).toBe(true);

    const second = await ensureVendorPack(projectRoot, {
      depth: 'ast-only',
      packCache,
      luxVersion: '0.0.0-test',
    });
    expect(second.built).toBe(false);
    expect(second.packPath).toBe(first.packPath);
    expect(second.manifest.key).toBe(first.manifest.key);
  }, 20000);

  it('rebuilds on a hit when force is set', async () => {
    await ensureVendorPack(projectRoot, { depth: 'ast-only', packCache, luxVersion: '0.0.0-test' });
    const forced = await ensureVendorPack(projectRoot, {
      depth: 'ast-only',
      packCache,
      luxVersion: '0.0.0-test',
      force: true,
    });
    expect(forced.built).toBe(true);
  }, 20000);
});
