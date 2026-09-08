import { describe, expect, it } from 'vitest';
import type {
  ModuleExportIndexV1,
  ProjectResolutionContextV1,
} from '../../../contracts/program.js';
import { MobileRelationshipResolver } from '../resolver.js';
import type { MobileFactV1 } from '../types.js';

const at = (filePath: string, line = 1, column = 0) => ({ filePath, line, column });

function project(): ProjectResolutionContextV1 {
  return {
    rootPath: '/repo',
    sourceFiles: new Set([
      'src/contracts/AccountRepository.ts',
      'src/data/SqlAccountRepository.ts',
      'src/view-models/AccountViewModel.ts',
      'src/hooks/useAccount.ts',
      'src/screens/AccountScreen.tsx',
    ]),
    aliases: [
      {
        pattern: '@contracts/*',
        targets: ['src/contracts/*'],
        source: 'tsconfig',
        configFile: 'tsconfig.json',
        precedence: 0,
      },
      {
        pattern: '@view-models/*',
        targets: ['src/view-models/*'],
        source: 'tsconfig',
        configFile: 'tsconfig.json',
        precedence: 0,
      },
      {
        pattern: '@hooks/*',
        targets: ['src/hooks/*'],
        source: 'tsconfig',
        configFile: 'tsconfig.json',
        precedence: 0,
      },
    ],
    workspacePackages: [],
    exportsByFile: new Map<string, ModuleExportIndexV1>([
      [
        'src/contracts/AccountRepository.ts',
        {
          named: {
            AccountRepository: {
              filePath: 'src/contracts/AccountRepository.ts',
              localName: 'AccountRepository',
              declarationId: 'AccountRepository',
            },
          },
          reexports: [],
        },
      ],
      [
        'src/view-models/AccountViewModel.ts',
        {
          named: {
            AccountViewModel: {
              filePath: 'src/view-models/AccountViewModel.ts',
              localName: 'AccountViewModel',
              declarationId: 'AccountViewModel',
            },
          },
          reexports: [],
        },
      ],
      [
        'src/hooks/useAccount.ts',
        {
          named: {
            useAccount: {
              filePath: 'src/hooks/useAccount.ts',
              localName: 'useAccount',
              declarationId: 'useAccount',
            },
          },
          reexports: [],
        },
      ],
    ]),
    fingerprintInputs: ['tsconfig.json'],
  };
}

describe('mobile relationship resolver', () => {
  it('emits exact implementation-to-interface declares_resource edges', async () => {
    const facts: MobileFactV1[] = [
      {
        kind: 'mobile-repository-interface',
        filePath: 'src/contracts/AccountRepository.ts',
        localName: 'AccountRepository',
        exportName: 'AccountRepository',
        location: at('src/contracts/AccountRepository.ts'),
      },
      {
        kind: 'mobile-repository-implementation',
        filePath: 'src/data/SqlAccountRepository.ts',
        localName: 'SqlAccountRepository',
        exportName: 'SqlAccountRepository',
        location: at('src/data/SqlAccountRepository.ts'),
        interfaceName: 'AccountRepository',
        interfaceBinding: {
          localName: 'AccountRepository',
          importedName: 'AccountRepository',
          sourceSpecifier: '@contracts/AccountRepository',
        },
        interfaceLocation: at('src/data/SqlAccountRepository.ts', 2, 44),
      },
    ];

    const result = await new MobileRelationshipResolver().resolve(facts, project());
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0]).toMatchObject({
      edgeType: 'declares_resource',
      sourceNodeId: 'symbol:ts:src/data/SqlAccountRepository.ts#SqlAccountRepository',
      targetNodeId: 'symbol:ts:src/contracts/AccountRepository.ts#AccountRepository',
      provenance: { resolver: 'mobile-repository' },
    });
    expect(result.diagnostics).toEqual([]);
  });

  it('emits owner and canonical hook to exact ViewModel edges', async () => {
    const facts: MobileFactV1[] = [
      {
        kind: 'mobile-view-model',
        filePath: 'src/view-models/AccountViewModel.ts',
        localName: 'AccountViewModel',
        exportName: 'AccountViewModel',
        location: at('src/view-models/AccountViewModel.ts'),
      },
      {
        kind: 'mobile-view-model-use',
        filePath: 'src/screens/AccountScreen.tsx',
        owner: {
          filePath: 'src/screens/AccountScreen.tsx',
          localName: 'AccountScreen',
          exportName: 'AccountScreen',
          location: at('src/screens/AccountScreen.tsx'),
        },
        viewModelName: 'AccountViewModel',
        viewModelBinding: {
          localName: 'AccountViewModel',
          importedName: 'AccountViewModel',
          sourceSpecifier: '@view-models/AccountViewModel',
        },
        mode: 'direct',
        location: at('src/screens/AccountScreen.tsx', 3, 15),
      },
      {
        kind: 'mobile-view-model-use',
        filePath: 'src/screens/AccountScreen.tsx',
        owner: {
          filePath: 'src/screens/AccountScreen.tsx',
          localName: 'AccountScreen',
          exportName: 'AccountScreen',
          location: at('src/screens/AccountScreen.tsx'),
        },
        viewModelName: 'AccountViewModel',
        viewModelBinding: {
          localName: 'AccountViewModel',
          importedName: 'AccountViewModel',
          sourceSpecifier: '../view-models/AccountViewModel',
        },
        mode: 'hook-return',
        hookName: 'useAccount',
        hookBinding: {
          localName: 'useAccount',
          importedName: 'useAccount',
          sourceSpecifier: '@hooks/useAccount',
        },
        location: at('src/screens/AccountScreen.tsx', 4, 15),
      },
    ];

    const result = await new MobileRelationshipResolver().resolve(facts, project());
    expect(result.edges).toHaveLength(2);
    expect(result.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          edgeType: 'uses_view_model',
          sourceNodeId: 'symbol:ts:src/screens/AccountScreen.tsx#AccountScreen',
          targetNodeId: 'symbol:ts:src/view-models/AccountViewModel.ts#AccountViewModel',
        }),
        expect.objectContaining({
          edgeType: 'uses_view_model',
          sourceNodeId: 'symbol:ts:src/hooks/useAccount.ts#useAccount',
          targetNodeId: 'symbol:ts:src/view-models/AccountViewModel.ts#AccountViewModel',
        }),
      ])
    );
    expect(result.diagnostics).toEqual([]);
  });

  it('refuses suffix-only repository and ViewModel edges', async () => {
    const facts: MobileFactV1[] = [
      {
        kind: 'mobile-repository-implementation',
        filePath: 'src/data/SqlAccountRepository.ts',
        localName: 'SqlAccountRepository',
        exportName: 'SqlAccountRepository',
        location: at('src/data/SqlAccountRepository.ts'),
        interfaceName: 'AccountRepository',
        interfaceLocation: at('src/data/SqlAccountRepository.ts', 2, 44),
      },
      {
        kind: 'mobile-view-model-use',
        filePath: 'src/screens/AccountScreen.tsx',
        owner: {
          filePath: 'src/screens/AccountScreen.tsx',
          localName: 'AccountScreen',
          exportName: 'AccountScreen',
          location: at('src/screens/AccountScreen.tsx'),
        },
        viewModelName: 'MissingViewModel',
        mode: 'direct',
        location: at('src/screens/AccountScreen.tsx', 3, 15),
      },
    ];

    const result = await new MobileRelationshipResolver().resolve(facts, project());
    expect(result.edges).toEqual([]);
    expect(result.diagnostics.map((item) => item.code)).toEqual([
      'MOBILE_UNRESOLVED_BINDING',
      'MOBILE_UNRESOLVED_BINDING',
    ]);
  });
});
