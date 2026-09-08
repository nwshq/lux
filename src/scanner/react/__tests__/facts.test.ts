import { describe, expect, it } from 'vitest';
import { extractSource, getGrammars, type Extraction } from '../../ast/extract.js';
import { buildModuleExportIndexes } from '../../project-resolution/export-index.js';
import { ReactFactExtractor } from '../facts.js';
import type { ReactAnalysisInputV1 } from '../types.js';

async function input(files: Record<string, string>): Promise<ReactAnalysisInputV1> {
  const grammars = await getGrammars();
  const extractions = new Map<string, Extraction>();
  for (const [filePath, source] of Object.entries(files)) {
    const lang = filePath.endsWith('.tsx')
      ? 'tsx'
      : filePath.endsWith('.jsx')
        ? 'jsx'
        : 'typescript';
    extractions.set(filePath, extractSource(grammars, source, filePath, lang).extraction);
  }
  return {
    rootPath: '/repo',
    files: Object.keys(files),
    sources: new Map(Object.entries(files)),
    extractions,
    project: {
      rootPath: '/repo',
      sourceFiles: new Set(Object.keys(files)),
      aliases: [],
      workspacePackages: [],
      exportsByFile: buildModuleExportIndexes(
        [...extractions].map(([filePath, extraction]) => ({ filePath, extraction }))
      ),
      fingerprintInputs: ['tsconfig.json'],
    },
  };
}

describe('ReactFactExtractor', () => {
  it('extracts exported components, exact rendered imports, and called custom hooks', async () => {
    const files = {
      'src/Child.tsx': `export function Child(){ return <div/> }`,
      'src/useCatalog.ts': `export function useCatalog(){ return 1 }`,
      'src/App.tsx': `import { Child } from './Child'; import { useCatalog } from './useCatalog';
        export function App(){ useCatalog(); return <Child onPress={() => 1}/> }`,
    };
    const result = await new ReactFactExtractor().extract(await input(files));
    expect(result.facts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'react-component',
          filePath: 'src/App.tsx',
          exportName: 'App',
        }),
        expect.objectContaining({
          kind: 'react-component',
          filePath: 'src/Child.tsx',
          exportName: 'Child',
        }),
        expect.objectContaining({ kind: 'react-render', ownerExport: 'App', jsxName: 'Child' }),
        expect.objectContaining({
          kind: 'react-hook-call',
          ownerExport: 'App',
          localName: 'useCatalog',
        }),
      ])
    );
    expect(result.facts.some((fact) => fact.kind.includes('event'))).toBe(false);
    expect(result.dependencies).toContain('tsconfig.json');
  });

  it('extracts createContext declarations and provider/useContext/consumer uses', async () => {
    const files = {
      'src/context.tsx': `import { createContext, useContext } from 'react';
        export const ThemeContext = createContext('light');
        export function Provider(){ return <ThemeContext.Provider value="dark"><ThemeContext.Consumer>{x => x}</ThemeContext.Consumer></ThemeContext.Provider> }
        export function Reader(){ useContext(ThemeContext); return <span/> }`,
    };
    const result = await new ReactFactExtractor().extract(await input(files));
    expect(result.facts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'react-context', exportName: 'ThemeContext' }),
        expect.objectContaining({
          kind: 'react-context-use',
          ownerExport: 'Provider',
          mode: 'provider',
        }),
        expect.objectContaining({
          kind: 'react-context-use',
          ownerExport: 'Provider',
          mode: 'consumer',
        }),
        expect.objectContaining({
          kind: 'react-context-use',
          ownerExport: 'Reader',
          mode: 'use-context',
        }),
      ])
    );
  });

  it('reports non-literal lazy imports and never mistakes import-only hooks for calls', async () => {
    const files = {
      'src/useIdle.ts': `export function useIdle(){}`,
      'src/App.tsx': `import { lazy } from 'react'; import { useIdle } from './useIdle';
        const name = './Child'; export function App(){ const Child = lazy(() => import(\`${'${name}'}\`)); return <Child/> }`,
    };
    const result = await new ReactFactExtractor().extract(await input(files));
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'REACT_DYNAMIC_IMPORT_UNSUPPORTED' }),
      ])
    );
    expect(result.facts).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'react-hook-call', localName: 'useIdle' }),
      ])
    );
  });
});
