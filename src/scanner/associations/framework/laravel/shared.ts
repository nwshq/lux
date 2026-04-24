import { fileNodeId, phpSymbolNodeId, type AssociationContext } from '../../types.js';

const PHP_NAMESPACE_RE = /^\s*namespace\s+([A-Za-z_\\][A-Za-z0-9_\\]*)\s*;/m;
const PHP_USE_RE = /^\s*use\s+([^;]+);/gm;
const PHP_CLASS_RE =
  /\b(?:abstract\s+|final\s+)?class\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s+extends\s+([A-Za-z_\\][A-Za-z0-9_\\]*))?[^{}]*\{/g;

export interface LaravelPhpClass {
  name: string;
  qualifiedName: string;
  extendsName?: string;
  extendsQualifiedName?: string;
  body: string;
  line: number;
}

export interface LaravelPhpEntry {
  filePath: string;
  content: string;
  namespace?: string;
  imports: Map<string, string>;
  classes: LaravelPhpClass[];
}

export function getLaravelPhpEntries(context: AssociationContext): LaravelPhpEntry[] {
  return context.entries
    .filter((entry) => entry.languageId === 'php')
    .map((entry) => describeLaravelPhpEntry(entry))
    .filter((entry): entry is LaravelPhpEntry => entry !== null);
}

function describeLaravelPhpEntry(
  entry: AssociationContext['entries'][number]
): LaravelPhpEntry | null {
  const content = (entry.metadata?.content as string | undefined) ?? '';
  if (!content) return null;

  const namespace = PHP_NAMESPACE_RE.exec(content)?.[1];
  const imports = parseUseStatements(content);
  const classes = extractPhpClasses(content, namespace, imports);

  return {
    filePath: entry.filePath,
    content,
    namespace,
    imports,
    classes,
  };
}

function parseUseStatements(content: string): Map<string, string> {
  const imports = new Map<string, string>();
  PHP_USE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = PHP_USE_RE.exec(content)) !== null) {
    const statement = match[1].trim();
    if (statement.startsWith('function ') || statement.startsWith('const ')) continue;

    if (statement.includes('{') && statement.includes('}')) {
      const prefix = statement.slice(0, statement.indexOf('{')).replace(/\\$/, '');
      const members = statement
        .slice(statement.indexOf('{') + 1, statement.lastIndexOf('}'))
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean);
      for (const member of members) {
        const [namePart, aliasPart] = member.split(/\s+as\s+/i);
        const fqcn = `${prefix}\\${namePart.trim().replace(/^\\/, '')}`;
        const alias = (aliasPart?.trim() || shortName(namePart.trim())).replace(/^\\/, '');
        imports.set(alias, fqcn);
      }
      continue;
    }

    const [namePart, aliasPart] = statement.split(/\s+as\s+/i);
    const fqcn = namePart.trim().replace(/^\\/, '');
    const alias = (aliasPart?.trim() || shortName(fqcn)).replace(/^\\/, '');
    imports.set(alias, fqcn);
  }

  return imports;
}

export function resolvePhpClassReference(rawRef: string, entry: LaravelPhpEntry): string {
  const normalized = rawRef
    .trim()
    .replace(/^new\s+/, '')
    .replace(/::class$/, '')
    .replace(/^\\/, '');

  if (!normalized) return normalized;
  if (normalized.includes('\\')) return normalized;

  const imported = entry.imports.get(normalized);
  if (imported) return imported;

  return entry.namespace ? `${entry.namespace}\\${normalized}` : normalized;
}

export function inferStructuralContextId(entry: LaravelPhpEntry): string {
  if (entry.classes.length === 1) {
    return phpSymbolNodeId(entry.classes[0].qualifiedName);
  }

  return fileNodeId(entry.filePath);
}

export function lineNumberAt(content: string, index: number): number {
  return content.slice(0, index).split('\n').length;
}

export function shortName(qualifiedName: string): string {
  const normalized = qualifiedName.replace(/^\\/, '');
  const parts = normalized.split('\\');
  return parts[parts.length - 1] || normalized;
}

export function extractAssignedArray(content: string, propertyName: string): string | null {
  const match = new RegExp(`\\$${propertyName}\\s*=\\s*\\[`, 'm').exec(content);
  if (!match) return null;

  const openIndex = content.indexOf('[', match.index);
  if (openIndex < 0) return null;

  const closeIndex = findMatchingBracket(content, openIndex);
  if (closeIndex < 0) return null;

  return content.slice(openIndex + 1, closeIndex);
}

export function extractStatementSnippet(content: string, startIndex: number): string {
  const endIndex = content.indexOf(';', startIndex);
  if (endIndex < 0) return content.slice(startIndex);
  return content.slice(startIndex, endIndex + 1);
}

function extractPhpClasses(
  content: string,
  namespace: string | undefined,
  imports: Map<string, string>
): LaravelPhpClass[] {
  const classes: LaravelPhpClass[] = [];
  PHP_CLASS_RE.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = PHP_CLASS_RE.exec(content)) !== null) {
    const name = match[1];
    const extendsName = match[2];
    const braceIndex = content.indexOf('{', match.index);
    if (braceIndex < 0) continue;

    const closeIndex = findMatchingBrace(content, braceIndex);
    if (closeIndex < 0) continue;

    const qualifiedName = namespace ? `${namespace}\\${name}` : name;
    const body = content.slice(braceIndex + 1, closeIndex);
    classes.push({
      name,
      qualifiedName,
      extendsName,
      extendsQualifiedName: extendsName
        ? resolvePhpClassReference(extendsName, {
            filePath: '',
            content,
            namespace,
            imports,
            classes: [],
          })
        : undefined,
      body,
      line: lineNumberAt(content, match.index),
    });
  }

  return classes;
}

function findMatchingBrace(content: string, openIndex: number): number {
  let depth = 0;
  for (let index = openIndex; index < content.length; index++) {
    const char = content[index];
    if (char === '{') depth++;
    if (char === '}') {
      depth--;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function findMatchingBracket(content: string, openIndex: number): number {
  let depth = 0;
  for (let index = openIndex; index < content.length; index++) {
    const char = content[index];
    if (char === '[') depth++;
    if (char === ']') {
      depth--;
      if (depth === 0) return index;
    }
  }
  return -1;
}
