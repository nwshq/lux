import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { rm } from 'node:fs/promises';

import {
  canonicalizeConfigRoots,
  discoverNearestProjectConfig,
  discoverProjectConfigs,
  parseJsoncConfig,
} from '../config-discovery.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'lux-config-discovery-'));
  roots.push(root);
  await mkdir(join(root, 'src', 'nested'), { recursive: true });
  await writeFile(join(root, 'src', 'nested', 'caller.ts'), 'export {};');
  return root;
}

describe('project config discovery', () => {
  it('selects the nearest config for an importer and retains its confined extends chain', async () => {
    const root = await project();
    await writeFile(join(root, 'base.json'), '{ "compilerOptions": {} }');
    await writeFile(join(root, 'tsconfig.json'), '{ "extends": "./base", } // JSONC');
    await mkdir(join(root, 'src', 'nested', 'deep'));
    await writeFile(join(root, 'src', 'nested', 'deep', 'caller.ts'), '');
    await writeFile(join(root, 'src', 'tsconfig.json'), '{}');

    const result = await discoverProjectConfigs(root, [root], ['src/nested/deep/caller.ts']);
    expect(result.tsconfigFiles).toEqual([join(root, 'src', 'tsconfig.json')]);
    expect(result.dependencies).toEqual([join(root, 'src', 'tsconfig.json')]);
    expect(result.diagnostics).toEqual([]);

    const all = await discoverProjectConfigs(root, [root]);
    expect(all.dependencies).toEqual(
      expect.arrayContaining([
        join(root, 'base.json'),
        join(root, 'src', 'tsconfig.json'),
        join(root, 'tsconfig.json'),
      ])
    );
  });

  it('refuses equal-distance tsconfig/jsconfig instead of choosing by filename', async () => {
    const root = await project();
    await writeFile(join(root, 'src', 'tsconfig.json'), '{}');
    await writeFile(join(root, 'src', 'jsconfig.json'), '{}');
    const confined = await canonicalizeConfigRoots(root, [root]);
    expect(confined).toBeDefined();
    const result = await discoverNearestProjectConfig('src/nested/caller.ts', confined!);
    expect(result.configFile).toBeUndefined();
    expect(result.diagnostics.map((item) => item.code)).toEqual(['config-nearest-ambiguous']);
  });

  it('reports exact JSONC parse offsets and line/column', () => {
    const source = '{\n  "compilerOptions": {\n    "baseUrl": ,\n  },\n}';
    const result = parseJsoncConfig('/repo/tsconfig.json', source);
    const offset = source.indexOf(',\n  },');
    expect(result.diagnostics[0]).toMatchObject({
      code: 'config-jsonc-parse',
      message: expect.stringContaining(`offset ${offset}`),
      location: { filePath: '/repo/tsconfig.json', line: 3, column: 15 },
    });
  });

  it.each(['typescript-config', '@scope/config', '/outside.json', '../outside.json'])(
    'never opens external or escaping extends %j',
    async (specifier) => {
      const root = await project();
      await writeFile(join(root, 'tsconfig.json'), JSON.stringify({ extends: specifier }));
      const result = await discoverProjectConfigs(root, [root]);
      expect(result.dependencies).toEqual([join(root, 'tsconfig.json')]);
      expect(result.diagnostics.map((item) => item.code)).toContain('config-extends-external');
    }
  );

  it('terminates an extends cycle with deterministic dependencies', async () => {
    const root = await project();
    await writeFile(join(root, 'tsconfig.json'), '{"extends":"./base.json"}');
    await writeFile(join(root, 'base.json'), '{"extends":"./tsconfig.json"}');
    const result = await discoverProjectConfigs(root, [root]);
    expect(result.dependencies).toEqual([join(root, 'base.json'), join(root, 'tsconfig.json')]);
    expect(result.diagnostics.map((item) => item.code)).toContain('config-extends-cycle');
  });

  it('refuses symlinked configs, including a link to a file inside the root', async () => {
    const root = await project();
    await writeFile(join(root, 'real.json'), '{}');
    await symlink(join(root, 'real.json'), join(root, 'tsconfig.json'));
    const result = await discoverProjectConfigs(root, [root]);
    expect(result.tsconfigFiles).toEqual([]);
    expect(result.dependencies).toEqual([]);
    expect(result.diagnostics.map((item) => item.code)).toContain('config-symlink-refused');
  });

  it('refuses an outside allowed root and unsafe importer before traversal', async () => {
    const root = await project();
    const outside = await project();
    const result = await discoverProjectConfigs(root, [outside]);
    expect(result.diagnostics.map((item) => item.code)).toEqual(['config-root-invalid']);

    const confined = await canonicalizeConfigRoots(root, [root]);
    const nearest = await discoverNearestProjectConfig('../outside/caller.ts', confined!);
    expect(nearest.diagnostics.map((item) => item.code)).toEqual(['config-path-escape']);
  });

  it('discovers supported Vite config suffixes but skips node_modules and .git', async () => {
    const root = await project();
    await writeFile(join(root, 'vite.config.js'), 'export default {}');
    await writeFile(join(root, 'vite.config.mts'), 'export default {}');
    await mkdir(join(root, 'node_modules'));
    await writeFile(join(root, 'node_modules', 'vite.config.js'), 'throw new Error()');
    const result = await discoverProjectConfigs(root, [root]);
    expect(result.viteFiles).toEqual([join(root, 'vite.config.js'), join(root, 'vite.config.mts')]);
    expect(result.dependencies).toEqual(result.viteFiles);
  });
});
