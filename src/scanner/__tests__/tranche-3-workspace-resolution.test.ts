import { describe, expect, it } from 'vitest';
import { resolveProjectModule } from '../project-resolution/resolver.js';
describe('Tranche3 workspace gate', () => {
  it('preserves example-workspace package resolution without name collapse', () => {
    const p: any = {
      rootPath: '/r',
      sourceFiles: new Set(['packages/ui/src/a.ts']),
      aliases: [],
      workspacePackages: [
        {
          name: '@example-workspace/ui',
          rootPath: 'packages/ui',
          manifestPath: 'packages/ui/package.json',
          exports: { '.': ['packages/ui/src/a.ts'] },
        },
      ],
      exportsByFile: new Map(),
      fingerprintInputs: ['pnpm-workspace.yaml'],
    };
    expect(
      resolveProjectModule(
        { importerFile: 'apps/desktop/src/a.ts', specifier: '@example-workspace/ui', mode: 'import' },
        p
      )
    ).toMatchObject({ status: 'resolved', targetFile: 'packages/ui/src/a.ts' });
  });
});
