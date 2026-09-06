import { posix } from 'node:path';

import type { SourceDiagnosticV1, SourceLocationV1 } from '../../../contracts/program.js';
import type { AssociationContext } from '../../types.js';

export type NovaClassKind = 'resource' | 'tool' | 'card' | 'class';
export type NovaRegistrationKind = 'resource' | 'tool';
export type NovaRegistrationForm =
  'resources' | 'resources-method' | 'resources-in' | 'tools' | 'tools-method';

export interface NovaClassFactV1 {
  filePath: string;
  name: string;
  qualifiedName: string;
  parentQualifiedName?: string;
  kind: NovaClassKind;
  modelQualifiedName?: string;
  componentName?: string;
  location: SourceLocationV1;
  modelLocation?: SourceLocationV1;
  componentLocation?: SourceLocationV1;
}

export interface NovaRegistrationFactV1 {
  providerQualifiedName: string;
  targetQualifiedName: string;
  kind: NovaRegistrationKind;
  form: NovaRegistrationForm;
  filePath: string;
  location: SourceLocationV1;
}

export interface NovaAssetFactV1 {
  kind: 'script' | 'style';
  name: string;
  registrationFile: string;
  targetFile: string;
  location: SourceLocationV1;
}

export interface NovaFrontendComponentFactV1 {
  name: string;
  registrationFile: string;
  targetFile: string;
  location: SourceLocationV1;
}

export interface NovaFactsV1 {
  classes: NovaClassFactV1[];
  registrations: NovaRegistrationFactV1[];
  assets: NovaAssetFactV1[];
  frontendComponents: NovaFrontendComponentFactV1[];
  diagnostics: SourceDiagnosticV1[];
}

export interface NovaFactOptionsV1 {
  /** Canonical roots explicitly promoted by the existing first-party mechanism. */
  firstPartyRoots?: readonly string[];
}

interface ParsedClass {
  filePath: string;
  sourceContent: string;
  name: string;
  qualifiedName: string;
  parentQualifiedName?: string;
  body: string;
  bodyOffset: number;
  startOffset: number;
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

interface SourceEntry {
  filePath: string;
  content: string;
}

/**
 * Extract Nova declarations without evaluating PHP or JavaScript. Every
 * reference is accepted only when it resolves to an exact scanned first-party
 * class or file; global basename fallback and package discovery are absent by
 * design.
 */
export function extractNovaFacts(
  context: AssociationContext,
  options: NovaFactOptionsV1 = {}
): NovaFactsV1 {
  const diagnostics: SourceDiagnosticV1[] = [];
  const firstPartyRoots = normalizeFirstPartyRoots(options.firstPartyRoots ?? []);
  const sources = context.entries
    .flatMap((entry): SourceEntry[] => {
      const content = entry.metadata?.content;
      const filePath = normalizeScannedPath(entry.filePath, context.rootPath, firstPartyRoots);
      return typeof content === 'string' && filePath ? [{ filePath, content }] : [];
    })
    .sort((left, right) => left.filePath.localeCompare(right.filePath));
  const sourceFiles = new Set(sources.map((entry) => entry.filePath));
  const phpEntries = sources.filter((entry) => entry.filePath.endsWith('.php')).map(parsePhpEntry);
  const parsedClasses = phpEntries.flatMap((entry) => entry.classes);
  const classByName = new Map(parsedClasses.map((item) => [item.qualifiedName, item]));
  const classKinds = classifyNovaClasses(parsedClasses);

  const classes = parsedClasses
    .map((item): NovaClassFactV1 => {
      const kind = classKinds.get(item.qualifiedName) ?? 'class';
      const model = kind === 'resource' ? extractModel(item, phpEntries, diagnostics) : undefined;
      const component =
        kind === 'tool' || kind === 'card' ? extractComponentName(item, diagnostics) : undefined;
      return {
        filePath: item.filePath,
        name: item.name,
        qualifiedName: item.qualifiedName,
        parentQualifiedName: item.parentQualifiedName,
        kind,
        modelQualifiedName: model?.qualifiedName,
        componentName: component?.name,
        location: item.location,
        modelLocation: model?.location,
        componentLocation: component?.location,
      };
    })
    .sort((left, right) => left.qualifiedName.localeCompare(right.qualifiedName));
  const novaClasses = new Map(classes.map((item) => [item.qualifiedName, item]));

  const registrations = phpEntries
    .flatMap((entry) =>
      extractRegistrations(entry, novaClasses, classByName, sourceFiles, diagnostics)
    )
    .sort(registrationOrder);
  const assets = phpEntries
    .flatMap((entry) => extractAssets(entry, sourceFiles, diagnostics))
    .sort((left, right) =>
      `${left.registrationFile}\0${left.kind}\0${left.name}`.localeCompare(
        `${right.registrationFile}\0${right.kind}\0${right.name}`
      )
    );
  const frontendComponents = sources
    .filter((entry) => /\.(?:[cm]?[jt]sx?)$/u.test(entry.filePath))
    .flatMap((entry) => extractFrontendComponents(entry, sourceFiles, diagnostics))
    .sort((left, right) =>
      `${left.name}\0${left.registrationFile}\0${left.targetFile}`.localeCompare(
        `${right.name}\0${right.registrationFile}\0${right.targetFile}`
      )
    );

  return { classes, registrations, assets, frontendComponents, diagnostics };
}

function isSafeNovaPath(filePath: string): boolean {
  if (!filePath || filePath.includes('\0') || filePath.includes('\\')) return false;
  if (filePath.startsWith('/') || /^[A-Za-z]:/u.test(filePath)) return false;
  return !filePath.split('/').some((part) => part === '' || part === '.' || part === '..');
}

function isNovaVendorPath(filePath: string): boolean {
  const parts = filePath.split('/');
  return parts.includes('vendor') || parts.includes('node_modules');
}

function normalizeFirstPartyRoots(roots: readonly string[]): string[] {
  return roots
    .map((root) => root.replaceAll('\\', '/').replace(/\/$/u, ''))
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
}

function normalizeScannedPath(
  filePath: string,
  repositoryRoot: string,
  firstPartyRoots: readonly string[]
): string | null {
  const unix = filePath.replaceAll('\\', '/');
  const root = repositoryRoot.replaceAll('\\', '/').replace(/\/$/u, '');
  let normalized = unix.startsWith(`${root}/`) ? unix.slice(root.length + 1) : unix;
  let explicitlyPromoted = false;
  for (const promoted of firstPartyRoots) {
    if (unix === promoted || unix.startsWith(`${promoted}/`)) {
      normalized = unix.slice(promoted.length).replace(/^\//u, '');
      explicitlyPromoted = true;
      break;
    }
  }
  normalized = posix.normalize(normalized).replace(/^\.\//u, '');
  if (!isSafeNovaPath(normalized)) return null;
  if (isNovaVendorPath(normalized) && !explicitlyPromoted) return null;
  return normalized;
}

function parsePhpEntry(source: SourceEntry): PhpEntry {
  const code = maskComments(source.content);
  const namespace = /\bnamespace\s+([A-Za-z_\\][A-Za-z0-9_\\]*)\s*;/u.exec(code)?.[1];
  const imports = parseImports(code);
  const partial: Omit<PhpEntry, 'classes'> = {
    filePath: source.filePath,
    content: source.content,
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
  const [reference, alias] = statement.split(/\s+as\s+/iu);
  const qualified = reference.trim().replace(/^\\/u, '');
  const local = alias?.trim() || qualified.split('\\').pop();
  if (qualified && local) imports.set(local, qualified);
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
      startOffset: match.index,
      location: sourceLocation(entry.filePath, entry.content, match.index),
    });
  }
  return classes;
}

function resolveClassReference(
  raw: string,
  entry: Pick<PhpEntry, 'namespace' | 'imports'>
): string {
  const reference = raw.trim().replace(/^\\/u, '');
  const separator = reference.indexOf('\\');
  const head = separator < 0 ? reference : reference.slice(0, separator);
  const imported = entry.imports.get(head);
  if (imported) return separator < 0 ? imported : `${imported}${reference.slice(separator)}`;
  if (raw.startsWith('\\') || reference.includes('\\')) return reference;
  return entry.namespace ? `${entry.namespace}\\${reference}` : reference;
}

function classifyNovaClasses(classes: readonly ParsedClass[]): Map<string, NovaClassKind> {
  const result = new Map<string, NovaClassKind>();
  const bases = new Map<string, NovaClassKind>([
    ['Laravel\\Nova\\Resource', 'resource'],
    ['Laravel\\Nova\\Tool', 'tool'],
    ['Laravel\\Nova\\Card', 'card'],
  ]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of classes) {
      if (result.has(item.qualifiedName) || !item.parentQualifiedName) continue;
      const kind = bases.get(item.parentQualifiedName) ?? result.get(item.parentQualifiedName);
      if (kind) {
        result.set(item.qualifiedName, kind);
        changed = true;
      }
    }
  }
  return result;
}

function extractModel(
  item: ParsedClass,
  entries: readonly PhpEntry[],
  diagnostics: SourceDiagnosticV1[]
): { qualifiedName: string; location: SourceLocationV1 } | undefined {
  const entry = entries.find((candidate) => candidate.filePath === item.filePath);
  if (!entry) return undefined;
  const code = maskComments(item.body);
  const assignment =
    /\bstatic\s+(?:\??[A-Za-z_\\][A-Za-z0-9_\\|?]*\s+)?\$model\s*=\s*([^;]+);/gu.exec(code);
  if (!assignment) return undefined;
  const classReference = /^\s*([A-Za-z_\\][A-Za-z0-9_\\]*)::class\s*$/u.exec(assignment[1]);
  const location = sourceLocation(
    item.filePath,
    item.sourceContent,
    item.bodyOffset + assignment.index
  );
  if (!classReference) {
    diagnostics.push({
      code: 'nova-dynamic-model',
      message: 'Nova resource model must be one literal class constant.',
      location,
    });
    return undefined;
  }
  return { qualifiedName: resolveClassReference(classReference[1], entry), location };
}

function extractComponentName(
  item: ParsedClass,
  diagnostics: SourceDiagnosticV1[]
): { name: string; location: SourceLocationV1 } | undefined {
  const code = maskComments(item.body);
  const property = /\$(?:component)\s*=\s*(['"])(.*?)\1\s*;/su.exec(code);
  if (property) {
    const name = staticPhpString(property[2], property[1]);
    const location = sourceLocation(
      item.filePath,
      item.sourceContent,
      item.bodyOffset + property.index
    );
    if (name && isStaticNovaName(name)) return { name, location };
    diagnostics.push({
      code: 'nova-dynamic-component',
      message: 'Nova tool/card component property must be a safe literal name.',
      location,
    });
    return undefined;
  }
  const method = extractMethod(item, 'component');
  if (!method) return undefined;
  const returned = /^\s*return\s+(['"])(.*?)\1\s*;\s*$/su.exec(maskComments(method.content));
  const location = sourceLocation(item.filePath, item.sourceContent, method.absoluteOffset);
  const name = returned ? staticPhpString(returned[2], returned[1]) : null;
  if (name && isStaticNovaName(name)) return { name, location };
  diagnostics.push({
    code: 'nova-dynamic-component',
    message: 'Nova tool/card component method must return one safe literal name.',
    location,
  });
  return undefined;
}

function extractRegistrations(
  entry: PhpEntry,
  classes: ReadonlyMap<string, NovaClassFactV1>,
  parsedClasses: ReadonlyMap<string, ParsedClass>,
  sourceFiles: ReadonlySet<string>,
  diagnostics: SourceDiagnosticV1[]
): NovaRegistrationFactV1[] {
  const facts: NovaRegistrationFactV1[] = [];
  for (const owner of entry.classes) {
    const ownerCode = maskComments(owner.body);
    for (const call of findStaticNovaCalls(owner.body, ownerCode, entry)) {
      const location = sourceLocation(entry.filePath, entry.content, owner.bodyOffset + call.index);
      if (call.method === 'resourcesIn') {
        const literal = singleLiteralArgument(call.arguments);
        const directory = literal
          ? resolveRepositoryPath(literal, entry.filePath, sourceFiles)
          : null;
        if (!directory || isNovaVendorPath(directory)) {
          diagnostics.push({
            code: 'nova-resources-in-invalid',
            message: 'Nova resourcesIn requires one confined first-party literal directory.',
            location,
          });
          continue;
        }
        const matches = [...classes.values()].filter(
          (candidate) =>
            candidate.kind === 'resource' && candidate.filePath.startsWith(`${directory}/`)
        );
        if (matches.length === 0) {
          diagnostics.push({
            code: 'nova-resources-in-empty',
            message: 'Nova resourcesIn directory contains no scanned resource classes.',
            location,
          });
        }
        for (const target of matches) {
          facts.push({
            providerQualifiedName: owner.qualifiedName,
            targetQualifiedName: target.qualifiedName,
            kind: 'resource',
            form: 'resources-in',
            filePath: entry.filePath,
            location,
          });
        }
        continue;
      }
      if (call.method !== 'resources' && call.method !== 'tools') continue;
      const kind: NovaRegistrationKind = call.method === 'resources' ? 'resource' : 'tool';
      const targets = parseLiteralClassArray(call.arguments, entry, kind === 'tool');
      if (!targets) {
        diagnostics.push({
          code: 'nova-dynamic-registration',
          message: `Nova ${call.method} registration must contain one literal class array.`,
          location,
        });
        continue;
      }
      appendVerifiedRegistrations(
        facts,
        targets,
        owner,
        kind,
        call.method,
        location,
        classes,
        diagnostics
      );
    }

    for (const methodName of ['resources', 'tools'] as const) {
      const method = extractMethod(owner, methodName);
      if (!method) continue;
      const returned = /^\s*return\s+(\[[\s\S]*\])\s*;\s*$/u.exec(maskComments(method.content));
      const location = sourceLocation(entry.filePath, entry.content, method.absoluteOffset);
      const kind: NovaRegistrationKind = methodName === 'resources' ? 'resource' : 'tool';
      const targets = returned ? parseLiteralClassArray(returned[1], entry, kind === 'tool') : null;
      if (!targets) {
        diagnostics.push({
          code: 'nova-dynamic-provider-method',
          message: `Nova provider ${methodName}() must return one literal class array.`,
          location,
        });
        continue;
      }
      appendVerifiedRegistrations(
        facts,
        targets,
        owner,
        kind,
        `${methodName}-method`,
        location,
        classes,
        diagnostics
      );
    }
  }

  // A class can be syntactically valid but absent from the scanned class index;
  // retaining this explicit check documents that no autoloading occurs.
  return facts.filter(
    (fact) => parsedClasses.has(fact.providerQualifiedName) && classes.has(fact.targetQualifiedName)
  );
}

function appendVerifiedRegistrations(
  facts: NovaRegistrationFactV1[],
  targets: readonly string[],
  owner: ParsedClass,
  kind: NovaRegistrationKind,
  form: NovaRegistrationForm,
  location: SourceLocationV1,
  classes: ReadonlyMap<string, NovaClassFactV1>,
  diagnostics: SourceDiagnosticV1[]
): void {
  for (const targetName of targets) {
    const target = classes.get(targetName);
    const valid =
      target && (kind === 'resource' ? target.kind === 'resource' : target.kind === 'tool');
    if (!valid) {
      diagnostics.push({
        code: 'nova-registration-target-missing',
        message: `Nova ${kind} registration does not target an exact scanned ${kind} class.`,
        location,
      });
      continue;
    }
    facts.push({
      providerQualifiedName: owner.qualifiedName,
      targetQualifiedName: targetName,
      kind,
      form,
      filePath: owner.filePath,
      location,
    });
  }
}

function extractAssets(
  entry: PhpEntry,
  sourceFiles: ReadonlySet<string>,
  diagnostics: SourceDiagnosticV1[]
): NovaAssetFactV1[] {
  const assets: NovaAssetFactV1[] = [];
  for (const owner of entry.classes) {
    const code = maskComments(owner.body);
    for (const call of findStaticNovaCalls(owner.body, code, entry)) {
      if (call.method !== 'script' && call.method !== 'style') continue;
      const location = sourceLocation(entry.filePath, entry.content, owner.bodyOffset + call.index);
      const args = splitArguments(call.arguments);
      const name = args.length === 2 ? literalPhpExpression(args[0]) : null;
      const targetFile = args.length === 2 ? reduceStaticPath(args[1], entry.filePath) : null;
      if (
        !name ||
        !isStaticNovaName(name) ||
        !targetFile ||
        !sourceFiles.has(targetFile) ||
        isNovaVendorPath(targetFile)
      ) {
        diagnostics.push({
          code: 'nova-asset-invalid',
          message: `Nova ${call.method} requires a safe literal name and exact scanned first-party path.`,
          location,
        });
        continue;
      }
      assets.push({
        kind: call.method,
        name,
        registrationFile: entry.filePath,
        targetFile,
        location,
      });
    }
  }
  return assets;
}

function extractFrontendComponents(
  entry: SourceEntry,
  sourceFiles: ReadonlySet<string>,
  diagnostics: SourceDiagnosticV1[]
): NovaFrontendComponentFactV1[] {
  const code = maskJsComments(entry.content);
  const imports = new Map<string, string>();
  for (const match of code.matchAll(
    /\bimport\s+([A-Za-z_$][\w$]*)\s+from\s+(['"])(.*?)\2\s*;?/gu
  )) {
    const target = resolveFrontendPath(entry.filePath, match[3], sourceFiles);
    if (target) imports.set(match[1], target);
  }

  const facts: NovaFrontendComponentFactV1[] = [];
  const componentRe = /\b(?:app|Nova)\.component\s*\(/gu;
  for (const match of code.matchAll(componentRe)) {
    const open = match.index + match[0].lastIndexOf('(');
    const close = findMatching(entry.content, open, '(', ')');
    if (close < 0) continue;
    const args = splitArguments(entry.content.slice(open + 1, close));
    const name = args.length === 2 ? literalPhpExpression(args[0]) : null;
    let targetFile: string | null = null;
    if (args.length === 2) {
      const require = /^\s*require\s*\(\s*(['"])(.*?)\1\s*\)(?:\.default)?\s*$/su.exec(args[1]);
      if (require) targetFile = resolveFrontendPath(entry.filePath, require[2], sourceFiles);
      else {
        const identifier = /^\s*([A-Za-z_$][\w$]*)\s*$/u.exec(args[1])?.[1];
        if (identifier) targetFile = imports.get(identifier) ?? null;
      }
    }
    const location = sourceLocation(entry.filePath, entry.content, match.index);
    if (!name || !isStaticNovaName(name) || !targetFile || !targetFile.endsWith('.vue')) {
      diagnostics.push({
        code: 'nova-component-entrypoint-invalid',
        message: 'Nova component registration must name an exact imported or required Vue SFC.',
        location,
      });
      continue;
    }
    facts.push({ name, registrationFile: entry.filePath, targetFile, location });
  }
  return facts;
}

function findStaticNovaCalls(
  content: string,
  code: string,
  entry: Pick<PhpEntry, 'imports'>
): Array<{ method: string; arguments: string; index: number }> {
  const calls: Array<{ method: string; arguments: string; index: number }> = [];
  const re = /([A-Za-z_\\][A-Za-z0-9_\\]*)::(resourcesIn|resources|tools|script|style)\s*\(/gu;
  for (const match of code.matchAll(re)) {
    if (resolveClassReference(match[1], { imports: entry.imports }) !== 'Laravel\\Nova\\Nova') {
      continue;
    }
    const open = match.index + match[0].lastIndexOf('(');
    const close = findMatching(content, open, '(', ')');
    if (close >= 0) {
      calls.push({
        method: match[2],
        arguments: content.slice(open + 1, close),
        index: match.index,
      });
    }
  }
  return calls;
}

function parseLiteralClassArray(
  expression: string,
  entry: PhpEntry,
  allowNew: boolean
): string[] | null {
  const trimmed = expression.trim();
  if (!trimmed.startsWith('[')) return null;
  const close = findMatching(trimmed, 0, '[', ']');
  if (close !== trimmed.length - 1) return null;
  const body = trimmed.slice(1, -1);
  if (!body.trim()) return [];
  const targets: string[] = [];
  for (const member of splitArguments(body)) {
    const classConstant = /^\s*([A-Za-z_\\][A-Za-z0-9_\\]*)::class\s*$/u.exec(member);
    const constructed = allowNew
      ? /^\s*new\s+([A-Za-z_\\][A-Za-z0-9_\\]*)\s*(?:\(\s*\))?\s*$/u.exec(member)
      : null;
    const reference = classConstant?.[1] ?? constructed?.[1];
    if (!reference) return null;
    targets.push(resolveClassReference(reference, entry));
  }
  return targets;
}

function extractMethod(
  item: ParsedClass,
  methodName: string
): { content: string; absoluteOffset: number } | null {
  const re = new RegExp(`\\bfunction\\s+${methodName}\\s*\\([^)]*\\)[^{;]*\\{`, 'u');
  const match = re.exec(maskComments(item.body));
  if (!match) return null;
  const open = match.index + match[0].lastIndexOf('{');
  const close = findMatching(item.body, open, '{', '}');
  return close < 0
    ? null
    : { content: item.body.slice(open + 1, close), absoluteOffset: item.bodyOffset + open + 1 };
}

function singleLiteralArgument(value: string): string | null {
  const args = splitArguments(value);
  return args.length === 1 ? literalPhpExpression(args[0]) : null;
}

function literalPhpExpression(value: string): string | null {
  const match = /^\s*(['"])([\s\S]*?)\1\s*$/u.exec(value);
  return match ? staticPhpString(match[2], match[1]) : null;
}

function staticPhpString(value: string, quote: string): string | null {
  if (quote === '"' && /\$|\{/u.test(value)) return null;
  if (/\\(?![\\'"nrt])/u.test(value)) return null;
  return value.replace(/\\(['"\\])/gu, '$1');
}

function isStaticNovaName(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/u.test(value) && !value.includes('..');
}

function resolveRepositoryPath(
  literal: string,
  registrationFile: string,
  sourceFiles: ReadonlySet<string>
): string | null {
  if (!literal || literal.includes('\0') || literal.includes('\\') || literal.startsWith('/')) {
    return null;
  }
  const normalized = posix.normalize(literal).replace(/^\.\//u, '').replace(/\/$/u, '');
  if (!isSafeNovaPath(normalized)) return null;
  if ([...sourceFiles].some((file) => file.startsWith(`${normalized}/`))) return normalized;
  const relative = posix.normalize(posix.join(posix.dirname(registrationFile), literal));
  return isSafeNovaPath(relative) &&
    [...sourceFiles].some((file) => file.startsWith(`${relative}/`))
    ? relative
    : null;
}

function reduceStaticPath(expression: string, registrationFile: string): string | null {
  const direct = literalPhpExpression(expression);
  if (direct !== null) return normalizeDirectPath(direct);
  const helper = /^\s*(base_path|app_path|resource_path)\s*\(\s*(['"])(.*?)\2\s*\)\s*$/su.exec(
    expression
  );
  if (helper) {
    const literal = staticPhpString(helper[3], helper[2]);
    const prefix = helper[1] === 'base_path' ? '' : helper[1] === 'app_path' ? 'app' : 'resources';
    return literal === null ? null : confinedJoin(prefix, literal);
  }
  const directory = /^\s*__DIR__((?:\s*\.\s*(['"])(.*?)\2\s*)+)$/su.exec(expression);
  if (!directory) return null;
  let suffix = '';
  for (const part of directory[1].matchAll(/\.\s*(['"])(.*?)\1/gsu)) {
    const literal = staticPhpString(part[2], part[1]);
    if (literal === null) return null;
    suffix += literal;
  }
  return confinedJoin(posix.dirname(registrationFile), suffix);
}

function normalizeDirectPath(value: string): string | null {
  if (!value || value.includes('\0') || value.includes('\\') || value.startsWith('/')) return null;
  if (value.split('/').includes('..')) return null;
  const normalized = posix.normalize(value).replace(/^\.\//u, '');
  return isSafeNovaPath(normalized) ? normalized : null;
}

function confinedJoin(base: string, suffix: string): string | null {
  if (suffix.includes('\0') || suffix.includes('\\') || suffix.startsWith('/')) return null;
  const normalized = posix.normalize(posix.join(base, suffix)).replace(/^\.\//u, '');
  return isSafeNovaPath(normalized) ? normalized : null;
}

function resolveFrontendPath(
  registrationFile: string,
  reference: string,
  sourceFiles: ReadonlySet<string>
): string | null {
  if (!reference.startsWith('./') && !reference.startsWith('../')) return null;
  const base = posix.normalize(posix.join(posix.dirname(registrationFile), reference));
  if (!isSafeNovaPath(base) || isNovaVendorPath(base)) return null;
  const candidates = [base, `${base}.vue`, `${base}/index.vue`].filter((path) =>
    sourceFiles.has(path)
  );
  return candidates.length === 1 ? candidates[0] : null;
}

function splitArguments(value: string): string[] {
  const result: string[] = [];
  let start = 0;
  let depth = 0;
  let quote = '';
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (quote) {
      if (character === '\\') index += 1;
      else if (character === quote) quote = '';
    } else if (character === "'" || character === '"' || character === '`') quote = character;
    else if ('([{'.includes(character)) depth += 1;
    else if (')]}'.includes(character)) depth -= 1;
    else if (character === ',' && depth === 0) {
      result.push(value.slice(start, index));
      start = index + 1;
    }
  }
  result.push(value.slice(start));
  return result.filter((part) => part.trim() !== '');
}

function registrationOrder(left: NovaRegistrationFactV1, right: NovaRegistrationFactV1): number {
  return `${left.providerQualifiedName}\0${left.targetQualifiedName}\0${left.form}`.localeCompare(
    `${right.providerQualifiedName}\0${right.targetQualifiedName}\0${right.form}`
  );
}

function sourceLocation(filePath: string, content: string, index: number): SourceLocationV1 {
  const before = content.slice(0, Math.max(0, index));
  const lineStart = before.lastIndexOf('\n');
  return { filePath, line: before.split('\n').length, column: index - lineStart - 1 };
}

function maskComments(content: string): string {
  return maskDelimitedComments(content, false);
}

function maskJsComments(content: string): string {
  return maskDelimitedComments(content, true);
}

function maskDelimitedComments(content: string, backticks: boolean): string {
  let result = '';
  let index = 0;
  while (index < content.length) {
    if (content.startsWith('//', index) || (!backticks && content[index] === '#')) {
      const end = content.indexOf('\n', index);
      const stop = end < 0 ? content.length : end;
      result += ' '.repeat(stop - index);
      index = stop;
    } else if (content.startsWith('/*', index)) {
      const end = content.indexOf('*/', index + 2);
      const stop = end < 0 ? content.length : end + 2;
      result += content.slice(index, stop).replace(/[^\n]/gu, ' ');
      index = stop;
    } else if (
      content[index] === "'" ||
      content[index] === '"' ||
      (backticks && content[index] === '`')
    ) {
      const quote = content[index];
      const start = index;
      index += 1;
      while (index < content.length) {
        if (content[index] === '\\') index += 2;
        else if (content[index++] === quote) break;
      }
      result += content.slice(start, index);
    } else result += content[index++];
  }
  return result;
}

function findMatching(content: string, openIndex: number, open: string, close: string): number {
  let depth = 0;
  let quote = '';
  for (let index = openIndex; index < content.length; index++) {
    const character = content[index];
    if (quote) {
      if (character === '\\') index += 1;
      else if (character === quote) quote = '';
      continue;
    }
    if (content.startsWith('//', index) || character === '#') {
      const end = content.indexOf('\n', index);
      index = end < 0 ? content.length : end;
      continue;
    }
    if (content.startsWith('/*', index)) {
      const end = content.indexOf('*/', index + 2);
      index = end < 0 ? content.length : end + 1;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') quote = character;
    else if (character === open) depth += 1;
    else if (character === close && --depth === 0) return index;
  }
  return -1;
}
