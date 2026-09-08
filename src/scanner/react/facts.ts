import { Buffer } from 'node:buffer';
import type { SourceDiagnosticV1, SourceLocationV1 } from '../contracts/program.js';
import { resolveProjectBinding } from '../project-resolution/resolver.js';
import type { AstNode, Extraction, ImportBinding } from '../ast/extract.js';
import type {
  ReactAnalysisInputV1,
  ReactComponentFactV1,
  ReactContextFactV1,
  ReactFactExtractorV1,
  ReactFactV1,
  ReactLazyFactV1,
  ReactRenderFactV1,
  ResolvedBindingV1,
} from './types.js';

const SOURCE_EXTENSION = /\.(?:[cm]?[jt]sx?)$/u;
const ROUTE_FILE = /(?:^|\/)(?:page|layout|loading|error|_layout)\.[jt]sx$/u;
const CUSTOM_HOOK = /^use[A-Z0-9]/u;

interface FileState {
  filePath: string;
  source: string;
  extraction: Extraction;
  imports: ReadonlyMap<string, ImportBinding>;
  localToExport: ReadonlyMap<string, string>;
  components: ReactComponentFactV1[];
}

/** React fact extraction over the already-produced Tranche 2 cache. This class never reparses. */
export class ReactFactExtractor implements ReactFactExtractorV1 {
  extract(input: ReactAnalysisInputV1): Promise<{
    facts: ReactFactV1[];
    dependencies: string[];
    diagnostics: SourceDiagnosticV1[];
  }> {
    const facts: ReactFactV1[] = [];
    const diagnostics: SourceDiagnosticV1[] = [];
    const dependencies = new Set<string>(input.project.fingerprintInputs);
    if (!input.extractions || !input.sources) {
      return Promise.resolve({
        facts,
        dependencies: [...dependencies].sort(),
        diagnostics: [
          {
            code: 'REACT_UNRESOLVED_BINDING',
            message: 'React analysis requires the shared extraction and source caches.',
          },
        ],
      });
    }

    const files = [...new Set(input.files)].filter((file) => SOURCE_EXTENSION.test(file)).sort();
    for (const filePath of files) {
      const source = input.sources.get(filePath);
      const extraction = input.extractions.get(filePath);
      if (source === undefined || !extraction) continue;
      dependencies.add(filePath);
      const state = buildFileState(filePath, source, extraction);
      facts.push(...state.components);
      facts.push(...extractContexts(state));
      facts.push(...extractRenders(state, input, diagnostics));
      facts.push(...extractLazy(state, input, diagnostics));
      facts.push(...extractHookCalls(state, input));
      facts.push(...extractContextUses(state, input));
      if (/^\s*['"]use server['"];?/mu.test(source) && /\buse client\b/u.test(source)) {
        diagnostics.push({
          code: 'REACT_SERVER_CLIENT_BOUNDARY_PARTIAL',
          message: 'Mixed React server/client boundaries are only partially modeled.',
          location: location(filePath, source, source.search(/\buse client\b/u)),
        });
      }
    }
    return Promise.resolve({
      facts: sortFacts(deduplicateFacts(facts)),
      dependencies: [...dependencies].sort(),
      diagnostics: sortDiagnostics(diagnostics),
    });
  }
}

function buildFileState(filePath: string, source: string, extraction: Extraction): FileState {
  const imports = new Map((extraction.imports ?? []).map((binding) => [binding.local, binding]));
  const localToExport = exportsFor(extraction);
  const components = extractComponents(filePath, source, extraction, localToExport, imports);
  return { filePath, source, extraction, imports, localToExport, components };
}

function exportsFor(extraction: Extraction): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  for (const fact of extraction.moduleFacts ?? []) {
    if (fact.kind === 'esm-export-default') {
      if (fact.localName && /^[A-Za-z_$][\w$]*$/u.test(fact.localName))
        result.set(fact.localName, 'default');
      continue;
    }
    if (fact.kind === 'esm-export-named' && fact.localName && fact.exportedName)
      result.set(fact.localName, fact.exportedName);
    if (
      (fact.kind === 'commonjs-module-exports' || fact.kind === 'commonjs-exports-member') &&
      fact.localName
    )
      result.set(fact.localName, fact.exportedName ?? 'default');
  }
  return result;
}

function extractComponents(
  filePath: string,
  source: string,
  extraction: Extraction,
  localToExport: ReadonlyMap<string, string>,
  imports: ReadonlyMap<string, ImportBinding>
): ReactComponentFactV1[] {
  const result: ReactComponentFactV1[] = [];
  for (const node of extraction.nodes) {
    if (node.type !== 'function' && node.type !== 'class') continue;
    const text = sourceForNode(source, node);
    if (!hasReactOutput(text)) continue;
    // Public identities use the exported name. File-private React components are still exact
    // declaration targets for same-file renders and use their local declaration name.
    const exportName = localToExport.get(node.name) ?? node.name;
    result.push({
      kind: 'react-component',
      filePath,
      exportName,
      localName: node.name,
      declaration: nodeLocation(filePath, node),
      form: node.type === 'class' ? 'class' : functionForm(source, node),
    });
  }

  const wrapped =
    /\b(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:React\.)?(memo|forwardRef)\s*\(/gu;
  for (const match of source.matchAll(wrapped)) {
    const binding = imports.get(match[2]);
    const validReactBinding =
      (binding?.module === 'react' && binding.imported === match[2]) ||
      source.includes(`import React`) ||
      source.includes(`from 'react'`) ||
      source.includes(`from "react"`);
    const exportName = localToExport.get(match[1]);
    if (!exportName || !validReactBinding) continue;
    result.push({
      kind: 'react-component',
      filePath,
      exportName,
      localName: match[1],
      declaration: location(filePath, source, match.index),
      form: match[2] === 'memo' ? 'memo' : 'forward-ref',
    });
  }

  if (ROUTE_FILE.test(filePath) && /\bexport\s+default\b/u.test(source) && hasReactOutput(source)) {
    if (!result.some((fact) => fact.exportName === 'default')) {
      const local = /\bexport\s+default\s+(?:async\s+)?function\s*([A-Za-z_$][\w$]*)?/u.exec(
        source
      );
      result.push({
        kind: 'react-component',
        filePath,
        exportName: 'default',
        localName: local?.[1] ?? 'default',
        declaration: location(
          filePath,
          source,
          local?.index ?? source.search(/\bexport\s+default\b/u)
        ),
        form: 'file-route',
      });
    }
  }
  return result;
}

function extractContexts(state: FileState): ReactContextFactV1[] {
  const result: ReactContextFactV1[] = [];
  const pattern =
    /\b(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:(React)\.)?createContext\s*[<(]/gu;
  for (const match of state.source.matchAll(pattern)) {
    const direct = state.imports.get('createContext');
    const namespace = state.imports.get(match[2] ?? '');
    const fromReact = match[2]
      ? namespace?.module === 'react' && namespace.imported === '*'
      : direct?.module === 'react' && direct.imported === 'createContext';
    if (!fromReact) continue;
    // Contexts may be intentionally file-private (example-workspace DialogDepthContext). Their stable
    // declaration identity remains file + local name; exported contexts use the public name.
    const exportName = state.localToExport.get(match[1]) ?? match[1];
    result.push({
      kind: 'react-context',
      filePath: state.filePath,
      exportName,
      localName: match[1],
      declaration: location(state.filePath, state.source, match.index),
    });
  }
  return result;
}

function extractRenders(
  state: FileState,
  input: ReactAnalysisInputV1,
  diagnostics: SourceDiagnosticV1[]
): ReactRenderFactV1[] {
  const result: ReactRenderFactV1[] = [];
  const patterns = [
    { re: /<([A-Z][A-Za-z0-9_$]*(?:\.[A-Z][A-Za-z0-9_$]*)?)(?=[\s/>])/gu, form: 'jsx' as const },
    {
      re: /\b(?:React\.)?createElement\s*\(\s*([A-Z][A-Za-z0-9_$]*(?:\.[A-Z][A-Za-z0-9_$]*)?)/gu,
      form: 'create-element' as const,
    },
  ];
  for (const { re, form } of patterns) {
    for (const match of state.source.matchAll(re)) {
      const ownerExport = ownerAt(state, match.index);
      if (!ownerExport) continue;
      const jsxName = match[1];
      const rootName = jsxName.split('.')[0];
      const binding = resolvedBinding(state, rootName, jsxName, input);
      if (state.imports.has(rootName) && !binding) {
        diagnostics.push({
          code: 'REACT_UNRESOLVED_BINDING',
          message: `React render binding ${jsxName} did not resolve to one first-party export.`,
          location: location(state.filePath, state.source, match.index),
        });
      }
      result.push({
        kind: 'react-render',
        filePath: state.filePath,
        ownerExport,
        jsxName,
        ...(binding ? { binding } : {}),
        location: location(state.filePath, state.source, match.index),
        form,
      });
    }
  }
  return result;
}

function extractLazy(
  state: FileState,
  input: ReactAnalysisInputV1,
  diagnostics: SourceDiagnosticV1[]
): ReactLazyFactV1[] {
  const result: ReactLazyFactV1[] = [];
  const candidates =
    /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:(?:React\.)?lazy|dynamic)\s*\(\s*\(\s*\)\s*=>\s*import\s*\(([^)]*)\)/gu;
  for (const match of state.source.matchAll(candidates)) {
    const ownerExport = ownerAt(state, match.index) ?? state.localToExport.get(match[1]) ?? 'file';
    const literal = /^\s*(['"])([^'"]+)\1\s*$/u.exec(match[2]);
    const fact: ReactLazyFactV1 = {
      kind: 'react-lazy',
      filePath: state.filePath,
      ownerExport,
      localName: match[1],
      location: location(state.filePath, state.source, match.index),
    };
    if (!literal) {
      diagnostics.push({
        code: 'REACT_DYNAMIC_IMPORT_UNSUPPORTED',
        message: `React lazy binding ${match[1]} uses a non-literal import.`,
        location: fact.location,
      });
      result.push(fact);
      continue;
    }
    const resolution = resolveProjectBinding(
      {
        importerFile: state.filePath,
        specifier: literal[2],
        importedName: 'default',
        mode: 'dynamic-import',
      },
      input.project
    );
    result.push({
      ...fact,
      specifier: literal[2],
      targetExport:
        resolution.module.status === 'resolved' && resolution.exported?.status === 'resolved'
          ? 'default'
          : undefined,
    });
  }
  return result;
}

function extractHookCalls(state: FileState, input: ReactAnalysisInputV1): ReactFactV1[] {
  const result: ReactFactV1[] = [];
  for (const edge of state.extraction.edges) {
    if (edge.type !== 'call' || !edge.member || !CUSTOM_HOOK.test(edge.member)) continue;
    const root = edge.toRaw.split('.')[0];
    const imported = state.imports.get(root);
    if (imported?.module === 'react') continue;
    const index = byteToIndex(state.source, edge.range.startByte);
    const ownerExport = ownerAt(state, index);
    if (!ownerExport) continue;
    const binding = resolvedBinding(state, root, edge.member, input);
    result.push({
      kind: 'react-hook-call',
      filePath: state.filePath,
      ownerExport,
      localName: edge.member,
      ...(binding ? { binding } : {}),
      location: location(state.filePath, state.source, index),
    });
  }
  return result;
}

function extractContextUses(state: FileState, input: ReactAnalysisInputV1): ReactFactV1[] {
  const result: ReactFactV1[] = [];
  const patterns = [
    { re: /<([A-Z][\w$]*)\.Provider(?=[\s>])/gu, mode: 'provider' as const },
    { re: /<([A-Z][\w$]*)(?=\s+value\s*=)/gu, mode: 'provider' as const },
    { re: /\b(?:React\.)?useContext\s*\(\s*([A-Z][\w$]*)\s*\)/gu, mode: 'use-context' as const },
    { re: /<([A-Z][\w$]*)\.Consumer(?=[\s>])/gu, mode: 'consumer' as const },
  ];
  for (const { re, mode } of patterns) {
    for (const match of state.source.matchAll(re)) {
      const ownerExport = ownerAt(state, match.index);
      if (!ownerExport) continue;
      const name = match[1];
      const binding = resolvedBinding(state, name, name, input);
      result.push({
        kind: 'react-context-use',
        filePath: state.filePath,
        ownerExport,
        mode,
        ...(binding ? { contextBinding: binding } : {}),
        contextLocalName: name,
        location: location(state.filePath, state.source, match.index),
      });
    }
  }
  return result;
}

function resolvedBinding(
  state: FileState,
  rootName: string,
  fullName: string,
  input: ReactAnalysisInputV1
): ResolvedBindingV1 | undefined {
  const imported = state.imports.get(rootName);
  if (!imported?.module) return undefined;
  const member = fullName.includes('.') ? fullName.slice(fullName.indexOf('.') + 1) : undefined;
  const importedName = member ?? imported.imported;
  const resolution = resolveProjectBinding(
    {
      importerFile: state.filePath,
      specifier: imported.module,
      importedName,
      mode: 'import',
    },
    input.project
  );
  if (resolution.module.status !== 'resolved' || resolution.exported?.status !== 'resolved')
    return undefined;
  return {
    localName: rootName,
    importedName,
    sourceSpecifier: imported.module,
    targetFile: resolution.exported.target.filePath,
    targetExport: importedName,
    ...(resolution.module.evidenceFile ? { evidenceFile: resolution.module.evidenceFile } : {}),
  };
}

function ownerAt(state: FileState, index: number): string | undefined {
  const byte = Buffer.byteLength(state.source.slice(0, index));
  const candidates = state.extraction.nodes
    .filter(
      (node) =>
        node.range.startByte <= byte &&
        byte < node.range.endByte &&
        state.localToExport.has(node.name)
    )
    .sort((a, b) => a.range.endByte - a.range.startByte - (b.range.endByte - b.range.startByte));
  if (candidates[0]) return state.localToExport.get(candidates[0].name);
  const wrapper = state.components.find((component) => {
    const lineStart = lineOffset(state.source, component.declaration.line);
    const nextExport = state.source.indexOf('\nexport ', lineStart + 1);
    return index >= lineStart && (nextExport < 0 || index < nextExport);
  });
  return wrapper?.exportName;
}

function sourceForNode(source: string, node: AstNode): string {
  return Buffer.from(source).subarray(node.range.startByte, node.range.endByte).toString('utf8');
}

function hasReactOutput(source: string): boolean {
  return /<[A-Za-z][\w$.:-]*(?=[\s/>])|<>|\bReact\.createElement\s*\(/u.test(source);
}

function functionForm(source: string, node: AstNode): 'function' | 'arrow' {
  const text = sourceForNode(source, node);
  return /=>/u.test(text) ? 'arrow' : 'function';
}

function nodeLocation(filePath: string, node: AstNode): SourceLocationV1 {
  return { filePath, line: node.range.startLine, column: node.range.startColumn };
}

function location(filePath: string, source: string, index: number): SourceLocationV1 {
  const safe = Math.max(0, index);
  const before = source.slice(0, safe);
  const line = before.split('\n').length;
  const last = before.lastIndexOf('\n');
  return { filePath, line, column: safe - last - 1 };
}

function byteToIndex(source: string, byte: number): number {
  return Buffer.from(source).subarray(0, byte).toString('utf8').length;
}

function lineOffset(source: string, line: number): number {
  let offset = 0;
  for (let current = 1; current < line; current++) {
    const next = source.indexOf('\n', offset);
    if (next < 0) return source.length;
    offset = next + 1;
  }
  return offset;
}

function deduplicateFacts(facts: ReactFactV1[]): ReactFactV1[] {
  const result = new Map<string, ReactFactV1>();
  for (const fact of facts) {
    const locationValue = 'declaration' in fact ? fact.declaration : fact.location;
    const key = [
      fact.kind,
      fact.filePath,
      'exportName' in fact ? fact.exportName : '',
      'ownerExport' in fact ? fact.ownerExport : '',
      'localName' in fact ? fact.localName : '',
      'jsxName' in fact ? fact.jsxName : '',
      'mode' in fact ? fact.mode : '',
      locationValue.line,
      locationValue.column,
    ].join('\0');
    if (!result.has(key)) result.set(key, fact);
  }
  return [...result.values()];
}

function sortFacts(facts: ReactFactV1[]): ReactFactV1[] {
  return facts.sort((a, b) => {
    const left = 'declaration' in a ? a.declaration : a.location;
    const right = 'declaration' in b ? b.declaration : b.location;
    return (
      a.filePath.localeCompare(b.filePath) ||
      left.line - right.line ||
      left.column - right.column ||
      a.kind.localeCompare(b.kind)
    );
  });
}

function sortDiagnostics(diagnostics: SourceDiagnosticV1[]): SourceDiagnosticV1[] {
  return diagnostics.sort(
    (a, b) =>
      (a.location?.filePath ?? '').localeCompare(b.location?.filePath ?? '') ||
      (a.location?.line ?? 0) - (b.location?.line ?? 0) ||
      a.code.localeCompare(b.code)
  );
}
