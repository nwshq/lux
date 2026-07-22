import type { Command } from 'commander';
import { LuxDatabase } from '../../db/index.js';
import { resolveRuntimePaths } from '../../utils/runtime-paths.js';
import {
  deriveOverlayTrustLevelFromState,
  inspectOverlayTrustState,
} from '../overlay-trust-state.js';
import { loadLspConfig } from '../config.js';
import {
  createInvocationId,
  emitUsageEvent,
  safeUsageTrustState,
} from '../../db/observability/usage-event.js';
import { isRefusal, openDeltaDatabase, resolveDeltaBase } from './preflight.js';
import { isIndexablePath, resolveDeltaChangeSet } from './change-set.js';
import { resolveTouchSet } from './touch.js';
import { walkDownstream } from './downstream.js';
import { resolveOwnershipIntersection } from './ownership.js';
import { resolveInvalidatedSpecTargets } from './spec-evidence.js';
import { diffBaseline } from './baseline.js';
import { computeCrossRepoImpact } from './cross-repo.js';
import { evaluateGates, resolveGateCategories } from './gate.js';
import { assembleDeltaReport, renderDeltaText, type AssembleInput } from './report.js';
import type { DeltaOptions, DeltaRefusal, DeltaReportV1 } from './types.js';

/** Pure orchestrator — no I/O, no exit, no close. Shared by the CLI and MCP surfaces. */
export function computeDelta(
  db: LuxDatabase,
  corpusPath: string,
  opts: DeltaOptions
): { report: DeltaReportV1 } | { refusal: DeltaRefusal } {
  const base = resolveDeltaBase(corpusPath, db, opts.base);
  if (isRefusal(base)) {
    // Analysis mode degrades not-a-git-repo / baseline-unavailable to a warning + empty report
    // (Decision 18); --check turns them into refusals. Hard refusals (config-error) always refuse.
    if (
      !opts.check &&
      (base.reason === 'not-a-git-repo' || base.reason === 'baseline-unavailable')
    ) {
      return { report: emptyReport(db, opts, base) };
    }
    return { refusal: base };
  }

  const changeSet = resolveDeltaChangeSet(corpusPath, db, {
    base,
    committedOnly: opts.committedOnly ?? false,
  });
  const touch = resolveTouchSet(db, changeSet);
  const walk = walkDownstream(db, touch, {
    depth: opts.depth,
    maxNodes: opts.maxNodes,
    maxFanout: opts.maxFanout,
    minConfidence: opts.minConfidence,
  });

  // Budget-truncated blind spot (spec 12/14): an indexable changed file that resolved to zero nodes.
  const indexedNodePaths = new Set(
    touch.nodes.map((n) => n.filePath).filter((p): p is string => Boolean(p))
  );
  const newFileBlindSpot = changeSet.files.some(
    (f) =>
      isIndexablePath(f.path) &&
      f.indexTrust !== 'index-fresh' &&
      !indexedNodePaths.has(f.renamedFrom ?? f.path)
  );
  const truncated = walk.truncated || newFileBlindSpot;

  const ownership = resolveOwnershipIntersection(db, touch, { corpusPath });
  const specTargets = resolveInvalidatedSpecTargets(touch, walk.entrySurfaces);

  // Module rollup dependents (Projection 2 / spec 13).
  const changedModules = [
    ...new Set(changeSet.files.map((f) => f.module).filter((m): m is string => Boolean(m))),
  ];
  const dependentsMap = new Map<string, number>();
  for (const m of changedModules) {
    if (m === '(unscoped)') continue;
    for (const dep of db.getModuleDependencies(m, 'target')) {
      dependentsMap.set(
        dep.source_module,
        (dependentsMap.get(dep.source_module) ?? 0) + dep.reference_count
      );
    }
  }
  const modules = {
    changed: changedModules.filter((m) => m !== '(unscoped)'),
    dependents: [...dependentsMap]
      .map(([module, referenceCount]) => ({ module, referenceCount }))
      .sort((a, b) => b.referenceCount - a.referenceCount),
  };

  const trustLevel = deriveOverlayTrustLevelFromState(inspectOverlayTrustState(db).state);
  const warnings: string[] = [];

  let baselineDiff: DeltaReportV1['baselineDiff'];
  if (opts.baselineDb) {
    const bd = diffBaseline(db, corpusPath, opts.baselineDb);
    if (isRefusal(bd)) warnings.push(bd.message);
    else baselineDiff = bd;
  }

  let gate: DeltaReportV1['gate'];
  if (opts.check) {
    const categories = resolveGateCategories(opts.failOn, loadLspConfig(corpusPath).delta?.gates);
    if (isRefusal(categories)) return { refusal: categories };
    const deletedFiles = new Set(
      changeSet.files.filter((f) => f.status === 'deleted').map((f) => f.renamedFrom ?? f.path)
    );
    const handlerFiles = new Map<string, string>();
    const deletedHandlerSymbols = new Set<string>();
    for (const n of touch.nodes) {
      if (n.nodeType === 'symbol' && n.filePath) {
        handlerFiles.set(n.id, n.filePath);
        if (deletedFiles.has(n.filePath)) deletedHandlerSymbols.add(n.id);
      }
    }
    gate = evaluateGates({
      categories,
      trustLevel,
      ownership,
      deletedHandlerSymbols,
      handlerFiles,
      downstreamTruncated: truncated,
      baselineDiff,
    });
  }

  // Cross-repo delta (Decision 9): --against runs delta's downstream machinery inside each named
  // sibling's read-only graph, seeded by portable touched ids. Strictly additive — the envelope
  // stays schemaVersion:1. Decision 6: analysis mode warns per refusal + continues; --check turns
  // an explicitly-named unresolvable sibling into a refusal (no silent pass).
  let crossRepoImpact: DeltaReportV1['crossRepoImpact'];
  if (opts.against && opts.against.length) {
    const { impact, refusals } = computeCrossRepoImpact(db, corpusPath, touch, opts.against, {
      depth: opts.depth,
      maxNodes: opts.maxNodes,
      maxFanout: opts.maxFanout,
      minConfidence: opts.minConfidence,
    });
    crossRepoImpact = impact;
    for (const ref of refusals) warnings.push(`--against ${ref.name}: ${ref.message}`);
    if (opts.check && refusals.length > 0) {
      return {
        refusal: {
          reason: 'config-error',
          message: `--against: ${refusals.map((r) => `${r.name} (${r.reason})`).join(', ')}`,
          remediation: refusals[0].remediation,
        },
      };
    }
  }

  const input: AssembleInput = {
    changeSet,
    touch,
    downstream: walk,
    truncated,
    modules,
    ownership,
    specTargets,
    trust: {
      overlay: trustLevel,
      indexedCommit: db.getIndexMetadata('last_indexed_commit') ?? null,
    },
    budget: { depth: opts.depth, maxNodes: opts.maxNodes },
    gate,
    baselineDiff,
    crossRepoImpact,
    warnings,
  };
  return { report: assembleDeltaReport(input) };
}

function emptyReport(db: LuxDatabase, opts: DeltaOptions, refusal: DeltaRefusal): DeltaReportV1 {
  const trustLevel = deriveOverlayTrustLevelFromState(inspectOverlayTrustState(db).state);
  return assembleDeltaReport({
    changeSet: {
      base: { ref: opts.base ?? '(unresolved)', sha: null, source: opts.base ? 'flag' : 'index' },
      head: { sha: null, workingTreeIncluded: !(opts.committedOnly ?? false) },
      files: [],
      indexPaths: [],
      warnings: [refusal.message],
    },
    touch: {
      nodes: [],
      symbolIds: [],
      surfacesDeclared: [],
      evidenceEdgeCount: 0,
      operationalBoundaries: [],
      orphanedNodeCount: 0,
    },
    downstream: { entrySurfaces: [], asyncBoundaries: [], truncated: false, visitedSymbols: [] },
    truncated: false,
    modules: { changed: [], dependents: [] },
    ownership: {
      kernelConfigured: false,
      kernelResolved: false,
      source: 'unavailable',
      kernelDrift: null,
      transitions: [],
    },
    specTargets: [],
    trust: {
      overlay: trustLevel,
      indexedCommit: db.getIndexMetadata('last_indexed_commit') ?? null,
    },
    budget: { depth: opts.depth, maxNodes: opts.maxNodes },
    warnings: [refusal.message],
  });
}

/**
 * CLI entry point. The single committed exit idiom (Decision 6): set `process.exitCode`, emit the
 * `delta` usage event, and `db.close()` in `finally` — instrumentation + cleanup run on EVERY path,
 * including a gate refusal. Never `process.exit()` mid-flow.
 */
export function runDeltaCli(program: Command, opts: DeltaOptions): void {
  const runtime = resolveRuntimePaths({
    corpus: program.opts().corpus as string | undefined,
    db: program.opts().db as string | undefined,
  });
  const opened = openDeltaDatabase(runtime.dbPath);
  if ('refusal' in opened) {
    console.error(`Error: ${opened.refusal.message}`);
    if (opened.refusal.remediation) console.error(`  ${opened.refusal.remediation}`);
    process.exitCode = 1;
    return;
  }
  const db = opened.db;
  const invocationId = createInvocationId();
  const startedAt = Date.now();
  try {
    const result = computeDelta(db, runtime.corpusPath, opts);
    if ('refusal' in result) {
      console.error(`Error: ${result.refusal.message}`);
      if (result.refusal.remediation) console.error(`  ${result.refusal.remediation}`);
      emitUsageEvent(db, {
        source: 'cli',
        surface: 'delta',
        action: opts.check ? 'check' : 'analyze',
        invocationId,
        commandOutcome: 'error',
        exitCode: 1,
        corpusPath: runtime.corpusPath,
        dbPath: runtime.dbPath,
        durationMs: Date.now() - startedAt,
        error: { code: result.refusal.reason, message: result.refusal.message },
      });
      process.exitCode = 1;
      return;
    }
    const report = result.report;
    console.log(opts.json ? JSON.stringify(report, null, 2) : renderDeltaText(report));
    const exitCode = opts.check && report.gate ? report.gate.exitCode : 0;
    emitUsageEvent(db, {
      source: 'cli',
      surface: 'delta',
      action: opts.check ? 'check' : 'analyze',
      invocationId,
      commandOutcome: exitCode === 0 ? 'success' : 'error',
      exitCode,
      trustState: safeUsageTrustState(report.trust.overlay),
      corpusPath: runtime.corpusPath,
      dbPath: runtime.dbPath,
      durationMs: Date.now() - startedAt,
      attributes: {
        touchedFiles: report.touched.files,
        touchedSymbols: report.touched.symbols,
        entrySurfaces: report.downstream.entrySurfaces.length,
        truncated: report.downstream.budget.truncated,
        gateViolations: report.gate?.violations.length ?? 0,
        // Federated dimensions ride in the attributes bag only when --against is set, so a
        // non-federated delta event is byte-identical to the shipped shape (SC-9 / spec 15A).
        ...(opts.against && opts.against.length
          ? {
              federated: true,
              against: opts.against,
              crossRepoSiblings:
                report.crossRepoImpact?.siblings.filter((s) => s.attached).length ?? 0,
            }
          : {}),
      },
    });
    process.exitCode = exitCode;
  } finally {
    db.close();
  }
}
