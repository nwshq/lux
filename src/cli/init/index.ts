import type { Command } from 'commander';
import { resolve } from 'node:path';
import { applyInitPlan, buildInitPlan, type InitPlanV1 } from './plan.js';
import { renderInitPlan } from './render.js';

export type { AtomicWriteOptions, InitChangeV1, InitPlanV1 } from './plan.js';
export {
  applyInitPlan,
  buildInitPlan,
  renderPortableLuxYaml,
  writeAtomicallyInsideRoot,
} from './plan.js';
export { renderInitPlan } from './render.js';

export interface RunInitOptions {
  corpusRoot?: string;
  yes?: boolean;
  json?: boolean;
}

/** Public JSON plans contain portable relative targets, never an absolute checkout path. */
export type PortableInitPlanV1 = Omit<InitPlanV1, 'corpusRoot'> & { corpusRoot: '.' };

function portableInitPlan(plan: InitPlanV1): PortableInitPlanV1 {
  return { ...plan, corpusRoot: '.' };
}

/**
 * CLI-independent execution seam. It always returns the previewed plan; only `yes: true`
 * applies it, making noninteractive/default invocation safe.
 */
export function runInit(options: RunInitOptions = {}): InitPlanV1 {
  const plan = buildInitPlan(resolve(options.corpusRoot ?? process.cwd()));
  applyInitPlan(plan, options.yes === true);
  return plan;
}

/** Registration is exported for the central integration task; this leaf does not edit cli/index.ts. */
export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('Preview portable Lux configuration for a corpus')
    .option('--yes', 'Apply the previewed changes')
    .option('--json', 'Emit the versioned plan as JSON')
    .action((options: { yes?: boolean; json?: boolean }) => {
      const rootOptions = program.opts<{ corpus?: string }>();
      const plan = runInit({
        corpusRoot: rootOptions.corpus,
        yes: options.yes === true,
        json: options.json === true,
      });
      console.log(
        options.json ? JSON.stringify(portableInitPlan(plan), null, 2) : renderInitPlan(plan)
      );
    });
}
