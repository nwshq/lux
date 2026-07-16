// Vendor pack on-disk format: manifest roundtrip, and the self-containment
// guarantee the merge depends on. The write path uses WAL for speed; finalize()
// must fold the WAL into the main .db so a bare copy of the file (no -wal
// sidecar) and a read-only ATTACH both see every row — that is exactly what the
// Phase-0 importVendorPack ATTACH merge relies on.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { StructuralEdge, StructuralNode } from '../../../db/types.js';
import {
  PACK_FORMAT_VERSION,
  VendorPackReader,
  VendorPackWriter,
  type VendorPackManifest,
} from '../pack-format.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lux-pack-fmt-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function sampleNodes(): StructuralNode[] {
  return [
    {
      id: 'symbol:php:Acme\\Lib\\Money',
      node_type: 'symbol',
      file_path: 'vendor/acme/lib/Money.php',
      language_id: 'php',
      symbol_name: 'Money',
      symbol_kind: 'Class',
      qualified_name: 'Acme\\Lib\\Money',
      updated_at: 1000,
    },
    {
      id: 'symbol:php:Acme\\Lib\\Money::add',
      node_type: 'symbol',
      file_path: 'vendor/acme/lib/Money.php',
      language_id: 'php',
      symbol_name: 'add',
      symbol_kind: 'Method',
      qualified_name: 'Acme\\Lib\\Money::add',
      updated_at: 1000,
    },
  ];
}

function sampleEdges(): StructuralEdge[] {
  return [
    {
      id: 'symbol:php:Acme\\Lib\\Money::add→symbol:php:Acme\\Lib\\Money::combine:calls:ast',
      source_node_id: 'symbol:php:Acme\\Lib\\Money::add',
      target_node_id: 'symbol:php:Acme\\Lib\\Money::combine',
      edge_type: 'calls',
      confidence: 0.6,
      confidence_class: 'framework-inferred',
      freshness_status: 'fresh',
      dirty_dependency_count: 0,
      provenance_summary: 'ast-structural [ast-same-file-call]',
      updated_at: 1000,
    },
  ];
}

function manifestFor(nodeCount: number, edgeCount: number): VendorPackManifest {
  return {
    formatVersion: PACK_FORMAT_VERSION,
    keyScheme: 'composer-lock',
    key: 'a'.repeat(64),
    framework: 'laravel/framework@v11.0.0',
    depth: 'ast-only',
    nodeCount,
    edgeCount,
    buildDurationMs: 1234,
    builtAt: 1000,
    luxVersion: '0.0.0-test',
  };
}

describe('VendorPackWriter / VendorPackReader', () => {
  it('roundtrips the manifest through pack_meta', () => {
    const packPath = join(dir, 'pack.db');
    const nodes = sampleNodes();
    const edges = sampleEdges();
    const manifest = manifestFor(nodes.length, edges.length);

    const writer = new VendorPackWriter(packPath);
    writer.write(nodes, edges);
    writer.finalize(manifest);

    const reader = new VendorPackReader(packPath);
    expect(reader.manifest()).toEqual(manifest);
    reader.close();
  });

  it('stamps every node origin="vendor-pack" and leaves edges origin-less', () => {
    const packPath = join(dir, 'pack.db');
    // Deliberately pass a node marked 'local' — the writer must override it.
    const nodes: StructuralNode[] = [{ ...sampleNodes()[0], origin: 'local' }];
    const writer = new VendorPackWriter(packPath);
    writer.write(nodes, sampleEdges());
    writer.finalize(manifestFor(nodes.length, 1));

    const db = new Database(packPath, { readonly: true });
    const origins = db.prepare('SELECT DISTINCT origin FROM structural_nodes').all() as {
      origin: string;
    }[];
    expect(origins).toEqual([{ origin: 'vendor-pack' }]);
    // structural_edges has no origin column (mirrors the project overlay).
    const edgeCols = (
      db.prepare('PRAGMA table_info(structural_edges)').all() as { name: string }[]
    ).map((c) => c.name);
    expect(edgeCols).not.toContain('origin');
    db.close();
  });

  it('produces a self-contained file: a bare copy (no -wal sidecar) has every row', () => {
    const packPath = join(dir, 'pack.db');
    const nodes = sampleNodes();
    const edges = sampleEdges();
    const writer = new VendorPackWriter(packPath);
    writer.write(nodes, edges);
    writer.finalize(manifestFor(nodes.length, edges.length));

    // Copy ONLY the main db file — if finalize() had left rows in the WAL, the
    // copy would be missing them.
    const copyPath = join(dir, 'copy.db');
    copyFileSync(packPath, copyPath);
    expect(existsSync(join(dir, 'copy.db-wal'))).toBe(false);

    const db = new Database(copyPath, { readonly: true, fileMustExist: true });
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
    db.close();
    expect(nodeCount).toBe(nodes.length);
    expect(edgeCount).toBe(edges.length);
  });

  it('is ATTACH-able by a second handle (the merge path)', () => {
    const packPath = join(dir, 'pack.db');
    const nodes = sampleNodes();
    const writer = new VendorPackWriter(packPath);
    writer.write(nodes, sampleEdges());
    writer.finalize(manifestFor(nodes.length, 1));

    // A fresh, independent connection ATTACHes the pack exactly as importVendorPack does.
    const host = new Database(':memory:');
    host.prepare('ATTACH DATABASE ? AS pack').run(packPath);
    const count = (
      host.prepare('SELECT count(*) AS c FROM pack.structural_nodes').get() as {
        c: number;
      }
    ).c;
    host.prepare('DETACH DATABASE pack').run();
    host.close();
    expect(count).toBe(nodes.length);
  });
});
