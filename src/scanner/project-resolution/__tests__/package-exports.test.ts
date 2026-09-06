import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { WorkspacePackageV1 } from '../../contracts/program.js';
import { parsePackageExports, resolvePackageExport } from '../package-exports.js';

const temporaryDirectories: string[] = [];

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'lux-package-exports-'));
  temporaryDirectories.push(root);
  return root;
}

async function write(root: string, path: string, value = ''): Promise<void> {
  const absolute = join(root, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, value);
}

function workspace(exports: Record<string, string[]>): WorkspacePackageV1 {
  return {
    name: '@scope/pkg',
    rootPath: 'packages/pkg',
    manifestPath: 'packages/pkg/package.json',
    exports,
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe('parsePackageExports', () => {
  it('remaps emitted declaration exports to TypeScript sources', async () => {
    const root = await fixture();
    await write(root, 'packages/pkg/src/index.ts');
    await write(
      root,
      'packages/pkg/tsconfig.json',
      JSON.stringify({ compilerOptions: { rootDir: './src', outDir: './dist' } })
    );
    const result = await parsePackageExports({
      value: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
      packageRoot: join(root, 'packages/pkg'),
      manifestPath: 'packages/pkg/package.json',
      repositoryRoot: root,
      sourceFiles: new Set(['packages/pkg/src/index.ts']),
    });
    expect(result.exports).toEqual({ '.': ['packages/pkg/src/index.ts'] });
  });

  it('normalizes root, exact subpath, and one-star subpath exports', async () => {
    const root = await fixture();
    await write(root, 'packages/pkg/src/index.ts');
    await write(root, 'packages/pkg/src/feature.ts');
    await write(root, 'packages/pkg/src/features/button.ts');

    const result = await parsePackageExports({
      value: {
        '.': './src/index.ts',
        './feature': './src/feature.ts',
        './features/*': './src/features/*.ts',
      },
      packageRoot: join(root, 'packages/pkg'),
      manifestPath: 'packages/pkg/package.json',
      repositoryRoot: root,
      sourceFiles: new Set([
        'packages/pkg/src/index.ts',
        'packages/pkg/src/feature.ts',
        'packages/pkg/src/features/button.ts',
      ]),
    });

    expect(result).toEqual({
      exports: {
        '.': ['packages/pkg/src/index.ts'],
        './feature': ['packages/pkg/src/feature.ts'],
        './features/*': ['packages/pkg/src/features/*.ts'],
      },
      diagnostics: [],
      dependencies: [],
    });
  });

  it('uses condition priority rather than object declaration order', async () => {
    const root = await fixture();
    for (const file of ['types.ts', 'import.ts', 'default.ts', 'require.ts']) {
      await write(root, `packages/pkg/src/${file}`);
    }
    const sourceFiles = new Set(
      ['types.ts', 'import.ts', 'default.ts', 'require.ts'].map(
        (file) => `packages/pkg/src/${file}`
      )
    );
    const packageRoot = join(root, 'packages/pkg');

    const first = await parsePackageExports({
      value: {
        '.': {
          require: './src/require.ts',
          default: './src/default.ts',
          import: './src/import.ts',
          types: './src/types.ts',
        },
      },
      packageRoot,
      manifestPath: 'packages/pkg/package.json',
      repositoryRoot: root,
      sourceFiles,
    });
    const second = await parsePackageExports({
      value: {
        '.': {
          types: './src/types.ts',
          import: './src/import.ts',
          default: './src/default.ts',
          require: './src/require.ts',
        },
      },
      packageRoot,
      manifestPath: 'packages/pkg/package.json',
      repositoryRoot: root,
      sourceFiles,
    });

    expect(first.exports).toEqual({ '.': ['packages/pkg/src/types.ts'] });
    expect(second.exports).toEqual(first.exports);
  });

  it('collects array targets and leaves ambiguity to resolution', async () => {
    const root = await fixture();
    await write(root, 'packages/pkg/src/a.ts');
    await write(root, 'packages/pkg/src/b.ts');

    const result = await parsePackageExports({
      value: ['./src/b.ts', './src/a.ts'],
      packageRoot: join(root, 'packages/pkg'),
      manifestPath: 'packages/pkg/package.json',
      repositoryRoot: root,
      sourceFiles: new Set(['packages/pkg/src/a.ts', 'packages/pkg/src/b.ts']),
    });

    expect(result.exports).toEqual({
      '.': ['packages/pkg/src/a.ts', 'packages/pkg/src/b.ts'],
    });
    expect(
      resolvePackageExport(
        '@scope/pkg',
        [workspace(result.exports)],
        new Set(['packages/pkg/src/a.ts', 'packages/pkg/src/b.ts'])
      )
    ).toEqual({
      status: 'ambiguous',
      candidates: ['packages/pkg/src/a.ts', 'packages/pkg/src/b.ts'],
      governingConfigs: ['packages/pkg/package.json'],
    });
  });

  it.each([
    [{ '.': { browser: './src/index.ts' } }, 'Unsupported export condition'],
    [{ './*/*': './src/*/*.ts' }, 'Unsupported export key'],
    [{ './nested/../feature': './src/feature.ts' }, 'Unsupported export key'],
    [{ './feature': '../outside.ts' }, 'Unsupported export target'],
    [{ './feature': './src/../secret.ts' }, 'Unsupported export target'],
    [{ './feature': '/absolute.ts' }, 'Unsupported export target'],
    [{ './feature': './src/*.ts' }, 'Unsupported export target'],
    [{ '.': null }, 'Export target must be a string'],
    [{ '.': {} }, 'Export target must be a string'],
  ])('rejects custom, dynamic, traversal, and malformed mapping %#', async (value, message) => {
    const root = await fixture();
    await write(root, 'packages/pkg/src/index.ts');

    const result = await parsePackageExports({
      value,
      packageRoot: join(root, 'packages/pkg'),
      manifestPath: 'packages/pkg/package.json',
      repositoryRoot: root,
      sourceFiles: new Set(['packages/pkg/src/index.ts']),
    });

    expect(result.exports).toEqual({});
    expect(result.diagnostics[0].message).toContain(message);
  });

  it('remaps outDir to rootDir using root-confined package JSONC only', async () => {
    const root = await fixture();
    await write(
      root,
      'packages/pkg/tsconfig.json',
      '{ // package build\n "compilerOptions": { "rootDir": "src", "outDir": "dist", },\n}'
    );
    await write(root, 'packages/pkg/src/index.ts');
    await write(root, 'packages/pkg/src/feature.tsx');

    const result = await parsePackageExports({
      value: { '.': './dist/index.js', './feature': './dist/feature.js' },
      packageRoot: join(root, 'packages/pkg'),
      manifestPath: 'packages/pkg/package.json',
      repositoryRoot: root,
      sourceFiles: new Set(['packages/pkg/src/index.ts', 'packages/pkg/src/feature.tsx']),
    });

    expect(result.exports).toEqual({
      '.': ['packages/pkg/src/index.ts'],
      './feature': ['packages/pkg/src/feature.tsx'],
    });
    expect(result.dependencies).toEqual(['packages/pkg/tsconfig.json']);
  });

  it('supports jsconfig remap and reports extension ambiguity exactly', async () => {
    const root = await fixture();
    await write(
      root,
      'packages/pkg/jsconfig.json',
      JSON.stringify({ compilerOptions: { rootDir: 'source', outDir: 'build' } })
    );
    await write(root, 'packages/pkg/source/value.ts');
    await write(root, 'packages/pkg/source/value.tsx');

    const result = await parsePackageExports({
      value: './build/value.js',
      packageRoot: join(root, 'packages/pkg'),
      manifestPath: 'packages/pkg/package.json',
      repositoryRoot: root,
      sourceFiles: new Set(['packages/pkg/source/value.ts', 'packages/pkg/source/value.tsx']),
    });

    expect(result.exports).toEqual({
      '.': ['packages/pkg/source/value.ts', 'packages/pkg/source/value.tsx'],
    });
    expect(result.dependencies).toEqual(['packages/pkg/jsconfig.json']);
  });

  it('rejects an escaping symlink package config before reading it', async () => {
    const root = await fixture();
    const outside = await fixture();
    await write(
      outside,
      'tsconfig.json',
      JSON.stringify({ compilerOptions: { rootDir: 'src', outDir: 'dist' } })
    );
    await mkdir(join(root, 'packages/pkg'), { recursive: true });
    await symlink(join(outside, 'tsconfig.json'), join(root, 'packages/pkg/tsconfig.json'));

    const result = await parsePackageExports({
      value: './dist/index.js',
      packageRoot: join(root, 'packages/pkg'),
      manifestPath: 'packages/pkg/package.json',
      repositoryRoot: root,
      sourceFiles: new Set(['packages/pkg/src/index.ts']),
    });

    expect(result.exports).toEqual({});
    expect(result.dependencies).toEqual([]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'package-config-outside-root' })
    );
  });

  it('does not use basename or similarity fallback during remap', async () => {
    const root = await fixture();
    await write(
      root,
      'packages/pkg/tsconfig.json',
      JSON.stringify({ compilerOptions: { rootDir: 'src', outDir: 'dist' } })
    );
    await write(root, 'packages/pkg/src/nested/index.ts');
    await write(root, 'packages/pkg/src/entry-similar.ts');

    const result = await parsePackageExports({
      value: './dist/entry.js',
      packageRoot: join(root, 'packages/pkg'),
      manifestPath: 'packages/pkg/package.json',
      repositoryRoot: root,
      sourceFiles: new Set([
        'packages/pkg/src/nested/index.ts',
        'packages/pkg/src/entry-similar.ts',
      ]),
    });

    expect(result.exports).toEqual({});
  });

  it('rejects exact targets that escape through a symlink', async () => {
    const root = await fixture();
    const outside = await fixture();
    await write(outside, 'secret.ts');
    await mkdir(join(root, 'packages/pkg'), { recursive: true });
    await symlink(outside, join(root, 'packages/pkg/linked'));

    const result = await parsePackageExports({
      value: './linked/secret.ts',
      packageRoot: join(root, 'packages/pkg'),
      manifestPath: 'packages/pkg/package.json',
      repositoryRoot: root,
      sourceFiles: new Set(['packages/pkg/linked/secret.ts']),
    });

    expect(result.exports).toEqual({});
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'package-exports-invalid',
        message: expect.stringContaining('symlink'),
      })
    );
  });
});

describe('resolvePackageExport', () => {
  const files = new Set([
    'packages/pkg/src/index.ts',
    'packages/pkg/src/feature.ts',
    'packages/pkg/src/features/button.ts',
    'packages/pkg/src/features/nested/button.ts',
  ]);
  const pkg = workspace({
    '.': ['packages/pkg/src/index.ts'],
    './feature': ['packages/pkg/src/feature.ts'],
    './features/*': ['packages/pkg/src/features/*.ts'],
  });

  it('resolves package root, exact subpath, and one-star subpath', () => {
    expect(resolvePackageExport('@scope/pkg', [pkg], files)).toEqual({
      status: 'resolved',
      targetFile: 'packages/pkg/src/index.ts',
      via: 'workspace',
      evidenceFile: 'packages/pkg/package.json',
    });
    expect(resolvePackageExport('@scope/pkg/feature', [pkg], files)).toEqual({
      status: 'resolved',
      targetFile: 'packages/pkg/src/feature.ts',
      via: 'package-exports',
      evidenceFile: 'packages/pkg/package.json',
    });
    expect(resolvePackageExport('@scope/pkg/features/button', [pkg], files)).toEqual({
      status: 'resolved',
      targetFile: 'packages/pkg/src/features/button.ts',
      via: 'package-exports',
      evidenceFile: 'packages/pkg/package.json',
    });
  });

  it('supports nested wildcard captures but rejects traversal and missing subpaths', () => {
    expect(resolvePackageExport('@scope/pkg/features/nested/button', [pkg], files)).toEqual({
      status: 'resolved',
      targetFile: 'packages/pkg/src/features/nested/button.ts',
      via: 'package-exports',
      evidenceFile: 'packages/pkg/package.json',
    });
    expect(resolvePackageExport('@scope/pkg/features/../index', [pkg], files)).toEqual({
      status: 'missing',
      specifier: '@scope/pkg/features/../index',
    });
    expect(resolvePackageExport('@scope/pkg/unknown', [pkg], files)).toEqual({
      status: 'missing',
      specifier: '@scope/pkg/unknown',
    });
  });

  it('reports equally specific overlapping wildcard keys as ambiguous', () => {
    const overlapping = workspace({
      './a*': ['packages/pkg/src/a*.ts'],
      './*b': ['packages/pkg/src/*b.ts'],
    });
    const overlappingFiles = new Set(['packages/pkg/src/ab.ts']);

    expect(resolvePackageExport('@scope/pkg/ab', [overlapping], overlappingFiles)).toEqual({
      status: 'ambiguous',
      candidates: ['packages/pkg/src/ab.ts'],
      governingConfigs: ['packages/pkg/package.json'],
    });
  });

  it('reports duplicate package candidates as ambiguity without guessing', () => {
    const duplicate = { ...pkg, manifestPath: 'other/pkg/package.json' };
    expect(resolvePackageExport('@scope/pkg', [duplicate, pkg], files)).toEqual({
      status: 'ambiguous',
      candidates: [],
      governingConfigs: ['other/pkg/package.json', 'packages/pkg/package.json'],
    });
  });

  it('returns undefined for a non-workspace package so external fallback can run', () => {
    expect(resolvePackageExport('third-party', [pkg], files)).toBeUndefined();
  });
});
