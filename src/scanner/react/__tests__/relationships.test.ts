import { describe, expect, it } from 'vitest';
import type {
  ModuleExportIndexV1,
  ProjectResolutionContextV1,
  SourceLocationV1,
} from '../../contracts/program.js';
import { reactComponentId, reactContextId, reactHookId } from '../../identity/program-identity.js';
import { ReactFrameworkAnalyzer } from '../analyzer.js';
import { ReactRelationshipResolver } from '../resolver.js';
import type {
  ReactAnalysisInputV1,
  ReactComponentFactV1,
  ReactContextFactV1,
  ReactFactExtractorV1,
  ReactFactV1,
} from '../types.js';

const at = (filePath: string, line: number): SourceLocationV1 => ({ filePath, line, column: 0 });

function component(
  filePath: string,
  exportName: string,
  localName = exportName
): ReactComponentFactV1 {
  return {
    kind: 'react-component',
    filePath,
    exportName,
    localName,
    declaration: at(filePath, 1),
    form: 'function',
  };
}

function context(filePath: string, exportName: string, localName = exportName): ReactContextFactV1 {
  return {
    kind: 'react-context',
    filePath,
    exportName,
    localName,
    declaration: at(filePath, 1),
  };
}

function binding(
  localName: string,
  importedName: string,
  sourceSpecifier: string,
  targetFile = ''
) {
  return {
    localName,
    importedName,
    sourceSpecifier,
    targetFile,
    targetExport: importedName,
  };
}

function index(filePath: string, names: Record<string, string>): ModuleExportIndexV1 {
  return {
    named: Object.fromEntries(
      Object.entries(names).map(([exportName, localName]) => [
        exportName,
        { filePath, localName, declarationId: localName },
      ])
    ),
    reexports: [],
  };
}

function project(
  files: readonly string[],
  indexes: ReadonlyMap<string, ModuleExportIndexV1>,
  aliases: ProjectResolutionContextV1['aliases'] = []
): ProjectResolutionContextV1 {
  return {
    rootPath: '/repo',
    sourceFiles: new Set(files),
    aliases,
    workspacePackages: [],
    exportsByFile: indexes,
    fingerprintInputs: [],
  };
}

describe('ReactRelationshipResolver', () => {
  it('emits only exact component, custom-hook, provider, and consumer relationships', async () => {
    const app = 'src/App.tsx';
    const card = 'src/Card.tsx';
    const hook = 'src/useAccount.ts';
    const contextFile = 'src/AccountContext.ts';
    const facts: ReactFactV1[] = [
      component(app, 'App'),
      component(card, 'Card'),
      context(contextFile, 'AccountContext'),
      {
        kind: 'react-render',
        filePath: app,
        ownerExport: 'App',
        jsxName: 'CardView',
        binding: binding('CardView', 'Card', './Card', 'forged/ignored.tsx'),
        location: at(app, 5),
        form: 'jsx',
      },
      {
        kind: 'react-hook-call',
        filePath: app,
        ownerExport: 'App',
        localName: 'useCurrentAccount',
        binding: binding('useCurrentAccount', 'useAccount', './useAccount'),
        location: at(app, 3),
      },
      {
        kind: 'react-context-use',
        filePath: app,
        ownerExport: 'App',
        mode: 'provider',
        contextLocalName: 'Account',
        contextBinding: binding('Account', 'AccountContext', './AccountContext'),
        location: at(app, 7),
      },
      {
        kind: 'react-context-use',
        filePath: card,
        ownerExport: 'Card',
        mode: 'use-context',
        contextLocalName: 'Account',
        contextBinding: binding('Account', 'AccountContext', './AccountContext'),
        location: at(card, 4),
      },
    ];
    const result = await new ReactRelationshipResolver().resolve(
      facts,
      project(
        [app, card, hook, contextFile],
        new Map([
          [app, index(app, { App: 'App' })],
          [card, index(card, { Card: 'Card' })],
          [hook, index(hook, { useAccount: 'useAccount' })],
          [contextFile, index(contextFile, { AccountContext: 'AccountContext' })],
        ])
      )
    );

    expect(result.edges.map((edge) => edge.edgeType).sort()).toEqual([
      'consumes_context',
      'provides_context',
      'renders_component',
      'uses_hook',
    ]);
    expect(result.edges.map((edge) => [edge.sourceNodeId, edge.targetNodeId])).toEqual(
      expect.arrayContaining([
        [reactComponentId(app, 'App'), reactComponentId(card, 'Card')],
        [reactComponentId(app, 'App'), reactHookId(hook, 'useAccount')],
        [reactComponentId(app, 'App'), reactContextId(contextFile, 'AccountContext')],
        [reactComponentId(card, 'Card'), reactContextId(contextFile, 'AccountContext')],
      ])
    );
    expect(result.edges.every((edge) => edge.provenance.extractedAt === 0)).toBe(true);
    expect(result.diagnostics).toEqual([]);
  });

  it('refuses external, ambiguous, missing, and unused imports without speculative edges', async () => {
    const app = 'src/App.tsx';
    const facts: ReactFactV1[] = [
      component(app, 'App'),
      {
        kind: 'react-render',
        filePath: app,
        ownerExport: 'App',
        jsxName: 'External',
        binding: binding('External', 'External', 'external-package'),
        location: at(app, 4),
        form: 'jsx',
      },
      {
        kind: 'react-hook-call',
        filePath: app,
        ownerExport: 'App',
        localName: 'useMissing',
        binding: binding('useMissing', 'useMissing', './missing'),
        location: at(app, 5),
      },
      {
        kind: 'react-context-use',
        filePath: app,
        ownerExport: 'App',
        mode: 'consumer',
        contextLocalName: 'AmbiguousContext',
        contextBinding: binding('AmbiguousContext', 'AmbiguousContext', '@ambiguous'),
        location: at(app, 6),
      },
    ];
    // An imported declaration with no corresponding use fact is deliberately inert.
    const unused = context('src/Unused.ts', 'UnusedContext');
    const result = await new ReactRelationshipResolver().resolve(
      [...facts, unused],
      project([app, 'src/a.ts', 'src/b.ts', 'src/Unused.ts'], new Map(), [
        {
          pattern: '@ambiguous',
          targets: ['src/a.ts', 'src/b.ts'],
          source: 'tsconfig',
          configFile: 'tsconfig.json',
          precedence: 0,
        },
      ])
    );

    expect(result.edges).toEqual([]);
    expect(result.diagnostics).toHaveLength(3);
    expect(result.diagnostics.map((item) => item.code).sort()).toEqual([
      'REACT_AMBIGUOUS_BINDING',
      'REACT_UNRESOLVED_BINDING',
      'REACT_UNRESOLVED_BINDING',
    ]);
  });

  it('composes extraction and relationship outputs verbatim', async () => {
    const facts = [component('src/App.tsx', 'App')];
    const extractionDiagnostic = { code: 'extract', message: 'extract diagnostic' };
    const extractor: ReactFactExtractorV1 = {
      extract: async () => ({
        facts,
        dependencies: ['tsconfig.json'],
        diagnostics: [extractionDiagnostic],
      }),
    };
    const relationshipDiagnostic = { code: 'resolve', message: 'resolve diagnostic' };
    const resolver = {
      resolve: async () => ({ nodes: [], edges: [], diagnostics: [relationshipDiagnostic] }),
    };
    const input: ReactAnalysisInputV1 = {
      rootPath: '/repo',
      files: ['src/App.tsx'],
      project: project(['src/App.tsx'], new Map()),
    };

    await expect(new ReactFrameworkAnalyzer(extractor, resolver).analyze(input)).resolves.toEqual({
      facts,
      nodes: [],
      edges: [],
      dependencies: ['tsconfig.json'],
      diagnostics: [extractionDiagnostic, relationshipDiagnostic],
    });
  });
});
