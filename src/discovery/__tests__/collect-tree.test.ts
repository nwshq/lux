import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join, basename } from 'path';
import { tmpdir } from 'os';
import {
  collectTree,
  DISCOVERY_TREE_DEPTH,
  DISCOVERY_TREE_ENTRIES,
  IGNORE_DIRS,
} from '../collect-tree.js';

// ── Test Setup ────────────────────────────────────────────

let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `lux-collect-tree-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

// ══════════════════════════════════════════════════════════════
// Constants
// ══════════════════════════════════════════════════════════════

describe('collect-tree constants', () => {
  it('has higher depth than init (8 vs 5)', () => {
    expect(DISCOVERY_TREE_DEPTH).toBe(8);
  });

  it('has higher entry limit than init (500 vs 200)', () => {
    expect(DISCOVERY_TREE_ENTRIES).toBe(500);
  });

  it('ignores standard noise directories', () => {
    const expected = [
      '.git',
      '.svn',
      '.hg',
      'node_modules',
      'vendor',
      'dist',
      'build',
      '.next',
      '__pycache__',
      '.cache',
      '.venv',
      'venv',
      'target',
    ];
    for (const dir of expected) {
      expect(IGNORE_DIRS.has(dir)).toBe(true);
    }
  });
});

// ══════════════════════════════════════════════════════════════
// Basic tree output
// ══════════════════════════════════════════════════════════════

describe('collectTree: basic output', () => {
  it('returns root name for an empty directory', () => {
    const tree = collectTree(testDir);
    expect(tree.trim()).toBe(`${basename(testDir)}/`);
  });

  it('starts with the root directory name', () => {
    mkdirSync(join(testDir, 'src'));
    const tree = collectTree(testDir);
    expect(tree.startsWith(`${basename(testDir)}/`)).toBe(true);
  });

  it('lists subdirectories with trailing slashes', () => {
    mkdirSync(join(testDir, 'src'));
    mkdirSync(join(testDir, 'lib'));
    const tree = collectTree(testDir);
    expect(tree).toContain('src/');
    expect(tree).toContain('lib/');
  });

  it('lists files without trailing slashes', () => {
    writeFileSync(join(testDir, 'index.ts'), '');
    const tree = collectTree(testDir);
    expect(tree).toContain('index.ts');
    expect(tree).not.toContain('index.ts/');
  });

  it('shows nested contents', () => {
    mkdirSync(join(testDir, 'src', 'utils'), { recursive: true });
    writeFileSync(join(testDir, 'src', 'utils', 'helper.ts'), '');
    const tree = collectTree(testDir);
    expect(tree).toContain('src/');
    expect(tree).toContain('utils/');
    expect(tree).toContain('helper.ts');
  });

  it('sorts entries alphabetically', () => {
    writeFileSync(join(testDir, 'z-file.ts'), '');
    writeFileSync(join(testDir, 'a-file.ts'), '');
    mkdirSync(join(testDir, 'm-dir'));
    const tree = collectTree(testDir);
    const aPos = tree.indexOf('a-file.ts');
    const mPos = tree.indexOf('m-dir/');
    const zPos = tree.indexOf('z-file.ts');
    expect(aPos).toBeLessThan(mPos);
    expect(mPos).toBeLessThan(zPos);
  });

  it('uses tree connectors (├── and └──)', () => {
    mkdirSync(join(testDir, 'alpha'));
    mkdirSync(join(testDir, 'beta'));
    const tree = collectTree(testDir);
    expect(tree).toContain('├──');
    expect(tree).toContain('└──');
  });
});

// ══════════════════════════════════════════════════════════════
// Filtering
// ══════════════════════════════════════════════════════════════

describe('collectTree: filtering', () => {
  it('ignores hidden files and directories', () => {
    mkdirSync(join(testDir, '.hidden'));
    writeFileSync(join(testDir, '.env'), '');
    mkdirSync(join(testDir, 'visible'));
    const tree = collectTree(testDir);
    expect(tree).not.toContain('.hidden');
    expect(tree).not.toContain('.env');
    expect(tree).toContain('visible/');
  });

  it.each([...IGNORE_DIRS].filter((d) => !d.startsWith('.')))('ignores %s directory', (dirName) => {
    mkdirSync(join(testDir, dirName), { recursive: true });
    mkdirSync(join(testDir, 'keep'));
    const tree = collectTree(testDir);
    expect(tree).not.toContain(dirName);
    expect(tree).toContain('keep/');
  });
});

// ══════════════════════════════════════════════════════════════
// Configurable depth limits
// ══════════════════════════════════════════════════════════════

describe('collectTree: depth limits', () => {
  function createDeepNesting(base: string, levels: number): void {
    let current = base;
    for (let i = 1; i <= levels; i++) {
      current = join(current, `level-${i}`);
      mkdirSync(current, { recursive: true });
    }
    writeFileSync(join(current, 'leaf.txt'), '');
  }

  it('respects maxDepth option', () => {
    createDeepNesting(testDir, 5);
    const tree = collectTree(testDir, { maxDepth: 2 });
    expect(tree).toContain('level-1/');
    expect(tree).toContain('level-2/');
    // level-3 contents should not appear
    expect(tree).not.toContain('level-3/');
  });

  it('uses DISCOVERY_TREE_DEPTH by default (8 levels deep)', () => {
    createDeepNesting(testDir, 10);
    const tree = collectTree(testDir);
    expect(tree).toContain('level-8/');
    // Depth 9 is beyond default limit
    expect(tree).not.toContain('level-9/');
  });

  it('allows maxDepth: 1 to show only top-level entries', () => {
    mkdirSync(join(testDir, 'top', 'nested'), { recursive: true });
    const tree = collectTree(testDir, { maxDepth: 1 });
    expect(tree).toContain('top/');
    expect(tree).not.toContain('nested/');
  });

  it('handles maxDepth: 0 gracefully (root only)', () => {
    mkdirSync(join(testDir, 'src'));
    const tree = collectTree(testDir, { maxDepth: 0 });
    // The root itself is always shown; children at depth 1 are not
    expect(tree.trim()).toBe(`${basename(testDir)}/`);
  });
});

// ══════════════════════════════════════════════════════════════
// Configurable entry limits
// ══════════════════════════════════════════════════════════════

describe('collectTree: entry limits', () => {
  it('respects maxEntries option', () => {
    // Create more entries than the limit
    for (let i = 0; i < 10; i++) {
      writeFileSync(join(testDir, `file-${String(i).padStart(2, '0')}.txt`), '');
    }
    // maxEntries includes the root, so maxEntries:5 means root + 4 entries
    const tree = collectTree(testDir, { maxEntries: 5 });
    const lines = tree.split('\n');
    // Should have truncation indicator
    expect(tree).toContain('... (truncated)');
    // Should not list all 10 files
    expect(lines.length).toBeLessThan(12);
  });

  it('uses DISCOVERY_TREE_ENTRIES by default (500)', () => {
    // Create a moderate structure — verify it does not truncate
    for (let i = 0; i < 20; i++) {
      writeFileSync(join(testDir, `file-${i}.txt`), '');
    }
    const tree = collectTree(testDir);
    expect(tree).not.toContain('... (truncated)');
  });

  it('shows truncation message when limit is hit', () => {
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(testDir, `f${i}.txt`), '');
    }
    // Root counts as 1, so maxEntries:3 allows root + 2 entries
    const tree = collectTree(testDir, { maxEntries: 3 });
    expect(tree).toContain('... (truncated)');
  });

  it('counts nested entries toward the limit', () => {
    mkdirSync(join(testDir, 'a', 'b', 'c'), { recursive: true });
    writeFileSync(join(testDir, 'a', 'b', 'c', 'deep.txt'), '');
    writeFileSync(join(testDir, 'a', 'b', 'sibling.txt'), '');
    // root(1) + a(2) + b(3) + c(4) = allows 4 dir entries, limit at 5
    const tree = collectTree(testDir, { maxEntries: 5 });
    expect(tree).toContain('a/');
    expect(tree).toContain('b/');
    expect(tree).toContain('c/');
    // At this point entryCount=4, one more allowed
    // c's contents: deep.txt would be entry 5 — allowed
    expect(tree).toContain('deep.txt');
  });
});

// ══════════════════════════════════════════════════════════════
// Edge cases
// ══════════════════════════════════════════════════════════════

describe('collectTree: edge cases', () => {
  it('handles Unicode directory names', () => {
    mkdirSync(join(testDir, 'données'));
    mkdirSync(join(testDir, '日本語'));
    const tree = collectTree(testDir);
    expect(tree).toContain('données/');
    expect(tree).toContain('日本語/');
  });

  it('handles directories with only ignored entries', () => {
    mkdirSync(join(testDir, 'node_modules'));
    mkdirSync(join(testDir, '.git'));
    const tree = collectTree(testDir);
    expect(tree.trim()).toBe(`${basename(testDir)}/`);
  });

  it('both maxDepth and maxEntries can be set together', () => {
    for (let i = 0; i < 3; i++) {
      const dir = join(testDir, `dir-${i}`);
      mkdirSync(dir);
      for (let j = 0; j < 3; j++) {
        mkdirSync(join(dir, `sub-${j}`));
      }
    }
    const tree = collectTree(testDir, { maxDepth: 1, maxEntries: 100 });
    expect(tree).toContain('dir-0/');
    expect(tree).not.toContain('sub-0/');
  });

  it('returns consistent output for the same input', () => {
    mkdirSync(join(testDir, 'alpha'));
    mkdirSync(join(testDir, 'beta'));
    writeFileSync(join(testDir, 'gamma.txt'), '');
    const tree1 = collectTree(testDir);
    const tree2 = collectTree(testDir);
    expect(tree1).toBe(tree2);
  });
});
