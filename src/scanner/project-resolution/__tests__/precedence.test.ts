import { describe, expect, it } from 'vitest';
import type { AliasRuleV1, ProjectResolutionContextV1 } from '../../contracts/program.js';
import { resolveProjectModule } from '../resolver.js';

function context(aliases: AliasRuleV1[]): ProjectResolutionContextV1 {
  return {
    rootPath: '/repo',
    sourceFiles: new Set([
      'src/root.ts',
      'src/value.ts',
      'packages/app/src/local.ts',
      'packages/app/src/value.ts',
    ]),
    aliases,
    workspacePackages: [],
    exportsByFile: new Map(),
    fingerprintInputs: aliases.map((rule) => rule.configFile),
  };
}

describe('Phase 8 project resolver precedence', () => {
  it('selects the nearest governing tsconfig for a nested importer', () => {
    const result = resolveProjectModule(
      {
        importerFile: 'packages/app/src/caller.ts',
        specifier: '@app/value',
        mode: 'import',
      },
      context([
        {
          pattern: '@app/*',
          targets: ['src/*'],
          source: 'tsconfig',
          configFile: 'tsconfig.json',
          precedence: 0,
        },
        {
          pattern: '@app/*',
          targets: ['packages/app/src/*'],
          source: 'tsconfig',
          configFile: 'packages/app/tsconfig.json',
          precedence: 0,
        },
      ])
    );
    expect(result).toEqual({
      status: 'resolved',
      targetFile: 'packages/app/src/value.ts',
      via: 'tsconfig',
      evidenceFile: 'packages/app/tsconfig.json',
    });
  });

  it('uses tsconfig before a matching Vite alias at the same source path', () => {
    expect(
      resolveProjectModule(
        { importerFile: 'src/caller.ts', specifier: '@app/value', mode: 'import' },
        context([
          {
            pattern: '@app/*',
            targets: ['src/*'],
            source: 'tsconfig',
            configFile: 'tsconfig.json',
            precedence: 0,
          },
          {
            pattern: '@app',
            targets: ['packages/app/src'],
            source: 'vite',
            configFile: 'vite.config.ts',
            precedence: 0,
          },
        ])
      )
    ).toMatchObject({ status: 'resolved', via: 'tsconfig', evidenceFile: 'tsconfig.json' });
  });
});
