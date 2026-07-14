// Integration test for the generalScan typed-receiver lifecycle reorder:
// the LSP registry is kept alive through the overlay rebuild, the typed-receiver
// pass persists `proven` edges, and the registry is shut down afterwards — even
// when the pass throws. Uses the `enricherRegistry` DI seam with a fake enricher
// so no real language-server subprocess is spawned.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generalScan } from '../general.js';
import { EnricherRegistry, type LspEnricher, type LspEnricherConfig } from '../lsp/index.js';
import type { LuxLspConfig } from '../config.js';
import { LuxDatabase } from '../../db/index.js';

type ResolveFn = (
  filePath: string,
  line: number,
  character: number
) => Promise<{ filePath: string; line: number } | null>;

/** A minimal in-process enricher: no subprocess, scripted resolveDefinition. */
class FakeTsEnricher implements LspEnricher {
  readonly languageId = 'typescript';
  readonly fileExtensions = ['.ts'];
  readonly config: LspEnricherConfig = { serverCommand: 'fake', serverArgs: [] };
  isReady = false;
  shutdownCount = 0;

  constructor(private readonly resolver: ResolveFn) {}

  initialize(): Promise<void> {
    this.isReady = true;
    return Promise.resolve();
  }
  enrich(): Promise<null> {
    return Promise.resolve(null);
  }
  enrichBatch(): Promise<[]> {
    return Promise.resolve([]);
  }
  shutdown(): Promise<void> {
    this.shutdownCount++;
    this.isReady = false;
    return Promise.resolve();
  }
  resolveDefinition(filePath: string, line: number, character: number) {
    return this.resolver(filePath, line, character);
  }
}

function config(): LuxLspConfig {
  return {
    lsp: { enabled: true, enrichers: [] }, // enrichers ignored — registry is injected
    deps: { enabled: false },
    ast: { enabled: true },
  };
}

describe('generalScan — typed-receiver lifecycle', () => {
  let dir: string;
  let db: LuxDatabase;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lux-tr-'));
    db = new LuxDatabase(join(dir, 'test.db'));
    // package.json marks the dir as a source repo so .ts files are scanned.
    writeFileSync(join(dir, 'package.json'), '{}');
    mkdirSync(join(dir, 'src'), { recursive: true });
    // a.ts: go() calls svc.run() — a typed receiver only LSP can settle.
    writeFileSync(
      join(dir, 'src', 'a.ts'),
      ['export function go(svc) {', '  svc.run();', '}'].join('\n')
    );
    // b.ts: defines the class the receiver resolves to.
    writeFileSync(join(dir, 'src', 'b.ts'), ['export class Svc {', '  run() {}', '}'].join('\n'));
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('persists a proven typed-receiver edge and shuts the registry down after', async () => {
    const aPath = join(dir, 'src', 'a.ts');
    const bPath = join(dir, 'src', 'b.ts');
    // Resolve the `run` token in a.ts to Svc::run (0-based line 1 of b.ts).
    const enricher = new FakeTsEnricher((filePath) =>
      Promise.resolve(filePath === aPath ? { filePath: bPath, line: 1 } : null)
    );
    const registry = new EnricherRegistry();
    registry.register(enricher);

    await generalScan(dir, {
      config: config(),
      db,
      overlayEnabled: true,
      enricherRegistry: registry,
    });

    const edges = db.getStructuralEdgesForNode('symbol:ts:src/a.ts#go');
    const call = edges.find((e) => e.edge_type === 'calls');
    expect(call).toBeDefined();
    expect(call?.target_node_id).toBe('symbol:ts:src/b.ts#Svc.run');
    expect(call?.confidence_class).toBe('proven');
    expect(enricher.shutdownCount).toBe(1); // reaped after the pass
  });

  it('still shuts the registry down when the typed-receiver pass throws', async () => {
    const enricher = new FakeTsEnricher(() => Promise.reject(new Error('LSP boom')));
    const registry = new EnricherRegistry();
    registry.register(enricher);

    // Must not reject — the pass is isolated and the scan completes.
    await expect(
      generalScan(dir, { config: config(), db, overlayEnabled: true, enricherRegistry: registry })
    ).resolves.toBeDefined();

    const edges = db.getStructuralEdgesForNode('symbol:ts:src/a.ts#go');
    expect(
      edges.find((e) => e.edge_type === 'calls' && e.confidence_class === 'proven')
    ).toBeUndefined();
    expect(enricher.shutdownCount).toBe(1); // reaped despite the throw
  });
});
