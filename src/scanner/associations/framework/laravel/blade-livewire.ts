import type { SourceDiagnosticV1, SourceLocationV1 } from '../../../contracts/program.js';
import type { AssociationContext } from '../../types.js';
import { isSafeRepositoryPath, isStaticComponentName, isVendorPath } from './livewire-facts.js';

export type LivewireMountForm = 'tag-self-closing' | 'tag-open' | 'directive' | 'facade';

export interface BladeLivewireMountFactV1 {
  filePath: string;
  name: string;
  form: LivewireMountForm;
  location: SourceLocationV1;
}

export interface BladeLivewireFactsV1 {
  mounts: BladeLivewireMountFactV1[];
  diagnostics: SourceDiagnosticV1[];
}

/** Extract only literal Livewire mounts from scanned first-party Blade templates. */
export function extractBladeLivewireFacts(context: AssociationContext): BladeLivewireFactsV1 {
  const mounts: BladeLivewireMountFactV1[] = [];
  const diagnostics: SourceDiagnosticV1[] = [];

  for (const entry of [...context.entries].sort((left, right) =>
    left.filePath.localeCompare(right.filePath)
  )) {
    if (!isBladePath(entry.filePath)) continue;
    const content = (entry.metadata?.content as string | undefined) ?? '';
    if (!content) continue;
    const code = maskBladeAndPhpComments(content);
    const occupied = new Set<number>();

    for (const match of code.matchAll(/(?:Livewire\\Volt\\|\bVolt::|@volt\b)/gu)) {
      diagnostics.push({
        code: 'livewire-volt-unsupported',
        message: 'Volt components are outside the deterministic Livewire subset.',
        location: sourceLocation(entry.filePath, content, match.index),
      });
    }

    const tagRe = /<livewire:([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)(\s[^<>]*?)?\s*(\/?)>/giu;
    for (const match of code.matchAll(tagRe)) {
      if (!isStaticComponentName(match[1])) continue;
      occupied.add(match.index);
      mounts.push({
        filePath: entry.filePath,
        name: match[1],
        form: match[3] === '/' ? 'tag-self-closing' : 'tag-open',
        location: sourceLocation(entry.filePath, content, match.index),
      });
    }

    const directiveRe = /@livewire\s*\(\s*(['"])(.*?)\1(?:\s*,|\s*\))/gsu;
    for (const match of code.matchAll(directiveRe)) {
      const name = staticBladeString(match[2], match[1]);
      if (!name || !isStaticComponentName(name)) continue;
      occupied.add(match.index);
      mounts.push({
        filePath: entry.filePath,
        name,
        form: 'directive',
        location: sourceLocation(entry.filePath, content, match.index),
      });
    }

    const facadeRe =
      /(?:\\?Livewire\\Livewire|Livewire)::mount\s*\(\s*(['"])(.*?)\1(?:\s*,|\s*\))/gsu;
    for (const match of code.matchAll(facadeRe)) {
      const name = staticBladeString(match[2], match[1]);
      if (!name || !isStaticComponentName(name)) continue;
      occupied.add(match.index);
      mounts.push({
        filePath: entry.filePath,
        name,
        form: 'facade',
        location: sourceLocation(entry.filePath, content, match.index),
      });
    }

    for (const candidate of code.matchAll(
      /(?:<livewire:|@livewire\s*\(|(?:\\?Livewire\\Livewire|Livewire)::mount\s*\()/giu
    )) {
      if (occupied.has(candidate.index)) continue;
      diagnostics.push({
        code: 'livewire-dynamic-mount',
        message: 'Dynamic or malformed Livewire mount cannot form a deterministic edge.',
        location: sourceLocation(entry.filePath, content, candidate.index),
      });
    }
  }

  mounts.sort((left, right) =>
    `${left.filePath}\0${left.location.line}\0${left.location.column}`.localeCompare(
      `${right.filePath}\0${right.location.line}\0${right.location.column}`
    )
  );
  return { mounts, diagnostics };
}

export function isBladePath(filePath: string): boolean {
  return (
    filePath.endsWith('.blade.php') && isSafeRepositoryPath(filePath) && !isVendorPath(filePath)
  );
}

function staticBladeString(value: string, quote: string): string | null {
  if (quote === '"' && /\$|\{/.test(value)) return null;
  if (/\\(?![\\'"nrt])/u.test(value)) return null;
  return value.replace(/\\(['"\\])/gu, '$1');
}

/** Preserve offsets/newlines while erasing Blade comments and PHP comments. */
function maskBladeAndPhpComments(content: string): string {
  const chars = [...content];
  const erase = (start: number, end: number): void => {
    for (let index = start; index < end; index++) {
      if (chars[index] !== '\n' && chars[index] !== '\r') chars[index] = ' ';
    }
  };

  for (const match of content.matchAll(/\{\{--[\s\S]*?(?:--\}\}|$)/gu)) {
    erase(match.index, match.index + match[0].length);
  }

  const phpRegions = [
    ...content.matchAll(/<\?(?:php|=)?[\s\S]*?(?:\?>|$)/giu),
    ...content.matchAll(/@php\b[\s\S]*?(?:@endphp\b|$)/giu),
  ];
  for (const region of phpRegions) {
    const start = region.index;
    const end = start + region[0].length;
    const value = chars.slice(start, end).join('');
    for (const comment of value.matchAll(/\/\*[\s\S]*?(?:\*\/|$)|\/\/[^\n]*|#[^\n]*/gu)) {
      erase(start + comment.index, start + comment.index + comment[0].length);
    }
  }

  return chars.join('');
}

function sourceLocation(filePath: string, content: string, index: number): SourceLocationV1 {
  const before = content.slice(0, index);
  const lineStart = before.lastIndexOf('\n');
  return {
    filePath,
    line: before.split('\n').length,
    column: index - lineStart - 1,
  };
}
