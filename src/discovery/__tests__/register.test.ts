import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { LuxDatabase } from '../../db/index.js';
import { register, generateClaudeMdStub, detectClaudeMd } from '../register.js';
import type { ProposedExpert, DiscoveryOptions } from '../types.js';

// ── Fixtures ──────────────────────────────────────────────

function makeProposal(overrides: Partial<ProposedExpert> = {}): ProposedExpert {
  return {
    slug: 'invoicing',
    name: 'Invoicing System',
    mountPath: 'modules/Invoicing/',
    description: 'Manages invoice creation and payment tracking.',
    reasoning: 'High file count and clear domain boundary.',
    confidence: 0.92,
    ...overrides,
  };
}

// ── Test Setup ────────────────────────────────────────────

let contentDir: string;
let dbDir: string;
let db: LuxDatabase;
let baseOptions: DiscoveryOptions;

beforeEach(() => {
  contentDir = join(
    tmpdir(),
    `lux-register-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  dbDir = join(tmpdir(), `lux-register-db-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(contentDir, { recursive: true });
  mkdirSync(dbDir, { recursive: true });
  db = new LuxDatabase(join(dbDir, 'test.db'));
  baseOptions = { rootPath: contentDir };
});

afterEach(() => {
  db.close();
  rmSync(contentDir, { recursive: true, force: true });
  rmSync(dbDir, { recursive: true, force: true });
});

// ══════════════════════════════════════════════════════════════
// generateClaudeMdStub
// ══════════════════════════════════════════════════════════════

describe('generateClaudeMdStub', () => {
  it('includes the expert name in frontmatter domain', () => {
    const stub = generateClaudeMdStub('Invoicing System', 'Handles invoices.');
    expect(stub).toContain('domain: Invoicing System');
  });

  it('includes the expert name as heading', () => {
    const stub = generateClaudeMdStub('Auth Service', 'Handles authentication.');
    expect(stub).toContain('# Auth Service');
  });

  it('includes the description', () => {
    const stub = generateClaudeMdStub('Test', 'This is the description.');
    expect(stub).toContain('This is the description.');
  });

  it('includes frontmatter with role: expert', () => {
    const stub = generateClaudeMdStub('Test', 'Desc.');
    expect(stub).toContain('role: expert');
  });

  it('includes Responsibilities section', () => {
    const stub = generateClaudeMdStub('Test', 'Desc.');
    expect(stub).toContain('## Responsibilities');
  });

  it('includes Key Concepts section', () => {
    const stub = generateClaudeMdStub('Test', 'Desc.');
    expect(stub).toContain('## Key Concepts');
  });

  it('has valid YAML frontmatter delimiters', () => {
    const stub = generateClaudeMdStub('Test', 'Desc.');
    expect(stub.startsWith('---\n')).toBe(true);
    expect(stub).toContain('\n---\n');
  });
});

// ══════════════════════════════════════════════════════════════
// detectClaudeMd
// ══════════════════════════════════════════════════════════════

describe('detectClaudeMd', () => {
  it('detects lowercase claude.md', () => {
    const dir = join(contentDir, 'test-detect-lower');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'claude.md'), '# Test');
    expect(detectClaudeMd(dir)).toBe(join(dir, 'claude.md'));
  });

  it('detects uppercase CLAUDE.md', () => {
    const dir = join(contentDir, 'test-detect-upper');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'CLAUDE.md'), '# Test');
    const result = detectClaudeMd(dir);
    // On case-insensitive filesystems (macOS), both claude.md and CLAUDE.md
    // resolve to the same file, so we just check it finds something
    expect(result).toBeDefined();
    expect(result!.endsWith('.md')).toBe(true);
  });

  it('returns a path when claude.md exists', () => {
    const dir = join(contentDir, 'test-detect-both');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'claude.md'), 'content');
    expect(detectClaudeMd(dir)).toBe(join(dir, 'claude.md'));
  });

  it('returns undefined when neither exists', () => {
    const dir = join(contentDir, 'test-detect-none');
    mkdirSync(dir, { recursive: true });
    expect(detectClaudeMd(dir)).toBeUndefined();
  });
});

// ══════════════════════════════════════════════════════════════
// register: database insertion
// ══════════════════════════════════════════════════════════════

describe('register: database insertion', () => {
  it('inserts an expert record into the database', () => {
    mkdirSync(join(contentDir, 'modules', 'Invoicing'), { recursive: true });

    register([makeProposal()], db, baseOptions);

    const experts = db.getAllExperts();
    expect(experts).toHaveLength(1);
    expect(experts[0].slug).toBe('invoicing');
  });

  it('sets the correct name from the proposal', () => {
    mkdirSync(join(contentDir, 'modules', 'Auth'), { recursive: true });

    register(
      [makeProposal({ slug: 'auth', name: 'Auth Service', mountPath: 'modules/Auth/' })],
      db,
      baseOptions
    );

    const expert = db.getExpert('auth');
    expect(expert).toBeDefined();
    expect(expert!.name).toBe('Auth Service');
  });

  it('resolves mount path relative to rootPath', () => {
    mkdirSync(join(contentDir, 'src', 'modules'), { recursive: true });

    register([makeProposal({ slug: 'mod', mountPath: 'src/modules/' })], db, baseOptions);

    const expert = db.getExpert('mod');
    // resolve() strips trailing slashes
    expect(expert!.mount_path).toBe(resolve(contentDir, 'src/modules/'));
  });

  it('uses default model when not specified in options', () => {
    mkdirSync(join(contentDir, 'test'), { recursive: true });

    register([makeProposal({ slug: 'test', mountPath: 'test/' })], db, baseOptions);

    const expert = db.getExpert('test');
    expect(expert!.model).toBe('claude-sonnet-4-20250514');
  });

  it('uses model from options when specified', () => {
    mkdirSync(join(contentDir, 'test'), { recursive: true });

    register([makeProposal({ slug: 'test', mountPath: 'test/' })], db, {
      ...baseOptions,
      model: 'claude-opus-4-20250514',
    });

    const expert = db.getExpert('test');
    expect(expert!.model).toBe('claude-opus-4-20250514');
  });

  it('registers multiple experts', () => {
    mkdirSync(join(contentDir, 'a'), { recursive: true });
    mkdirSync(join(contentDir, 'b'), { recursive: true });
    mkdirSync(join(contentDir, 'c'), { recursive: true });

    register(
      [
        makeProposal({ slug: 'alpha', mountPath: 'a/' }),
        makeProposal({ slug: 'beta', mountPath: 'b/' }),
        makeProposal({ slug: 'gamma', mountPath: 'c/' }),
      ],
      db,
      baseOptions
    );

    expect(db.getAllExperts()).toHaveLength(3);
  });

  it('returns empty array for empty accepted list', () => {
    const result = register([], db, baseOptions);
    expect(result).toEqual([]);
    expect(db.getAllExperts()).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════
// register: claude.md stub generation
// ══════════════════════════════════════════════════════════════

describe('register: claude.md stub generation', () => {
  it('creates claude.md when none exists', () => {
    mkdirSync(join(contentDir, 'modules', 'New'), { recursive: true });

    register([makeProposal({ slug: 'new', mountPath: 'modules/New/' })], db, baseOptions);

    const claudeMdPath = join(contentDir, 'modules', 'New', 'claude.md');
    expect(existsSync(claudeMdPath)).toBe(true);
  });

  it('generated stub contains the expert name and description', () => {
    mkdirSync(join(contentDir, 'test'), { recursive: true });

    register(
      [
        makeProposal({
          slug: 'test',
          name: 'Test Expert',
          mountPath: 'test/',
          description: 'A detailed description.',
        }),
      ],
      db,
      baseOptions
    );

    const content = readFileSync(join(contentDir, 'test', 'claude.md'), 'utf-8');
    expect(content).toContain('# Test Expert');
    expect(content).toContain('A detailed description.');
    expect(content).toContain('domain: Test Expert');
  });

  it('does not overwrite existing claude.md', () => {
    const dir = join(contentDir, 'existing');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'claude.md'), '# Existing content');

    register([makeProposal({ slug: 'existing', mountPath: 'existing/' })], db, baseOptions);

    const content = readFileSync(join(dir, 'claude.md'), 'utf-8');
    expect(content).toBe('# Existing content');
  });

  it('does not overwrite existing CLAUDE.md', () => {
    const dir = join(contentDir, 'upper');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'CLAUDE.md'), '# Uppercase content');

    register([makeProposal({ slug: 'upper', mountPath: 'upper/' })], db, baseOptions);

    // On case-insensitive FS (macOS), CLAUDE.md and claude.md are the same file.
    // detectClaudeMd checks lowercase first, which matches the existing CLAUDE.md.
    // The key point: the original content is preserved (not overwritten with a stub).
    const content = readFileSync(join(dir, 'CLAUDE.md'), 'utf-8');
    expect(content).toBe('# Uppercase content');
  });

  it('creates mount directory if it does not exist', () => {
    const mountPath = 'new/deep/path/';
    expect(existsSync(join(contentDir, mountPath))).toBe(false);

    register([makeProposal({ slug: 'deep', mountPath })], db, baseOptions);

    expect(existsSync(join(contentDir, mountPath))).toBe(true);
    expect(existsSync(join(contentDir, mountPath, 'claude.md'))).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════
// register: return value
// ══════════════════════════════════════════════════════════════

describe('register: return value', () => {
  it('returns RegisteredExpert for each accepted proposal', () => {
    mkdirSync(join(contentDir, 'a'), { recursive: true });
    mkdirSync(join(contentDir, 'b'), { recursive: true });

    const result = register(
      [
        makeProposal({ slug: 'alpha', mountPath: 'a/' }),
        makeProposal({ slug: 'beta', mountPath: 'b/' }),
      ],
      db,
      baseOptions
    );

    expect(result).toHaveLength(2);
    expect(result[0].slug).toBe('alpha');
    expect(result[1].slug).toBe('beta');
  });

  it('includes resolved mount path', () => {
    mkdirSync(join(contentDir, 'modules', 'Test'), { recursive: true });

    const result = register(
      [makeProposal({ slug: 'test', mountPath: 'modules/Test/' })],
      db,
      baseOptions
    );

    expect(result[0].mountPath).toBe(resolve(contentDir, 'modules/Test/'));
  });

  it('includes claudeMdPath for newly generated stubs', () => {
    mkdirSync(join(contentDir, 'new'), { recursive: true });

    const result = register([makeProposal({ slug: 'new', mountPath: 'new/' })], db, baseOptions);

    expect(result[0].claudeMdPath).toBe(join(contentDir, 'new', 'claude.md'));
  });

  it('includes claudeMdPath for existing claude.md', () => {
    const dir = join(contentDir, 'existing');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'claude.md'), '# Existing');

    const result = register(
      [makeProposal({ slug: 'existing', mountPath: 'existing/' })],
      db,
      baseOptions
    );

    expect(result[0].claudeMdPath).toBe(join(dir, 'claude.md'));
  });

  it('sets claude_md_path on the database record', () => {
    mkdirSync(join(contentDir, 'test'), { recursive: true });

    register([makeProposal({ slug: 'test', mountPath: 'test/' })], db, baseOptions);

    const expert = db.getExpert('test');
    expect(expert!.claude_md_path).toBe(join(contentDir, 'test', 'claude.md'));
  });
});

// ══════════════════════════════════════════════════════════════
// register: memory.md detection
// ══════════════════════════════════════════════════════════════

describe('register: memory.md detection', () => {
  it('detects existing memory.md and sets it on the record', () => {
    const dir = join(contentDir, 'with-memory');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'memory.md'), '# Memory');

    register([makeProposal({ slug: 'mem', mountPath: 'with-memory/' })], db, baseOptions);

    const expert = db.getExpert('mem');
    expect(expert!.memory_path).toBe(join(dir, 'memory.md'));
  });

  it('leaves memory_path undefined when memory.md does not exist', () => {
    mkdirSync(join(contentDir, 'no-memory'), { recursive: true });

    register([makeProposal({ slug: 'nomem', mountPath: 'no-memory/' })], db, baseOptions);

    const expert = db.getExpert('nomem');
    // SQLite returns null for missing optional fields
    expect(expert!.memory_path).toBeFalsy();
  });
});
