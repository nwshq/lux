import { Command } from 'commander';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { LintEngine, formatResults } from '../lint/index.js';

export function addLintCommand(program: Command): void {
  program
    .command('lint [path]')
    .description('Validate content directory against naming and structural conventions')
    .option('--severity <level>', 'Filter by minimum severity (error, warning, info)')
    .option('--rule <name>', 'Run only the specified rule')
    .option('--format <type>', 'Output format: text (default) or json', 'text')
    .option('--quiet', 'Only show errors')
    .action(
      async (
        targetPath: string | undefined,
        options: {
          severity?: string;
          rule?: string;
          format?: string;
          quiet?: boolean;
        }
      ) => {
        const opts = program.opts();
        const corpusPath = opts.corpus as string;

        if (!existsSync(corpusPath)) {
          console.error(`Error: Content directory not found: ${corpusPath}`);
          console.error('  Please ensure the directory exists or set --corpus <path>');
          process.exit(2);
        }

        const scanPath = targetPath ? resolve(targetPath) : undefined;
        if (scanPath && !existsSync(scanPath)) {
          console.error(`Error: Target path not found: ${scanPath}`);
          process.exit(2);
        }

        const engine = new LintEngine();
        const results = await engine.lint(corpusPath, scanPath);

        // Filter by severity
        let filtered = results;
        if (options.severity) {
          const severityOrder = { error: 0, warning: 1, info: 2 };
          const minLevel = severityOrder[options.severity as keyof typeof severityOrder];
          if (minLevel === undefined) {
            console.error(`Error: Invalid severity level: ${options.severity}`);
            process.exit(2);
          }
          filtered = results.filter((r) => severityOrder[r.severity] <= minLevel);
        }

        if (options.quiet) {
          filtered = filtered.filter((r) => r.severity === 'error');
        }

        // Filter by rule
        if (options.rule) {
          filtered = filtered.filter((r) => r.rule === options.rule);
        }

        if (options.format === 'json') {
          const errors = filtered.filter((r) => r.severity === 'error').length;
          const warnings = filtered.filter((r) => r.severity === 'warning').length;
          const info = filtered.filter((r) => r.severity === 'info').length;
          console.log(
            JSON.stringify(
              {
                results: filtered,
                summary: { errors, warnings, info },
              },
              null,
              2
            )
          );
        } else {
          console.log(formatResults(filtered, corpusPath));
        }

        const hasErrors = filtered.some((r) => r.severity === 'error');
        process.exit(hasErrors ? 1 : 0);
      }
    );
}
