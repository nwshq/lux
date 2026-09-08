import { describe, expect, it } from 'vitest';
import { extractSource, getGrammars } from '../../../ast/extract.js';
import { buildModuleExportIndexes } from '../../../project-resolution/export-index.js';
import { ReactNavigationAnalyzer } from '../analyzer.js';
import { ReactNavigationFactExtractor } from '../facts.js';
import { ReactNavigationRelationshipResolver } from '../resolver.js';

describe('React Navigation static graph', () => {
  it('scopes registered screens and static actions by navigator', async () => {
    const files = {
      'src/Detail.tsx': 'export function Detail(){return <div/>}',
      'src/App.tsx': `import {createNativeStackNavigator} from '@react-navigation/native-stack';import {Detail} from './Detail';const Stack=createNativeStackNavigator();export function App(){navigation.navigate('Detail');return <Stack.Screen name="Detail" component={Detail}/>} `,
    };
    const grammars = await getGrammars();
    const extractions = new Map<string, any>();
    for (const [path, source] of Object.entries(files))
      extractions.set(path, extractSource(grammars, source, path, 'tsx').extraction);
    const project: any = {
      rootPath: '/repo',
      sourceFiles: new Set(Object.keys(files)),
      aliases: [],
      workspacePackages: [],
      exportsByFile: buildModuleExportIndexes(
        [...extractions].map(([filePath, extraction]) => ({ filePath, extraction }))
      ),
      fingerprintInputs: [],
    };
    const out = await new ReactNavigationAnalyzer(
      new ReactNavigationFactExtractor(),
      new ReactNavigationRelationshipResolver()
    ).analyze({
      rootPath: '/repo',
      files: Object.keys(files),
      sources: new Map(Object.entries(files)),
      extractions,
      project,
    });
    expect(out.nodes.some((node) => node.metadata.kind === 'screen')).toBe(true);
    expect(out.edges.map((edge) => edge.edgeType)).toEqual(
      expect.arrayContaining(['handled_by', 'navigates_to'])
    );
  });
  it('ignores Expo Stack.Screen and reports dynamic names', async () => {
    const files = {
      'app/_layout.tsx': `import {Stack} from 'expo-router';export function App(){return <Stack.Screen name={route}/>} `,
    };
    const grammars = await getGrammars();
    const ex = new Map<string, any>();
    ex.set(
      'app/_layout.tsx',
      extractSource(grammars, files['app/_layout.tsx'], 'app/_layout.tsx', 'tsx').extraction
    );
    const project: any = {
      rootPath: '/repo',
      sourceFiles: new Set(Object.keys(files)),
      aliases: [],
      workspacePackages: [],
      exportsByFile: buildModuleExportIndexes(
        [...ex].map(([filePath, extraction]) => ({ filePath, extraction }))
      ),
      fingerprintInputs: [],
    };
    const out = await new ReactNavigationAnalyzer(
      new ReactNavigationFactExtractor(),
      new ReactNavigationRelationshipResolver()
    ).analyze({
      rootPath: '/repo',
      files: Object.keys(files),
      sources: new Map(Object.entries(files)),
      extractions: ex,
      project,
    });
    expect(out.nodes).toEqual([]);
    expect(out.edges).toEqual([]);
  });
});
