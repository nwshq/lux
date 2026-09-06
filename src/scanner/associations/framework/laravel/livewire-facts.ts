import { posix } from 'node:path';

import type { SourceDiagnosticV1, SourceLocationV1 } from '../../../contracts/program.js';
import type { AssociationContext } from '../../types.js';

export interface LivewireFrameworkConfigV1 {
  classRoots: readonly string[];
  viewRoots: readonly string[];
  viewNamespaces: Readonly<Record<string, readonly string[]>>;
}

export const DEFAULT_LIVEWIRE_FRAMEWORK_CONFIG: LivewireFrameworkConfigV1 = {
  classRoots: ['app/Livewire', 'app/Http/Livewire'],
  viewRoots: ['resources/views'],
  viewNamespaces: {},
};

export interface LivewireViewFactV1 {
  name: string;
  kind: 'render' | 'layout';
  location: SourceLocationV1;
}

export interface LivewireClassFactV1 {
  filePath: string;
  name: string;
  qualifiedName: string;
  parentQualifiedName?: string;
  classRoot?: string;
  conventionalName?: string;
  views: LivewireViewFactV1[];
  location: SourceLocationV1;
}

export interface LivewireRegistrationFactV1 {
  alias: string;
  className: string;
  filePath: string;
  location: SourceLocationV1;
}

export interface LivewireViewNamespaceFactV1 {
  namespace: string;
  roots: string[];
  filePath: string;
  location: SourceLocationV1;
  source: 'configured' | 'discovered';
}

export interface LivewireFactsV1 {
  classes: LivewireClassFactV1[];
  registrations: LivewireRegistrationFactV1[];
  viewNamespaces: LivewireViewNamespaceFactV1[];
  diagnostics: SourceDiagnosticV1[];
}

interface ParsedClass {
  filePath: string;
  sourceContent: string;
  name: string;
  qualifiedName: string;
  parentQualifiedName?: string;
  body: string;
  bodyOffset: number;
  location: SourceLocationV1;
}

interface PhpEntry {
  filePath: string;
  content: string;
  code: string;
  namespace?: string;
  imports: Map<string, string>;
  classes: ParsedClass[];
}

export function extractLivewireFacts(
  context: AssociationContext,
  config: Partial<LivewireFrameworkConfigV1> = {}
): LivewireFactsV1 {
  const normalizedConfig = normalizeLivewireConfig(config);
  const diagnostics: SourceDiagnosticV1[] = [];
  const entries = context.entries
    .filter((entry) => isFirstPartyPhpPath(entry.filePath))
    .map(parsePhpEntry)
    .filter((entry): entry is PhpEntry => entry !== null)
    .sort((left, right) => left.filePath.localeCompare(right.filePath));
  for (const entry of entries) {
    const match = /\bnew\s+class\s+extends\s+(?:\\?Livewire\\Component|Component)\b/u.exec(
      entry.code
    );
    if (match) {
      diagnostics.push(
        diagnostic(
          'livewire-anonymous-unsupported',
          'Anonymous Livewire components are outside the deterministic subset.',
          entry.filePath,
          entry.content,
          match.index
        )
      );
    }
  }
  const parsedClasses = entries.flatMap((entry) => entry.classes);
  const livewireNames = findLivewireClassNames(parsedClasses);

  const classes = parsedClasses
    .filter((item) => livewireNames.has(item.qualifiedName))
    .map((item): LivewireClassFactV1 => {
      const classRoot = matchingRoot(item.filePath, normalizedConfig.classRoots);
      return {
        filePath: item.filePath,
        name: item.name,
        qualifiedName: item.qualifiedName,
        parentQualifiedName: item.parentQualifiedName,
        classRoot,
        conventionalName: classRoot
          ? conventionalComponentName(item.filePath, classRoot)
          : undefined,
        views: extractLiteralViews(item, diagnostics),
        location: item.location,
      };
    })
    .sort((left, right) => left.qualifiedName.localeCompare(right.qualifiedName));

  const livewireClassNames = new Set(classes.map((item) => item.qualifiedName));
  const registrations = entries.flatMap((entry) =>
    extractRegistrations(entry, livewireClassNames, diagnostics)
  );
  const viewNamespaces = [
    ...configuredNamespaces(normalizedConfig),
    ...entries.flatMap((entry) => discoverNamespaces(entry, diagnostics)),
  ].sort((left, right) =>
    `${left.namespace}\0${left.filePath}`.localeCompare(`${right.namespace}\0${right.filePath}`)
  );

  return { classes, registrations, viewNamespaces, diagnostics };
}

export function normalizeLivewireConfig(
  config: Partial<LivewireFrameworkConfigV1>
): LivewireFrameworkConfigV1 {
  return {
    classRoots: validRoots(config.classRoots ?? DEFAULT_LIVEWIRE_FRAMEWORK_CONFIG.classRoots),
    viewRoots: validRoots(config.viewRoots ?? DEFAULT_LIVEWIRE_FRAMEWORK_CONFIG.viewRoots),
    viewNamespaces: Object.fromEntries(
      Object.entries(config.viewNamespaces ?? {}).flatMap(([namespace, roots]) => {
        if (!isStaticNamespace(namespace)) return [];
        const valid = validRoots(roots);
        return valid.length > 0 ? [[namespace, valid]] : [];
      })
    ),
  };
}

export function isSafeRepositoryPath(filePath: string): boolean {
  if (!filePath || filePath.includes('\0') || filePath.includes('\\')) return false;
  if (filePath.startsWith('/') || /^[A-Za-z]:/u.test(filePath)) return false;
  const parts = filePath.split('/');
  return !parts.some((part) => part === '' || part === '.' || part === '..');
}

export function isVendorPath(filePath: string): boolean {
  const parts = filePath.split('/');
  if (parts.includes('node_modules')) return true;
  const vendor = parts.indexOf('vendor');
  // `resources/views/vendor/<namespace>` is an application-owned published view namespace.
  if (vendor === 2 && parts[0] === 'resources' && parts[1] === 'views') return false;
  return vendor >= 0;
}

function isFirstPartyPhpPath(filePath: string): boolean {
  return filePath.endsWith('.php') && isSafeRepositoryPath(filePath) && !isVendorPath(filePath);
}

function parsePhpEntry(entry: AssociationContext['entries'][number]): PhpEntry | null {
  const content = (entry.metadata?.content as string | undefined) ?? '';
  if (!content) return null;
  const code = maskComments(content);
  const namespace = /\bnamespace\s+([A-Za-z_\\][A-Za-z0-9_\\]*)\s*;/u.exec(code)?.[1];
  const imports = parseImports(code);
  const partial: Omit<PhpEntry, 'classes'> = {
    filePath: entry.filePath,
    content,
    code,
    namespace,
    imports,
  };
  return { ...partial, classes: parseClasses(partial) };
}

function parseImports(code: string): Map<string, string> {
  const imports = new Map<string, string>();
  for (const match of code.matchAll(/(?:^|;)\s*use\s+([^;]+);/gmu)) {
    const statement = match[1].trim();
    if (/^(?:function|const)\s/u.test(statement)) continue;
    const open = statement.indexOf('{');
    if (open >= 0 && statement.includes('}')) {
      const prefix = statement.slice(0, open).replace(/\\$/u, '');
      for (const member of statement.slice(open + 1, statement.lastIndexOf('}')).split(',')) {
        addImport(imports, `${prefix}\\${member.trim()}`);
      }
    } else {
      for (const member of statement.split(',')) addImport(imports, member.trim());
    }
  }
  return imports;
}

function addImport(imports: Map<string, string>, statement: string): void {
  const parts = statement.split(/\s+as\s+/iu);
  const qualified = parts[0].trim().replace(/^\\/u, '');
  if (!qualified) return;
  const alias = parts[1]?.trim() || qualified.split('\\').pop();
  if (alias) imports.set(alias, qualified);
}

function parseClasses(entry: Omit<PhpEntry, 'classes'>): ParsedClass[] {
  const classes: ParsedClass[] = [];
  const classRe =
    /\b(?:abstract\s+|final\s+|readonly\s+)*class\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:extends\s+([A-Za-z_\\][A-Za-z0-9_\\]*))?[^{};]*\{/gu;
  for (const match of entry.code.matchAll(classRe)) {
    const open = match.index + match[0].lastIndexOf('{');
    const close = findMatching(entry.content, open, '{', '}');
    if (close < 0) continue;
    const name = match[1];
    classes.push({
      filePath: entry.filePath,
      sourceContent: entry.content,
      name,
      qualifiedName: entry.namespace ? `${entry.namespace}\\${name}` : name,
      parentQualifiedName: match[2] ? resolveClassReference(match[2], entry) : undefined,
      body: entry.content.slice(open + 1, close),
      bodyOffset: open + 1,
      location: sourceLocation(entry.filePath, entry.content, match.index),
    });
  }
  return classes;
}

function resolveClassReference(
  raw: string,
  entry: Pick<PhpEntry, 'namespace' | 'imports'>
): string {
  const ref = raw.trim().replace(/^\\/u, '');
  const separator = ref.indexOf('\\');
  const head = separator < 0 ? ref : ref.slice(0, separator);
  const imported = entry.imports.get(head);
  if (imported) return separator < 0 ? imported : `${imported}${ref.slice(separator)}`;
  if (raw.startsWith('\\') || ref.includes('\\')) return ref;
  return entry.namespace ? `${entry.namespace}\\${ref}` : ref;
}

function findLivewireClassNames(classes: ParsedClass[]): Set<string> {
  const result = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of classes) {
      if (
        item.parentQualifiedName &&
        (item.parentQualifiedName === 'Livewire\\Component' ||
          result.has(item.parentQualifiedName)) &&
        !result.has(item.qualifiedName)
      ) {
        result.add(item.qualifiedName);
        changed = true;
      }
    }
  }
  return result;
}

function extractLiteralViews(
  item: ParsedClass,
  diagnostics: SourceDiagnosticV1[]
): LivewireViewFactV1[] {
  const render = extractMethod(item.body, item.bodyOffset, 'render');
  if (!render) return [];
  const facts: LivewireViewFactV1[] = [];
  const literalRe = /(?:\breturn\s+view|->layout)\s*\(\s*(['"])(.*?)\1\s*(?:,|\))/gsu;
  for (const match of render.content.matchAll(literalRe)) {
    const value = staticPhpString(match[2], match[1]);
    if (!value || !isStaticViewName(value)) {
      diagnostics.push(
        diagnostic(
          'livewire-dynamic-view',
          'Livewire view name is not a safe static literal.',
          item.filePath,
          item.sourceContent,
          render.absoluteOffset + match.index
        )
      );
      continue;
    }
    facts.push({
      name: value,
      kind: match[0].includes('->layout') ? 'layout' : 'render',
      location: sourceLocation(
        item.filePath,
        item.sourceContent,
        render.absoluteOffset + match.index
      ),
    });
  }
  if (
    /\breturn\s+view\s*\(/u.test(render.content) &&
    !facts.some((fact) => fact.kind === 'render')
  ) {
    diagnostics.push({
      code: 'livewire-dynamic-view',
      message: 'Dynamic Livewire render view cannot form a deterministic edge.',
      location: sourceLocation(item.filePath, render.fullContent, render.absoluteOffset),
    });
  }
  if (/->layout\s*\(/u.test(render.content) && !facts.some((fact) => fact.kind === 'layout')) {
    diagnostics.push({
      code: 'livewire-dynamic-layout',
      message: 'Dynamic Livewire layout cannot form deterministic template evidence.',
      location: sourceLocation(item.filePath, render.fullContent, render.absoluteOffset),
    });
  }
  return facts;
}

function extractMethod(
  classBody: string,
  classBodyOffset: number,
  method: string
): { content: string; absoluteOffset: number; relativeOffset: number; fullContent: string } | null {
  const re = new RegExp(`\\bfunction\\s+${method}\\s*\\([^)]*\\)[^{;]*\\{`, 'u');
  const match = re.exec(maskComments(classBody));
  if (!match) return null;
  const open = match.index + match[0].lastIndexOf('{');
  const close = findMatching(classBody, open, '{', '}');
  if (close < 0) return null;
  return {
    content: classBody.slice(open + 1, close),
    absoluteOffset: classBodyOffset + open + 1,
    relativeOffset: open + 1,
    fullContent: `${' '.repeat(classBodyOffset)}${classBody}`,
  };
}

function extractRegistrations(
  entry: PhpEntry,
  livewireClasses: ReadonlySet<string>,
  diagnostics: SourceDiagnosticV1[]
): LivewireRegistrationFactV1[] {
  const facts: LivewireRegistrationFactV1[] = [];
  const callRe =
    /(?:\\?Livewire\\Livewire|Livewire)::component\s*\(\s*(['"])(.*?)\1\s*,\s*([A-Za-z_\\][A-Za-z0-9_\\]*)::class\s*\)/gu;
  for (const match of entry.code.matchAll(callRe)) {
    const alias = staticPhpString(match[2], match[1]);
    const className = resolveClassReference(match[3], entry);
    if (!alias || !isStaticComponentName(alias) || !livewireClasses.has(className)) {
      diagnostics.push(
        diagnostic(
          'livewire-invalid-registration',
          'Livewire registration is dynamic, unsafe, external, or does not target a scanned Livewire class.',
          entry.filePath,
          entry.content,
          match.index
        )
      );
      continue;
    }
    facts.push({
      alias,
      className,
      filePath: entry.filePath,
      location: sourceLocation(entry.filePath, entry.content, match.index),
    });
  }
  if (/Livewire(?:::\w+)?::component\s*\(/u.test(entry.code) && facts.length === 0) {
    diagnostics.push({
      code: 'livewire-dynamic-registration',
      message: 'No deterministic Livewire component registration was found.',
      location: sourceLocation(
        entry.filePath,
        entry.content,
        entry.code.search(/Livewire(?:::\w+)?::component\s*\(/u)
      ),
    });
  }
  return facts;
}

function configuredNamespaces(config: LivewireFrameworkConfigV1): LivewireViewNamespaceFactV1[] {
  return Object.entries(config.viewNamespaces).map(([namespace, roots]) => ({
    namespace,
    roots: [...roots],
    filePath: 'lux.yaml',
    location: { filePath: 'lux.yaml', line: 1, column: 0 },
    source: 'configured',
  }));
}

function discoverNamespaces(
  entry: PhpEntry,
  diagnostics: SourceDiagnosticV1[]
): LivewireViewNamespaceFactV1[] {
  const facts: LivewireViewNamespaceFactV1[] = [];
  for (const call of findCalls(entry.content, entry.code, 'loadViewsFrom')) {
    const args = splitArguments(call.arguments);
    if (args.length < 2) continue;
    const namespaceMatch = /^\s*(['"])(.*?)\1\s*$/su.exec(args[1]);
    const namespace = namespaceMatch ? staticPhpString(namespaceMatch[2], namespaceMatch[1]) : null;
    const root = reducePathExpression(args[0], entry.filePath);
    if (!namespace || !isStaticNamespace(namespace) || !root) {
      diagnostics.push(
        diagnostic(
          'livewire-dynamic-namespace',
          'View namespace must use a confined static root and literal namespace.',
          entry.filePath,
          entry.content,
          call.index
        )
      );
      continue;
    }
    facts.push({
      namespace,
      roots: [root],
      filePath: entry.filePath,
      location: sourceLocation(entry.filePath, entry.content, call.index),
      source: 'discovered',
    });
  }
  return facts;
}

function findCalls(
  content: string,
  code: string,
  name: string
): Array<{ arguments: string; index: number }> {
  const calls: Array<{ arguments: string; index: number }> = [];
  const re = new RegExp(`\\b${name}\\s*\\(`, 'gu');
  for (const match of code.matchAll(re)) {
    const open = match.index + match[0].lastIndexOf('(');
    const close = findMatching(content, open, '(', ')');
    if (close >= 0) calls.push({ arguments: content.slice(open + 1, close), index: match.index });
  }
  return calls;
}

function splitArguments(value: string): string[] {
  const result: string[] = [];
  let start = 0;
  let depth = 0;
  let quote = '';
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (quote) {
      if (char === '\\') index++;
      else if (char === quote) quote = '';
    } else if (char === "'" || char === '"') quote = char;
    else if ('([{'.includes(char)) depth++;
    else if (')]}'.includes(char)) depth--;
    else if (char === ',' && depth === 0) {
      result.push(value.slice(start, index));
      start = index + 1;
    }
  }
  result.push(value.slice(start));
  return result;
}

function reducePathExpression(expression: string, providerPath: string): string | null {
  let value = expression.trim();
  const helper = /^(resource_path|base_path|app_path)\s*\(\s*(['"])(.*?)\2\s*\)$/su.exec(value);
  if (helper) {
    const literal = staticPhpString(helper[3], helper[2]);
    if (literal === null) return null;
    const prefix =
      helper[1] === 'resource_path' ? 'resources' : helper[1] === 'app_path' ? 'app' : '';
    return confinedJoin(prefix, literal);
  }

  const dirname = /^dirname\s*\(\s*__DIR__\s*(?:,\s*(\d+)\s*)?\)(.*)$/su.exec(value);
  let base = posix.dirname(providerPath);
  if (dirname) {
    const levels = Number(dirname[1] ?? '1');
    if (!Number.isSafeInteger(levels) || levels < 1 || levels > 32) return null;
    for (let count = 0; count < levels; count++) base = posix.dirname(base);
    value = dirname[2];
  } else if (value.startsWith('__DIR__')) {
    value = value.slice('__DIR__'.length);
  } else {
    return null;
  }

  let suffix = '';
  while (value.trim()) {
    const part = /^\s*\.\s*(['"])(.*?)\1/su.exec(value);
    if (!part) return null;
    const literal = staticPhpString(part[2], part[1]);
    if (literal === null) return null;
    suffix += literal;
    value = value.slice(part[0].length);
  }
  return confinedJoin(base, suffix);
}

function confinedJoin(base: string, suffix: string): string | null {
  const raw = `${base}/${suffix}`.replaceAll('\\', '/');
  if (raw.includes('\0') || raw.startsWith('/')) return null;
  const normalized = posix.normalize(raw).replace(/^\.\//u, '').replace(/\/$/u, '');
  return isSafeRepositoryPath(normalized) ? normalized : null;
}

function validRoots(roots: readonly string[]): string[] {
  return [
    ...new Set(
      roots
        .map((root) => root.replace(/\/$/u, ''))
        .filter((root) => isSafeRepositoryPath(root) && !isVendorPath(root))
    ),
  ].sort();
}

function matchingRoot(filePath: string, roots: readonly string[]): string | undefined {
  return [...roots]
    .sort((left, right) => right.length - left.length)
    .find((root) => filePath.startsWith(`${root}/`) && filePath.endsWith('.php'));
}

function conventionalComponentName(filePath: string, root: string): string | undefined {
  const relative = filePath.slice(root.length + 1).replace(/\.php$/u, '');
  if (!relative || !isSafeRepositoryPath(relative)) return undefined;
  return relative.split('/').map(kebabCase).join('.');
}

function kebabCase(value: string): string {
  return value
    .replace(/([A-Z]+)([A-Z][a-z])/gu, '$1-$2')
    .replace(/([a-z0-9])([A-Z])/gu, '$1-$2')
    .replace(/_/gu, '-')
    .toLowerCase();
}

export function isStaticComponentName(name: string): boolean {
  return isStaticViewName(name) && !name.includes('::');
}

function isStaticViewName(name: string): boolean {
  if (
    !name ||
    name.length > 512 ||
    name.includes('/') ||
    name.includes('\\') ||
    [...name].some((character) => character.charCodeAt(0) <= 0x1f)
  )
    return false;
  if (name.startsWith('.') || name.endsWith('.') || name.includes('..')) return false;
  const pieces = name.includes('::') ? name.split('::') : ['', name];
  return (
    pieces.length === 2 &&
    (!pieces[0] || isStaticNamespace(pieces[0])) &&
    pieces[1].split('.').every((part) => /^[A-Za-z0-9_-]+$/u.test(part))
  );
}

function isStaticNamespace(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/u.test(value);
}

function staticPhpString(value: string, quote: string): string | null {
  if (quote === '"' && /\$|\{/.test(value)) return null;
  if (/\\(?![\\'"nrt])/u.test(value)) return null;
  return value.replace(/\\(['"\\])/gu, '$1');
}

function diagnostic(
  code: string,
  message: string,
  filePath: string,
  content: string,
  index: number
): SourceDiagnosticV1 {
  return { code, message, location: sourceLocation(filePath, content, index) };
}

function sourceLocation(filePath: string, content: string, index: number): SourceLocationV1 {
  const before = content.slice(0, Math.max(0, index));
  const lineStart = before.lastIndexOf('\n');
  return { filePath, line: before.split('\n').length, column: index - lineStart - 1 };
}

function maskComments(content: string): string {
  let result = '';
  let index = 0;
  while (index < content.length) {
    if (content.startsWith('//', index) || content[index] === '#') {
      const end = content.indexOf('\n', index);
      const stop = end < 0 ? content.length : end;
      result += ' '.repeat(stop - index);
      index = stop;
    } else if (content.startsWith('/*', index)) {
      const end = content.indexOf('*/', index + 2);
      const stop = end < 0 ? content.length : end + 2;
      result += content.slice(index, stop).replace(/[^\n]/gu, ' ');
      index = stop;
    } else if (content[index] === "'" || content[index] === '"') {
      const quote = content[index];
      const start = index;
      index++;
      while (index < content.length) {
        if (content[index] === '\\') index += 2;
        else if (content[index++] === quote) break;
      }
      result += content.slice(start, index);
    } else {
      result += content[index++];
    }
  }
  return result;
}

function findMatching(content: string, openIndex: number, open: string, close: string): number {
  let depth = 0;
  let quote = '';
  for (let index = openIndex; index < content.length; index++) {
    const char = content[index];
    if (quote) {
      if (char === '\\') index++;
      else if (char === quote) quote = '';
      continue;
    }
    if (content.startsWith('//', index) || char === '#') {
      const end = content.indexOf('\n', index);
      index = end < 0 ? content.length : end;
      continue;
    }
    if (content.startsWith('/*', index)) {
      const end = content.indexOf('*/', index + 2);
      index = end < 0 ? content.length : end + 1;
      continue;
    }
    if (char === "'" || char === '"') quote = char;
    else if (char === open) depth++;
    else if (char === close && --depth === 0) return index;
  }
  return -1;
}
