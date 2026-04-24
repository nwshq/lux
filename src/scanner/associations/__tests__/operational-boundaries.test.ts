import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { LuxDatabase } from '../../../db/index.js';
import type { ScanResult } from '../../types.js';
import type { AssociationContext } from '../types.js';
import { rebuildStructuralOverlay } from '../overlay-service.js';
import { LaravelCommandExtractor } from '../framework/laravel/commands.js';
import { LaravelSchedulerExtractor } from '../framework/laravel/scheduler.js';
import { LaravelJobDispatchExtractor } from '../framework/laravel/jobs.js';
import { LaravelEventListenerExtractor } from '../framework/laravel/events.js';

const testDir = join(import.meta.dirname, 'fixtures', 'operational-boundaries-test');
const ROOT = '/app';

function makeDb(): LuxDatabase {
  mkdirSync(testDir, { recursive: true });
  return new LuxDatabase(join(testDir, 'test.db'));
}

function makeContext(
  entries: Array<{ filePath: string; languageId?: string; content?: string }>
): AssociationContext {
  return {
    rootPath: ROOT,
    nodes: [],
    entries: entries.map((entry) => ({
      filePath: entry.filePath,
      languageId: entry.languageId,
      metadata: entry.content ? { content: entry.content } : {},
    })),
    dirtyFiles: [],
  };
}

function makeScan(entries: Array<{ filePath: string; content: string }>): ScanResult {
  return {
    knowledge: entries.map((entry) => ({
      type: 'source-code',
      title: entry.filePath,
      filePath: join(ROOT, entry.filePath),
      frontmatter: { language: 'php', extension: '.php' },
      content: entry.content,
    })),
  };
}

describe('operational boundary extractors', () => {
  let db: LuxDatabase;

  beforeEach(() => {
    db = makeDb();
  });

  afterEach(() => {
    db.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('extracts Artisan command boundaries and handlers', async () => {
    const extractor = new LaravelCommandExtractor();
    const ctx = makeContext([
      {
        filePath: 'app/Console/Commands/SyncInvoices.php',
        languageId: 'php',
        content: [
          '<?php',
          'namespace App\\Console\\Commands;',
          'use Illuminate\\Console\\Command;',
          'class SyncInvoices extends Command {',
          "    protected $signature = 'invoices:sync {account}';",
          '}',
        ].join('\n'),
      },
    ]);

    const batch = await extractor.extract(ctx);

    expect(batch.boundaries).toHaveLength(1);
    expect(batch.boundaries[0]).toMatchObject({
      kind: 'command',
      name: 'invoices:sync',
      trust_tier: 5,
    });
    expect(batch.handlers[0].symbol_id).toBe('symbol:php:App\\Console\\Commands\\SyncInvoices');
    expect(batch.edges[0].edge_type).toBe('HANDLED_BY');
    expect(batch.contracts[0].payload_schema).toContain('invoices:sync {account}');
  });

  it('extracts scheduler boundaries and trigger edges', async () => {
    const extractor = new LaravelSchedulerExtractor();
    const ctx = makeContext([
      {
        filePath: 'app/Console/Kernel.php',
        languageId: 'php',
        content: [
          '<?php',
          'namespace App\\Console;',
          'use App\\Jobs\\RefreshReport;',
          'class Kernel {',
          '  protected function schedule($schedule): void {',
          "    $schedule->command('invoices:sync')->dailyAt('01:00');",
          '    $schedule->job(new RefreshReport())->hourly();',
          '  }',
          '}',
        ].join('\n'),
      },
    ]);

    const batch = await extractor.extract(ctx);
    const triggerEdges = batch.edges.filter((edge) => edge.edge_type === 'TRIGGERS');

    expect(batch.boundaries.some((boundary) => boundary.kind === 'schedule')).toBe(true);
    expect(batch.boundaries.some((boundary) => boundary.kind === 'command')).toBe(true);
    expect(batch.boundaries.some((boundary) => boundary.kind === 'job')).toBe(true);
    expect(triggerEdges).toHaveLength(2);
    expect(triggerEdges.some((edge) => edge.transport === 'sync')).toBe(true);
    expect(triggerEdges.some((edge) => edge.transport === 'queue')).toBe(true);
  });

  it('extracts job dispatch edges from the current structural context', async () => {
    const extractor = new LaravelJobDispatchExtractor();
    const ctx = makeContext([
      {
        filePath: 'app/Http/Controllers/ReportController.php',
        languageId: 'php',
        content: [
          '<?php',
          'namespace App\\Http\\Controllers;',
          'use App\\Jobs\\RefreshReport;',
          'use Illuminate\\Support\\Facades\\Bus;',
          'class ReportController {',
          '  public function store(): void {',
          '    RefreshReport::dispatch();',
          '    Bus::dispatchSync(new RefreshReport());',
          '  }',
          '}',
        ].join('\n'),
      },
    ]);

    const batch = await extractor.extract(ctx);
    const dispatchEdges = batch.edges.filter((edge) => edge.edge_type === 'DISPATCHES');

    expect(dispatchEdges).toHaveLength(2);
    expect(dispatchEdges[0].source_id).toBe('symbol:php:App\\Http\\Controllers\\ReportController');
    expect(dispatchEdges[0].target_id).toBe('opb:job:App\\Jobs\\RefreshReport');
    expect(dispatchEdges.map((edge) => edge.transport).sort()).toEqual(['async', 'sync']);
    expect(batch.edges.some((edge) => edge.edge_type === 'HANDLED_BY')).toBe(true);
  });

  it('extracts event boundaries and listener handlers', async () => {
    const extractor = new LaravelEventListenerExtractor();
    const ctx = makeContext([
      {
        filePath: 'app/Providers/EventServiceProvider.php',
        languageId: 'php',
        content: [
          '<?php',
          'namespace App\\Providers;',
          'use App\\Events\\ListingImported;',
          'use App\\Listeners\\SendListingImportedEmail;',
          'use App\\Listeners\\SyncSearchIndex;',
          'class EventServiceProvider {',
          '  protected $listen = [',
          '    ListingImported::class => [',
          '      SendListingImportedEmail::class,',
          '      SyncSearchIndex::class,',
          '    ],',
          '  ];',
          '}',
        ].join('\n'),
      },
    ]);

    const batch = await extractor.extract(ctx);

    expect(batch.boundaries).toHaveLength(1);
    expect(batch.boundaries[0].name).toBe('App\\Events\\ListingImported');
    expect(batch.handlers).toHaveLength(2);
    expect(batch.edges.every((edge) => edge.edge_type === 'HANDLED_BY')).toBe(true);
    expect(batch.contracts[0].payload_schema).toContain('App\\\\Events\\\\ListingImported');
  });

  it('persists operational boundaries during overlay rebuild', async () => {
    const scan = makeScan([
      {
        filePath: 'app/Console/Commands/SyncInvoices.php',
        content: [
          '<?php',
          'namespace App\\Console\\Commands;',
          'use Illuminate\\Console\\Command;',
          'class SyncInvoices extends Command {',
          "    protected $signature = 'invoices:sync';",
          '}',
        ].join('\n'),
      },
      {
        filePath: 'app/Providers/EventServiceProvider.php',
        content: [
          '<?php',
          'namespace App\\Providers;',
          'use App\\Events\\ListingImported;',
          'use App\\Listeners\\SyncSearchIndex;',
          'class EventServiceProvider {',
          '  protected $listen = [',
          '    ListingImported::class => [SyncSearchIndex::class],',
          '  ];',
          '}',
        ].join('\n'),
      },
      {
        filePath: 'app/Http/Controllers/ReportController.php',
        content: [
          '<?php',
          'namespace App\\Http\\Controllers;',
          'use App\\Jobs\\RefreshReport;',
          'class ReportController {',
          '  public function store(): void {',
          '    RefreshReport::dispatch();',
          '  }',
          '}',
        ].join('\n'),
      },
    ]);

    const overlay = await rebuildStructuralOverlay(db, ROOT, scan, new Map(), {
      resolvers: [],
      detectors: [],
    });

    expect(overlay.fileNodes).toBe(3);
    expect(db.getOperationalBoundariesByKind('command')).toHaveLength(1);
    expect(db.getOperationalBoundariesByKind('event')).toHaveLength(1);
    expect(db.getOperationalBoundariesByKind('job')).toHaveLength(1);
    expect(db.getOperationalEdgesForSource('opb:event:App\\Events\\ListingImported')).toHaveLength(
      1
    );
    expect(
      db.getOperationalEdgesForSource('symbol:php:App\\Http\\Controllers\\ReportController')
    ).toHaveLength(1);
  });
});
