/**
 * Utility functions for generating YAML frontmatter for markdown files
 */

export interface FrontmatterOptions {
  type?: string;
  subject?: string;
  date?: string;
  participants?: string[];
  [key: string]: unknown;
}

/**
 * Generates YAML frontmatter from options
 * @param options - The frontmatter options
 * @returns Array of frontmatter lines (including opening/closing ---)
 */
function createFrontmatter(options: FrontmatterOptions): string[] {
  const lines = ['---'];

  for (const [key, value] of Object.entries(options)) {
    if (value === undefined) continue;
    if (key === 'participants') continue; // handled separately below
    if (Array.isArray(value)) {
      lines.push(`${key}:`);
      value.forEach((item) => lines.push(`  - ${item}`));
    } else if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      lines.push(`${key}: ${value}`);
    }
  }

  // Add participants if provided
  if (options.participants && options.participants.length > 0) {
    lines.push('participants:');
    options.participants.forEach((p) => lines.push(`  - ${p}`));
  }

  lines.push('---', '');

  return lines;
}

/**
 * Generates complete markdown file content with frontmatter
 * @param options - The frontmatter options
 * @param content - The body content
 * @returns Complete file content with frontmatter and body
 */
export function createMarkdownWithFrontmatter(
  options: FrontmatterOptions,
  content: string
): string {
  const frontmatter = createFrontmatter(options);
  return frontmatter.join('\n') + '\n' + content + '\n';
}
