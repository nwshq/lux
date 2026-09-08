import { describe, expect, it } from 'vitest';
import type { ModuleExportIndexV1 } from '../../../contracts/program.js';
import { canonicalExpoRoute, discoverExpoRoutes } from '../file-routes.js';
import { extractExpoDestinations } from '../navigation.js';

describe('Expo Router static graph', () => {
  it('normalizes groups, index, params, catches and layouts', () => {
    expect(canonicalExpoRoute('app', 'app/(auth)/events/[id]/index.tsx')).toMatchObject({
      canonicalPath: '/events/[id]',
      groups: ['(auth)'],
      params: [{ name: 'id', rest: false, optional: false }],
      kind: 'route',
    });
    expect(canonicalExpoRoute('app', 'app/docs/[[...slug]].tsx').params).toEqual([
      { name: 'slug', rest: true, optional: true },
    ]);
    expect(canonicalExpoRoute('app', 'app/(auth)/_layout.tsx').kind).toBe('layout');
  });
  it('rejects duplicate grouped public routes', () => {
    const exportsByFile = new Map(
      ['app/(a)/settings.tsx', 'app/(b)/settings.tsx'].map((file) => [
        file,
        { default: { localName: 'Page', filePath: file }, named: {}, reexports: [] },
      ])
    ) as Map<string, ModuleExportIndexV1>;
    const result = discoverExpoRoutes({
      rootPath: '/repo',
      appRoots: ['app'],
      files: [...exportsByFile.keys()],
      project: {
        rootPath: '/repo',
        sourceFiles: new Set(exportsByFile.keys()),
        aliases: [],
        workspacePackages: [],
        exportsByFile,
        fingerprintInputs: [],
      },
    });
    expect(result.routes).toEqual([]);
    expect(result.diagnostics[0].code).toBe('EXPO_ROUTE_AMBIGUOUS');
  });
  it('resolves literal and complete-segment templates but refuses computed/external', () => {
    const routes = [
      canonicalExpoRoute('app', 'app/settings/about.tsx'),
      canonicalExpoRoute('app', 'app/catalog/[id].tsx'),
    ];
    const result = extractExpoDestinations(
      'app/index.tsx',
      `<Link href="/settings/about"/>; router.push(\`/catalog/${'${id}'}\`); router.push(makePath()); <Link href="https://example.com"/>`,
      routes
    );
    expect(result.destinations.map((x) => x.pathname)).toEqual([
      '/settings/about',
      '/catalog/[id]',
    ]);
    expect(result.diagnostics).toHaveLength(2);
  });
});
