import type { Command } from 'commander';
import { openIndex, type IndexOpenRefusal } from '../../db/open-policy.js';
import { withReadTelemetry } from '../read-index.js';
import { buildIndexStatusPayload, type IndexStatusPayload } from '../status-payload.js';
import { resolveRuntimePaths, type RuntimePathResolution } from '../../utils/runtime-paths.js';
import type { LuxDatabase } from '../../db/index.js';
import { runDoctorChecks, type DoctorCheckV1 } from './checks.js';

export type { DoctorCheckContext, DoctorCheckId, DoctorCheckV1 } from './checks.js';

/** Existing Phase-3 payload seam, retained exactly for status consumers. */
export function buildDoctorPayload(
  db: LuxDatabase,
  runtime: RuntimePathResolution
): IndexStatusPayload {
  return buildIndexStatusPayload(db, runtime);
}

export type DoctorReportStatus = 'pass' | 'warn' | 'fail';

export interface DoctorReportV1 {
  schemaVersion: 1;
  status: IndexStatusPayload | null;
  checks: DoctorCheckV1[];
  result: DoctorReportStatus;
}

function summarizeChecks(checks: readonly DoctorCheckV1[]): DoctorReportStatus {
  if (checks.some((check) => check.status === 'fail')) return 'fail';
  if (checks.some((check) => check.status === 'warn')) return 'warn';
  return 'pass';
}

/**
 * Build the versioned Phase-4 report. A refused index open is diagnostic input, not an early error:
 * every stable check still runs, and the function never creates, migrates, installs, or writes.
 */
export function inspectDoctorReport(runtime: RuntimePathResolution): DoctorReportV1 {
  const opened = openIndex(runtime.dbPath, 'read-existing');
  if (!opened.ok) return buildDoctorReport(undefined, runtime, opened.refusal);

  try {
    return buildDoctorReport(opened.db, runtime);
  } finally {
    opened.db.close();
  }
}

/** Shared Phase-4 report builder for already-open read-only CLI/MCP leases. */
export function buildDoctorReport(
  db: LuxDatabase | undefined,
  runtime: RuntimePathResolution,
  indexRefusal?: IndexOpenRefusal
): DoctorReportV1 {
  const status = db ? buildDoctorPayload(db, runtime) : null;
  const checks = runDoctorChecks({
    corpusRoot: runtime.corpusPath,
    dbPath: runtime.dbPath,
    ...(db ? { db, payload: status! } : {}),
    ...(indexRefusal ? { indexRefusal } : {}),
  });
  return {
    schemaVersion: 1,
    status,
    checks,
    result: summarizeChecks(checks),
  };
}

function renderDoctorReport(report: DoctorReportV1, runtime: RuntimePathResolution): string {
  const lines = [
    'Lux doctor',
    `  Result: ${report.result}`,
    `  Corpus: ${runtime.corpusPath}`,
    `  Database: ${runtime.dbPath}`,
    '  Checks:',
  ];
  for (const check of report.checks) {
    lines.push(`    [${check.status}] ${check.id}: ${check.message}`);
    if (check.remediation) lines.push(`      Remediation: ${check.remediation}`);
  }
  return lines.join('\n');
}

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('Report read-only index, configuration, and capability diagnostics')
    .option('--json', 'Emit the versioned Phase-4 report')
    .action((options: { json?: boolean }) => {
      const root = program.opts<{ corpus?: string; db?: string }>();
      const runtime = resolveRuntimePaths({ corpus: root.corpus, db: root.db });
      const report = inspectDoctorReport(runtime);
      console.log(
        options.json
          ? JSON.stringify(withReadTelemetry(report), null, 2)
          : renderDoctorReport(report, runtime)
      );
      if (report.result === 'fail') process.exitCode = 1;
    });
}
