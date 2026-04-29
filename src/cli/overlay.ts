// CLI command group for overlay inspection and validation.
//
// Commands:
//   lux overlay status  — display current overlay trust state from the DB
//   lux overlay check   — assert overlay is overlay-complete; exits 1 if degraded

import type { Command } from 'commander';
import { LuxDatabase } from '../db/index.js';
import { resolveCorpusPath, resolveDbPath } from '../utils/runtime-paths.js';
import { runFeaturePathAsk } from './feature-path.js';
import { runOperationalAsk } from './operational.js';
import {
  describeOverlayTrustInspection,
  deriveOverlayTrustLevelFromState,
  inspectOverlayTrustState,
} from '../scanner/overlay-trust-state.js';
import {
  aggregateModuleBoundaryEvidence,
  type ModuleBoundaryAggregate,
} from '../experts/module-boundary-analysis.js';

type BoundaryFocusDirection = 'inbound' | 'outbound' | 'both';
type BoundaryExploreListKind = 'overview' | 'regions' | 'families';

interface BoundaryRegionSummary {
  region: string;
  inboundCount: number;
  outboundCount: number;
  totalWeight: number;
  neighborCount: number;
  families: string[];
}

interface BoundaryFamilySummary {
  family: string;
  relationshipCount: number;
  totalWeight: number;
  regionCount: number;
  regions: string[];
}

function totalBoundaryWeight(aggregate: ModuleBoundaryAggregate): number {
  return aggregate.directWeight + aggregate.projectedWeight + aggregate.supportingWeight;
}

function applyBoundaryFocus(
  aggregates: ModuleBoundaryAggregate[],
  focusRegion?: string,
  focusDirection: BoundaryFocusDirection = 'both'
): ModuleBoundaryAggregate[] {
  if (!focusRegion) return [...aggregates];

  return aggregates.filter((aggregate) => {
    if (focusDirection === 'inbound') {
      return aggregate.targetRegion === focusRegion;
    }

    if (focusDirection === 'outbound') {
      return aggregate.sourceRegion === focusRegion;
    }

    return aggregate.sourceRegion === focusRegion || aggregate.targetRegion === focusRegion;
  });
}

function buildRegionSummaries(aggregates: ModuleBoundaryAggregate[]): BoundaryRegionSummary[] {
  const summaries = new Map<
    string,
    {
      region: string;
      inboundCount: number;
      outboundCount: number;
      totalWeight: number;
      neighbors: Set<string>;
      families: Set<string>;
    }
  >();

  const upsert = (region: string) => {
    const existing = summaries.get(region);
    if (existing) return existing;

    const created = {
      region,
      inboundCount: 0,
      outboundCount: 0,
      totalWeight: 0,
      neighbors: new Set<string>(),
      families: new Set<string>(),
    };
    summaries.set(region, created);
    return created;
  };

  for (const aggregate of aggregates) {
    const weight = totalBoundaryWeight(aggregate);
    const source = upsert(aggregate.sourceRegion);
    source.outboundCount += 1;
    source.totalWeight += weight;
    source.neighbors.add(aggregate.targetRegion);
    for (const family of aggregate.families) source.families.add(family);

    const target = upsert(aggregate.targetRegion);
    target.inboundCount += 1;
    target.totalWeight += weight;
    target.neighbors.add(aggregate.sourceRegion);
    for (const family of aggregate.families) target.families.add(family);
  }

  return Array.from(summaries.values())
    .map((summary) => ({
      region: summary.region,
      inboundCount: summary.inboundCount,
      outboundCount: summary.outboundCount,
      totalWeight: summary.totalWeight,
      neighborCount: summary.neighbors.size,
      families: Array.from(summary.families).sort(),
    }))
    .sort(
      (left, right) =>
        right.totalWeight - left.totalWeight || right.neighborCount - left.neighborCount
    );
}

function buildFamilySummaries(aggregates: ModuleBoundaryAggregate[]): BoundaryFamilySummary[] {
  const summaries = new Map<
    string,
    {
      family: string;
      relationshipCount: number;
      totalWeight: number;
      regions: Set<string>;
    }
  >();

  for (const aggregate of aggregates) {
    const weight = totalBoundaryWeight(aggregate);
    for (const family of aggregate.families) {
      const existing = summaries.get(family) ?? {
        family,
        relationshipCount: 0,
        totalWeight: 0,
        regions: new Set<string>(),
      };
      existing.relationshipCount += 1;
      existing.totalWeight += weight;
      existing.regions.add(aggregate.sourceRegion);
      existing.regions.add(aggregate.targetRegion);
      summaries.set(family, existing);
    }
  }

  return Array.from(summaries.values())
    .map((summary) => ({
      family: summary.family,
      relationshipCount: summary.relationshipCount,
      totalWeight: summary.totalWeight,
      regionCount: summary.regions.size,
      regions: Array.from(summary.regions).sort(),
    }))
    .sort(
      (left, right) =>
        right.totalWeight - left.totalWeight || right.relationshipCount - left.relationshipCount
    );
}

function takeTop<T>(items: T[], top?: number): T[] {
  return top === undefined ? items : items.slice(0, top);
}

function runBoundaryExplore(
  program: Command,
  options: {
    json?: boolean;
    list?: string;
    focus?: string;
    top?: number;
  }
): void {
  const opts = program.opts();
  const corpusPath = resolveCorpusPath({ corpus: opts.corpus as string | undefined });
  const db = new LuxDatabase(
    resolveDbPath({ corpus: corpusPath, db: opts.db as string | undefined })
  );

  const listKind = (options.list ?? 'overview') as BoundaryExploreListKind;
  if (!['overview', 'regions', 'families'].includes(listKind)) {
    db.close();
    console.error('Error: --list must be one of: overview, regions, families.');
    process.exit(1);
  }

  if (options.top !== undefined && (!Number.isFinite(options.top) || options.top < 1)) {
    db.close();
    console.error('Error: --top must be a positive integer.');
    process.exit(1);
  }

  const inspection = inspectOverlayTrustState(db);
  const trustLevel = deriveOverlayTrustLevelFromState(inspection.state);
  const aggregates = aggregateModuleBoundaryEvidence(db, {
    rootPath: corpusPath,
    mode: 'projected',
    minWeight: 0,
  });
  const regionSummaries = buildRegionSummaries(aggregates);
  const familySummaries = buildFamilySummaries(aggregates);
  const availableRegions = regionSummaries.map((summary) => summary.region);
  const availableFamilies = familySummaries.map((summary) => summary.family);
  const focusedNeighborhood = options.focus
    ? aggregates
        .filter(
          (aggregate) =>
            aggregate.sourceRegion === options.focus || aggregate.targetRegion === options.focus
        )
        .sort((left, right) => totalBoundaryWeight(right) - totalBoundaryWeight(left))
    : [];

  const overview = {
    trustLevel,
    relationshipCount: aggregates.length,
    regionCount: regionSummaries.length,
    familyCount: familySummaries.length,
    topRegions: takeTop(regionSummaries, options.top ?? 10),
    topFamilies: takeTop(familySummaries, options.top ?? 10),
    availableRegions,
    availableFamilies,
    focusRegion: options.focus ?? null,
    neighborhood:
      options.focus === undefined
        ? null
        : {
            region: options.focus,
            count: focusedNeighborhood.length,
            relationships: takeTop(focusedNeighborhood, options.top),
          },
  };

  if (options.json) {
    const payload =
      listKind === 'regions'
        ? {
            trustLevel,
            list: 'regions',
            count: regionSummaries.length,
            regions: takeTop(regionSummaries, options.top),
          }
        : listKind === 'families'
          ? {
              trustLevel,
              list: 'families',
              count: familySummaries.length,
              families: takeTop(familySummaries, options.top),
            }
          : overview;

    console.log(JSON.stringify(payload, null, 2));
    db.close();
    return;
  }

  console.log(`\nBoundary Exploration`);
  console.log(`Trust Level: ${trustLevel}`);
  console.log(`Relationships: ${aggregates.length}`);
  console.log(`Regions: ${regionSummaries.length}`);
  console.log(`Families: ${familySummaries.length}`);

  if (listKind === 'families') {
    console.log('\nFamilies');
    for (const family of takeTop(familySummaries, options.top)) {
      console.log(
        `- ${family.family}  relationships=${family.relationshipCount} regions=${family.regionCount} weight=${family.totalWeight.toFixed(2)}`
      );
    }
    db.close();
    return;
  }

  console.log('\nRegions');
  for (const region of takeTop(regionSummaries, options.top ?? 10)) {
    console.log(
      `- ${region.region}  inbound=${region.inboundCount} outbound=${region.outboundCount} neighbors=${region.neighborCount} weight=${region.totalWeight.toFixed(2)}`
    );
  }

  if (listKind === 'overview') {
    console.log('\nFamilies');
    for (const family of takeTop(familySummaries, options.top ?? 10)) {
      console.log(
        `- ${family.family}  relationships=${family.relationshipCount} regions=${family.regionCount} weight=${family.totalWeight.toFixed(2)}`
      );
    }
  }

  if (options.focus) {
    console.log(`\nNeighborhood: ${options.focus}`);
    if (focusedNeighborhood.length === 0) {
      console.log('No relationships found for that region.');
    } else {
      for (const aggregate of takeTop(focusedNeighborhood, options.top ?? 10)) {
        console.log(
          `- ${aggregate.sourceRegion} -> ${aggregate.targetRegion}  ${aggregate.relationshipKind}  weight=${totalBoundaryWeight(aggregate).toFixed(2)}`
        );
      }
    }
  }

  db.close();
}

function runBoundaryAggregates(
  program: Command,
  options: {
    json?: boolean;
    directOnly?: boolean;
    minWeight?: number;
    focus?: string;
    focusDirection?: string;
    top?: number;
    includePaths?: boolean;
  }
): void {
  const opts = program.opts();
  const corpusPath = resolveCorpusPath({ corpus: opts.corpus as string | undefined });
  const db = new LuxDatabase(
    resolveDbPath({ corpus: corpusPath, db: opts.db as string | undefined })
  );

  const focusDirection = (options.focusDirection ?? 'both') as BoundaryFocusDirection;
  if (!['inbound', 'outbound', 'both'].includes(focusDirection)) {
    db.close();
    console.error('Error: --focus-direction must be one of: inbound, outbound, both.');
    process.exit(1);
  }

  if (options.top !== undefined && (!Number.isFinite(options.top) || options.top < 1)) {
    db.close();
    console.error('Error: --top must be a positive integer.');
    process.exit(1);
  }

  const inspection = inspectOverlayTrustState(db);
  const trustLevel = deriveOverlayTrustLevelFromState(inspection.state);
  const baseAggregates = aggregateModuleBoundaryEvidence(db, {
    rootPath: corpusPath,
    mode: options.directOnly ? 'direct-only' : 'projected',
    minWeight: options.minWeight ?? 0,
  });
  let aggregates = applyBoundaryFocus(baseAggregates, options.focus, focusDirection).sort(
    (left, right) => totalBoundaryWeight(right) - totalBoundaryWeight(left)
  );
  const totalCount = aggregates.length;

  if (options.top !== undefined) {
    aggregates = aggregates.slice(0, options.top);
  }

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          trustLevel,
          mode: options.directOnly ? 'direct-only' : 'projected',
          focusRegion: options.focus ?? null,
          focusDirection: options.focus ? focusDirection : null,
          totalCount,
          count: aggregates.length,
          aggregates,
        },
        null,
        2
      )
    );
    db.close();
    return;
  }

  console.log(`\nBoundary Aggregates: ${aggregates.length}`);
  console.log(`Trust Level: ${trustLevel}`);
  console.log(`Mode: ${options.directOnly ? 'direct-only' : 'projected'}`);
  if (options.focus) {
    console.log(`Focus: ${options.focus} (${focusDirection})`);
  }
  if (options.top !== undefined) {
    console.log(`Top: ${aggregates.length} of ${totalCount}`);
  }

  if (aggregates.length === 0) {
    console.log('No module-boundary relationships found.');
    db.close();
    return;
  }

  for (const aggregate of aggregates) {
    console.log(
      `${aggregate.sourceRegion} -> ${aggregate.targetRegion}  ${aggregate.relationshipKind}  ` +
        `direct=${aggregate.directWeight.toFixed(2)} projected=${aggregate.projectedWeight.toFixed(2)} supporting=${aggregate.supportingWeight.toFixed(2)}`
    );
    console.log(`  families: ${aggregate.families.join(', ')}`);
    console.log(`  why: ${aggregate.rationaleSummary}`);
    const samplePaths = options.includePaths
      ? aggregate.samplePaths
      : aggregate.samplePaths.slice(0, 1);
    for (const [index, sample] of samplePaths.entries()) {
      const transit =
        sample.transitFiles && sample.transitFiles.length > 0
          ? ` via ${sample.transitFiles.join(', ')}`
          : '';
      const sampleLabel = samplePaths.length > 1 ? `sample ${index + 1}` : 'sample';
      console.log(`  ${sampleLabel}: ${sample.pathKind}${transit}`);
      if (options.includePaths) {
        for (const provenance of sample.provenanceSummary) {
          console.log(`    - ${provenance}`);
        }
      }
    }
  }

  db.close();
}

export function addOverlayCommands(program: Command): void {
  const overlayCmd = program
    .command('overlay')
    .description('Inspect and validate the structural overlay state.');

  // --------------------------------------------------------------------------
  // overlay status
  // --------------------------------------------------------------------------

  overlayCmd
    .command('status')
    .description('Display the current structural overlay trust state.')
    .option('--json', 'Emit machine-readable JSON instead of human-readable text')
    .action((options: { json?: boolean }) => {
      const opts = program.opts();
      const corpusPath = resolveCorpusPath({ corpus: opts.corpus as string | undefined });
      const db = new LuxDatabase(
        resolveDbPath({ corpus: corpusPath, db: opts.db as string | undefined })
      );

      const inspection = inspectOverlayTrustState(db);
      const overlay = inspection.state;
      const diagnostics = describeOverlayTrustInspection(inspection);

      if (options.json) {
        console.log(
          JSON.stringify(
            overlay
              ? {
                  ...overlay,
                  trustLevel: diagnostics.trustLevel,
                  trustSource: diagnostics.trustSource,
                  warnings: diagnostics.warnings,
                }
              : diagnostics,
            null,
            2
          )
        );
      } else if (!overlay) {
        console.log('\nOverlay Status: none');
        console.log(`Trust Level: ${diagnostics.trustLevel}`);
        for (const warning of diagnostics.warnings) {
          console.log(warning);
        }
      } else {
        console.log(`\nOverlay Status: ${overlay.mode}`);
        console.log(`Trust Level: ${diagnostics.trustLevel}`);
        console.log(`Surfaces: ${overlay.surfaceCount}`);
        console.log(
          `Provider kinds: ${overlay.controllerBackedCount} controller-backed, ${overlay.closureBackedCount} closure-backed, ${overlay.unknownProviderKindCount} unknown`
        );
        console.log(`Nodes: ${overlay.fileNodeCount} files, ${overlay.symbolNodeCount} symbols`);
        console.log(`Trust source: ${inspection.source}`);
        if (overlay.lastIndexedCommit) {
          console.log(`Indexed commit: ${overlay.lastIndexedCommit.slice(0, 8)}`);
        }
        if (overlay.recordedAt) {
          console.log(`Trust recorded: ${overlay.recordedAt}`);
        }
        for (const w of overlay.warnings) {
          console.warn(`Warning: ${w}`);
        }
      }

      db.close();
    });

  // --------------------------------------------------------------------------
  // overlay check
  // --------------------------------------------------------------------------

  overlayCmd
    .command('check')
    .description(
      'Assert that the structural overlay is present and non-degraded.\n' +
        '  Exits 0 when surfaces, file nodes, and symbol nodes are all present.\n' +
        '  Exits 1 with a diagnostic when the overlay is absent or degraded.\n' +
        '  Use this as a pre-flight gate in validation scripts and benchmarks.'
    )
    .action(() => {
      const opts = program.opts();
      const corpusPath = resolveCorpusPath({ corpus: opts.corpus as string | undefined });
      const db = new LuxDatabase(
        resolveDbPath({ corpus: corpusPath, db: opts.db as string | undefined })
      );

      const inspection = inspectOverlayTrustState(db);
      const overlay = inspection.state;
      const trustLevel = deriveOverlayTrustLevelFromState(overlay);

      db.close();

      if (!overlay) {
        console.error('Error: No structural overlay trust state found in database.');
        console.error('  Trust level: no-overlay');
        console.error('  Run "lux index rebuild" to build the canonical overlay-complete index.');
        process.exit(1);
      }

      if (trustLevel !== 'overlay-complete') {
        console.error(
          `Error: Overlay trust level is ${trustLevel} (persisted mode: ${overlay.mode}), not overlay-complete.`
        );
        for (const warning of overlay.warnings) {
          console.error(`  Warning: ${warning}`);
        }
        console.error('  Run "lux index rebuild" to restore the canonical overlay-complete state.');
        process.exit(1);
      }

      console.log(
        `Overlay check passed: ${overlay.surfaceCount} surface(s), ` +
          `${overlay.fileNodeCount} file node(s), ${overlay.symbolNodeCount} symbol node(s).`
      );
    });

  // --------------------------------------------------------------------------
  // overlay boundaries
  // --------------------------------------------------------------------------

  const boundariesCmd = overlayCmd
    .command('boundaries')
    .description(
      'Aggregate module-boundary relationships from persisted structural evidence.\n' +
        '  Emits explainable region relationships that distinguish direct, projected,\n' +
        '  and supporting evidence tiers.'
    );

  boundariesCmd
    .command('explore')
    .description(
      'List available boundary regions, evidence families, and lightweight neighborhood summaries\n' +
        '  so callers can explore the space before issuing focused boundary queries.'
    )
    .option('--json', 'Emit machine-readable JSON instead of human-readable text')
    .option(
      '--list <kind>',
      'What to list: overview, regions, or families (default: overview)',
      'overview'
    )
    .option('--focus <region>', 'Show neighborhood information centered on the given region')
    .option('--top <count>', 'Limit listed results to the top N items after sorting', (value) =>
      Number.parseInt(value, 10)
    )
    .action((options: { json?: boolean; list?: string; focus?: string; top?: number }) => {
      runBoundaryExplore(program, options);
    });

  boundariesCmd
    .command('show')
    .description(
      'Show aggregated module-boundary relationships from persisted structural evidence.'
    )
    .option('--json', 'Emit machine-readable JSON instead of human-readable text')
    .option(
      '--direct-only',
      'Disable projected-through-glue contribution and show only direct structural paths'
    )
    .option(
      '--min-weight <value>',
      'Filter out low-weight relationships (default: 0)',
      (value) => Number.parseFloat(value),
      0
    )
    .option('--focus <region>', 'Limit output to relationships connected to the given region')
    .option(
      '--focus-direction <direction>',
      'When used with --focus, show inbound, outbound, or both relationships (default: both)',
      'both'
    )
    .option('--top <count>', 'Limit output to the top N relationships after filtering', (value) =>
      Number.parseInt(value, 10)
    )
    .option(
      '--include-paths',
      'In text output, show all available sample paths with provenance instead of just the first sample'
    )
    .action(
      (options: {
        json?: boolean;
        directOnly?: boolean;
        minWeight?: number;
        focus?: string;
        focusDirection?: string;
        top?: number;
        includePaths?: boolean;
      }) => {
        runBoundaryAggregates(program, options);
      }
    );

  boundariesCmd
    .command('list-regions')
    .description('List discovered boundary regions.')
    .option('--json', 'Emit machine-readable JSON instead of human-readable text')
    .option('--top <count>', 'Limit listed results to the top N items after sorting', (value) =>
      Number.parseInt(value, 10)
    )
    .action((options: { json?: boolean; top?: number }) => {
      runBoundaryExplore(program, { ...options, list: 'regions' });
    });

  boundariesCmd
    .command('list-families')
    .description('List discovered boundary evidence families.')
    .option('--json', 'Emit machine-readable JSON instead of human-readable text')
    .option('--top <count>', 'Limit listed results to the top N items after sorting', (value) =>
      Number.parseInt(value, 10)
    )
    .action((options: { json?: boolean; top?: number }) => {
      runBoundaryExplore(program, { ...options, list: 'families' });
    });

  boundariesCmd
    .command('neighborhood <region>')
    .description('Show the local boundary neighborhood around a region.')
    .option('--json', 'Emit machine-readable JSON instead of human-readable text')
    .option('--top <count>', 'Limit listed results to the top N items after sorting', (value) =>
      Number.parseInt(value, 10)
    )
    .action((region: string, options: { json?: boolean; top?: number }) => {
      runBoundaryExplore(program, { ...options, focus: region, list: 'overview' });
    });

  // --------------------------------------------------------------------------
  // overlay operational
  // --------------------------------------------------------------------------

  const operationalCmd = overlayCmd
    .command('operational')
    .description('Ask answer-first questions over persisted operational boundaries.');

  operationalCmd
    .command('ask <question...>')
    .description('Answer one operator question about schedules, dispatch, listeners, or evidence.')
    .option('--json', 'Emit machine-readable JSON instead of human-readable text')
    .option('--target <name>', 'Boundary name/signature/event/job to answer about')
    .option('--kind <kind>', 'Disambiguate target kind: command, schedule, job, event, or http')
    .option(
      '--max-depth <count>',
      'Trust-aware neighborhood depth to include for neighborhood questions (default: 2)',
      (value) => Number.parseInt(value, 10),
      2
    )
    .option(
      '--min-trust-tier <tier>',
      'Minimum edge trust tier to include in the neighborhood (default: 1)',
      (value) => Number.parseInt(value, 10),
      1
    )
    .action(
      (
        question: string[],
        options: {
          json?: boolean;
          target?: string;
          kind?: 'command' | 'schedule' | 'job' | 'event' | 'http';
          maxDepth?: number;
          minTrustTier?: number;
        }
      ) => {
        runOperationalAsk(program, question, options);
      }
    );

  // --------------------------------------------------------------------------
  // overlay feature-path
  // --------------------------------------------------------------------------

  const featurePathCmd = overlayCmd
    .command('feature-path')
    .description('Ask answer-first questions over persisted feature-path retrieval (tranche one).');

  featurePathCmd
    .command('ask <question...>')
    .description(
      'Answer one operator question about a route-centered feature path: handler, contract, ownership, callers, downstream.'
    )
    .option('--json', 'Emit machine-readable JSON instead of human-readable text')
    .option(
      '--target <fragment>',
      'Override the question fragment used for capability-surface resolution'
    )
    .action((question: string[], options: { json?: boolean; target?: string }) => {
      runFeaturePathAsk(program, question, options);
    });
}
