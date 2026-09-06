import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { discoverWorkspacePackages } from '../workspaces.js';

const temporaryDirectories: string[] = [];

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'lux-workspaces-'));
  temporaryDirectories.push(root);
  return root;
}

async function write(root: string, path: string, value: unknown): Promise<void> {
  const absolute = join(root, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe('discoverWorkspacePackages', () => {
  it('discovers npm array and object workspaces with sorted dependencies and exports', async () => {
    for (const workspaces of [['packages/*'], { packages: ['packages/*'] }]) {
      const root = await fixture();
      await write(root, 'package.json', { private: true, workspaces });
      await write(root, 'packages/z/package.json', {
        name: '@scope/z',
        exports: { '.': './src/index.ts', './feature': './src/feature.ts' },
      });
      await write(root, 'packages/a/package.json', {
        name: '@scope/a',
        exports: './src/index.ts',
      });
      await write(root, 'packages/a/src/index.ts', 'export const a = 1;');
      await write(root, 'packages/z/src/index.ts', 'export const z = 1;');
      await write(root, 'packages/z/src/feature.ts', 'export const feature = 1;');

      const result = await discoverWorkspacePackages(
        root,
        [root],
        new Set(['packages/a/src/index.ts', 'packages/z/src/index.ts', 'packages/z/src/feature.ts'])
      );

      expect(result.packages).toEqual([
        {
          name: '@scope/a',
          rootPath: 'packages/a',
          manifestPath: 'packages/a/package.json',
          exports: { '.': ['packages/a/src/index.ts'] },
        },
        {
          name: '@scope/z',
          rootPath: 'packages/z',
          manifestPath: 'packages/z/package.json',
          exports: {
            '.': ['packages/z/src/index.ts'],
            './feature': ['packages/z/src/feature.ts'],
          },
        },
      ]);
      expect(result.dependencies).toEqual([
        'package.json',
        'packages/a/package.json',
        'packages/z/package.json',
      ]);
      expect(result.diagnostics).toEqual([]);
    }
  });

  it('unions pnpm packages with npm workspaces and honors pnpm exclusions', async () => {
    const root = await fixture();
    await write(root, 'package.json', { workspaces: ['npm/*'] });
    await write(root, 'pnpm-workspace.yaml', "packages:\n  - 'pnpm/*'\n  - '!pnpm/ignored'\n");
    await write(root, 'npm/a/package.json', { name: 'npm-a', exports: './index.ts' });
    await write(root, 'pnpm/b/package.json', { name: 'pnpm-b', exports: './index.ts' });
    await write(root, 'pnpm/ignored/package.json', { name: 'ignored', exports: './index.ts' });
    await write(root, 'npm/a/index.ts', '');
    await write(root, 'pnpm/b/index.ts', '');
    await write(root, 'pnpm/ignored/index.ts', '');

    const result = await discoverWorkspacePackages(
      root,
      [root],
      new Set(['npm/a/index.ts', 'pnpm/b/index.ts', 'pnpm/ignored/index.ts'])
    );

    expect(result.packages.map(({ name }) => name)).toEqual(['npm-a', 'pnpm-b']);
    expect(result.dependencies).toEqual([
      'npm/a/package.json',
      'package.json',
      'pnpm-workspace.yaml',
      'pnpm/b/package.json',
    ]);
  });

  it('removes duplicate names and emits one deterministic ambiguity diagnostic', async () => {
    const root = await fixture();
    await write(root, 'package.json', { workspaces: ['packages/*'] });
    await write(root, 'packages/b/package.json', { name: 'duplicate' });
    await write(root, 'packages/a/package.json', { name: 'duplicate' });

    const result = await discoverWorkspacePackages(root, [root], new Set());

    expect(result.packages).toEqual([]);
    expect(result.diagnostics).toEqual([
      {
        code: 'workspace-package-ambiguous',
        message:
          'Workspace package "duplicate" is declared by packages/a/package.json, packages/b/package.json',
      },
    ]);
  });

  it('rejects traversal and absolute workspace patterns before glob expansion', async () => {
    const root = await fixture();
    await write(root, 'package.json', {
      workspaces: ['../outside/*', '/absolute/*', 'safe/*'],
    });
    await write(root, 'safe/a/package.json', { name: 'safe' });

    const result = await discoverWorkspacePackages(root, [root], new Set());

    expect(result.packages.map(({ name }) => name)).toEqual(['safe']);
    expect(
      result.diagnostics.filter(({ code }) => code === 'workspace-pattern-invalid')
    ).toHaveLength(2);
  });

  it('rejects a workspace package manifest reached through an escaping symlink', async () => {
    const root = await fixture();
    const outside = await fixture();
    await write(root, 'package.json', { workspaces: ['packages/*'] });
    await write(outside, 'evil/package.json', { name: 'evil' });
    await mkdir(join(root, 'packages'), { recursive: true });
    await symlink(join(outside, 'evil'), join(root, 'packages', 'evil'));

    const result = await discoverWorkspacePackages(root, [root], new Set());

    expect(result.packages).toEqual([]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'workspace-manifest-outside-root' })
    );
    expect(result.dependencies).toEqual(['package.json']);
  });

  it('rejects malformed and custom-tagged pnpm manifests without executing them', async () => {
    const root = await fixture();
    await write(root, 'package.json', {});
    await write(root, 'pnpm-workspace.yaml', 'packages: !include ./dynamic.yaml\n');

    const result = await discoverWorkspacePackages(root, [root], new Set());

    expect(result.packages).toEqual([]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'workspace-manifest-invalid' })
    );
    expect(result.dependencies).toEqual(['package.json', 'pnpm-workspace.yaml']);
  });

  it('refuses discovery when the repository root is outside allowed roots', async () => {
    const root = await fixture();
    const allowed = await fixture();
    await write(root, 'package.json', { workspaces: ['packages/*'] });

    const result = await discoverWorkspacePackages(root, [allowed], new Set());

    expect(result).toEqual({
      packages: [],
      diagnostics: [
        {
          code: 'workspace-root-not-allowed',
          message: 'Repository root is not within an allowed root',
        },
      ],
      dependencies: [],
    });
  });
});
