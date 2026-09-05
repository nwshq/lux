import type { Command } from 'commander';
import { openCliReadIndex, withReadTelemetry } from './read-index.js';
import { buildIndexStatusPayload, type IndexStatusPayload } from './status-payload.js';
import { resolveRuntimePaths, type RuntimePathResolution } from '../utils/runtime-paths.js';
import type { LuxDatabase } from '../db/index.js';

/** Shared doctor payload seam used by CLI and MCP. */
export function buildDoctorPayload(
  db: LuxDatabase,
  runtime: RuntimePathResolution
): IndexStatusPayload {
  return buildIndexStatusPayload(db, runtime);
}

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('Report index, trust, freshness, and language coverage diagnostics')
    .option('--json', 'Emit machine-readable JSON')
    .action((options: { json?: boolean }) => {
      const root = program.opts();
      const runtime = resolveRuntimePaths({
        corpus: root.corpus as string | undefined,
        db: root.db as string | undefined,
      });
      const db = openCliReadIndex(runtime.dbPath, options.json === true);
      if (!db) return;
      try {
        const payload = buildDoctorPayload(db, runtime);
        if (options.json) {
          console.log(JSON.stringify(withReadTelemetry(payload), null, 2));
          return;
        }
        console.log('Lux doctor');
        console.log(`  Corpus: ${runtime.corpusPath}`);
        console.log(`  Database: ${runtime.dbPath}`);
        for (const language of payload.coverage.languages) {
          console.log(
            `  ${language.languageId}: ${language.files} file(s), ` +
              `${language.symbolizedFiles} symbolized, ${language.symbols} symbol(s), ` +
              `${language.relatedSymbols} related`
          );
          for (const [name, capability] of Object.entries(language.capabilities)) {
            console.log(
              `    ${name}: ${capability.state} (${capability.nodes} node(s), ` +
                `${capability.edges} edge(s))`
            );
            if (capability.reason) console.log(`      ${capability.reason}`);
          }
        }
      } finally {
        db.close();
      }
    });
}
