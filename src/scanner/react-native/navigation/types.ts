import type {
  ProjectResolutionContextV1,
  SourceDiagnosticV1,
  SourceLocationV1,
} from '../../contracts/program.js';
import type { StructuralRelationEdge } from '../../associations/types.js';
import type { Extraction } from '../../ast/extract.js';
import type { FrameworkNodeV1 } from '../../react/types.js';

export type ReactNavigationFactoryV1 =
  | 'createStackNavigator'
  | 'createNativeStackNavigator'
  | 'createBottomTabNavigator'
  | 'createDrawerNavigator'
  | 'createMaterialBottomTabNavigator'
  | 'createMaterialTopTabNavigator';

export interface NavigationComponentV1 {
  filePath: string;
  exportName: string;
  localName: string;
  declaration: SourceLocationV1;
}

export interface ReactNavigationNavigatorFactV1 {
  kind: 'react-navigation-navigator';
  filePath: string;
  localName: string;
  factory: ReactNavigationFactoryV1;
  packageName: string;
  owner?: NavigationComponentV1;
  location: SourceLocationV1;
}

export interface ReactNavigationScreenFactV1 {
  kind: 'react-navigation-screen';
  filePath: string;
  navigatorLocalName: string;
  name: string;
  component?: NavigationComponentV1;
  location: SourceLocationV1;
}

export type ReactNavigationActionMethodV1 = 'navigate' | 'push' | 'replace' | 'jumpTo';

export interface ReactNavigationActionFactV1 {
  kind: 'react-navigation-action';
  filePath: string;
  owner: NavigationComponentV1;
  method: ReactNavigationActionMethodV1;
  /** Static route path. Nested navigation appends each literal `screen` value. */
  routePath: readonly string[];
  location: SourceLocationV1;
  form: 'navigation-object' | 'action-creator';
}

export type ReactNavigationFactV1 =
  ReactNavigationNavigatorFactV1 | ReactNavigationScreenFactV1 | ReactNavigationActionFactV1;

export interface ReactNavigationAnalysisInputV1 {
  rootPath: string;
  files: readonly string[];
  project: ProjectResolutionContextV1;
  extractions?: ReadonlyMap<string, Extraction>;
  sources?: ReadonlyMap<string, string>;
}

export interface ReactNavigationExtractionResultV1 {
  facts: ReactNavigationFactV1[];
  dependencies: string[];
  diagnostics: SourceDiagnosticV1[];
}

export interface ReactNavigationResolutionResultV1 {
  nodes: FrameworkNodeV1[];
  edges: StructuralRelationEdge[];
  diagnostics: SourceDiagnosticV1[];
}

export interface ReactNavigationAnalysisResultV1 extends ReactNavigationExtractionResultV1 {
  nodes: FrameworkNodeV1[];
  edges: StructuralRelationEdge[];
}

export interface ReactNavigationFactExtractorV1 {
  extract(input: ReactNavigationAnalysisInputV1): Promise<ReactNavigationExtractionResultV1>;
}

export interface ReactNavigationRelationshipResolverV1 {
  resolve(
    facts: readonly ReactNavigationFactV1[],
    project: ProjectResolutionContextV1
  ): Promise<ReactNavigationResolutionResultV1>;
}
