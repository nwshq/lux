import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'path';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'fs';
import { LuxDatabase } from '../../db/index.js';
import {
  routeQuery,
  sanitizeFtsQuery,
  buildAugmentedQuery,
  buildExpertRoster,
  selectExpertWithLlm,
} from '../router.js';
import type { FtsHit } from '../router.js';
import type {
  ExpertSessionManager,
  QueryOptions,
  QueryResult,
  SessionInfo,
} from '../session-manager.js';
import type { Expert, ExpertSession, KnowledgeEntryInsert } from '../../db/types.js';
import { persistRebuildTrustState } from '../../scanner/overlay-trust-state.js';

// Mock child_process so selectExpertWithLlm doesn't call a real routing binary
vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: vi.fn(),
  };
});

import { spawn } from 'child_process';
import { EventEmitter } from 'events';

const mockSpawn = vi.mocked(spawn);

/** Creates a mock process that emits output and closes. */
function createMockRoutingProcess(stdout: string, code = 0) {
  const proc = new EventEmitter() as ReturnType<typeof spawn>;
  const stdoutEmitter = new EventEmitter();
  const stderrEmitter = new EventEmitter();
  Object.assign(proc, {
    stdout: stdoutEmitter,
    stderr: stderrEmitter,
    stdin: null,
    stdio: [null, stdoutEmitter, stderrEmitter],
    pid: 1,
    exitCode: null as number | null,
    signalCode: null,
    killed: false,
    connected: false,
    kill: vi.fn().mockReturnValue(true),
    ref: vi.fn(),
    unref: vi.fn(),
    disconnect: vi.fn(),
    send: vi.fn(),
    [Symbol.dispose]: vi.fn(),
  });

  // Schedule output and close asynchronously
  queueMicrotask(() => {
    stdoutEmitter.emit('data', Buffer.from(stdout));
    (proc as unknown as { exitCode: number }).exitCode = code;
    proc.emit('close', code);
  });

  return proc;
}

/** Helper to create knowledge entry with all required named params. */
function makeKnowledgeEntry(
  overrides: Partial<KnowledgeEntryInsert> &
    Pick<KnowledgeEntryInsert, 'type' | 'title' | 'file_path'>
): KnowledgeEntryInsert {
  return {
    tags: undefined,
    metadata: undefined,
    content: undefined,
    ...overrides,
  };
}

/** A mock ExpertSessionManager that returns canned responses. */
function createMockSessionManager(responses: Record<string, string> = {}): ExpertSessionManager & {
  queryCalls: Array<{ slug: string; question: string; options?: QueryOptions }>;
} {
  const queryCalls: Array<{ slug: string; question: string; options?: QueryOptions }> = [];

  return {
    queryCalls,

    getSession(expertSlug: string): SessionInfo {
      return {
        session: {
          id: 1,
          expert_id: 1,
          session_ref: `session-${expertSlug}-mock`,
          spawned_at: Date.now(),
          last_active_at: Date.now(),
          status: 'warm',
        } as ExpertSession,
        expert: {
          id: 1,
          slug: expertSlug,
          name: expertSlug,
          mount_path: '/mock',
          model: 'claude-sonnet-4-20250514',
          status: 'active',
          created_at: Date.now(),
          updated_at: Date.now(),
        } as Expert,
      };
    },

    query(expertSlug: string, question: string, options?: QueryOptions): Promise<QueryResult> {
      queryCalls.push({ slug: expertSlug, question, options });
      const response = responses[expertSlug] ?? `Response from ${expertSlug}`;
      return Promise.resolve({
        response,
        sessionId: 1,
        expertSlug,
      });
    },

    terminate(_sessionId: number): void {
      // no-op
    },

    isAlive(_sessionId: number): boolean {
      return true;
    },
  };
}

describe('sanitizeFtsQuery', () => {
  it('should wrap single token in quotes', () => {
    expect(sanitizeFtsQuery('hello')).toBe('"hello"');
  });

  it('should join multiple tokens with OR', () => {
    expect(sanitizeFtsQuery('hello world')).toBe('"hello" OR "world"');
  });

  it('should strip special characters', () => {
    const result = sanitizeFtsQuery('hello! @world (test)');
    expect(result).toBe('"hello" OR "world" OR "test"');
  });

  it('should preserve asterisk for prefix matching', () => {
    expect(sanitizeFtsQuery('hel*')).toBe('"hel*"');
  });

  it('should preserve hyphens', () => {
    expect(sanitizeFtsQuery('my-expert')).toBe('"my-expert"');
  });

  it('should return empty string for empty input', () => {
    expect(sanitizeFtsQuery('')).toBe('');
  });

  it('should return empty string for only special chars', () => {
    expect(sanitizeFtsQuery('!@#$%')).toBe('');
  });
});

describe('buildAugmentedQuery', () => {
  it('should return raw question when no hits have content', () => {
    const hits: FtsHit[] = [
      { filePath: '/some/path', rank: 0 },
      { filePath: '/other/path', rank: 0, content: '' },
    ];
    expect(buildAugmentedQuery('What is X?', hits)).toBe('What is X?');
  });

  it('should include reference documents with content', () => {
    const hits: FtsHit[] = [
      { filePath: '/path/doc.md', rank: 0, content: 'Doc content here', title: 'My Doc' },
    ];
    const result = buildAugmentedQuery('What is X?', hits);
    expect(result).toContain('## Reference Documents');
    expect(result).toContain('### My Doc');
    expect(result).toContain('Doc content here');
    expect(result).toContain('## Question');
    expect(result).toContain('What is X?');
  });

  it('should use filePath as label when title is missing', () => {
    const hits: FtsHit[] = [{ filePath: '/path/doc.md', rank: 0, content: 'Content' }];
    const result = buildAugmentedQuery('Q?', hits);
    expect(result).toContain('### /path/doc.md');
  });

  it('should cap context at maxContextBytes', () => {
    const bigContent = 'x'.repeat(5000);
    const hits: FtsHit[] = [
      { filePath: '/a', rank: 0, content: bigContent, title: 'A' },
      { filePath: '/b', rank: 0, content: bigContent, title: 'B' },
      { filePath: '/c', rank: 0, content: bigContent, title: 'C' },
    ];
    // With a 6000 byte budget, only the first doc should fully fit
    const result = buildAugmentedQuery('Q?', hits, 6000);
    expect(result).toContain('### A');
    // The overall reference section should respect the budget
    const refSection = result.split('## Question')[0];
    // B may be present but truncated, or absent
    if (refSection.includes('### B')) {
      expect(refSection).toContain('[...truncated]');
    }
  });

  it('should skip hits with empty or whitespace-only content', () => {
    const hits: FtsHit[] = [
      { filePath: '/a', rank: 0, content: '   ', title: 'Empty' },
      { filePath: '/b', rank: 0, content: 'Real content', title: 'Real' },
    ];
    const result = buildAugmentedQuery('Q?', hits);
    expect(result).not.toContain('### Empty');
    expect(result).toContain('### Real');
  });

  it('should include multiple documents when they fit', () => {
    const hits: FtsHit[] = [
      { filePath: '/a', rank: 0, content: 'Content A', title: 'Doc A' },
      { filePath: '/b', rank: 0, content: 'Content B', title: 'Doc B' },
    ];
    const result = buildAugmentedQuery('Q?', hits);
    expect(result).toContain('### Doc A');
    expect(result).toContain('Content A');
    expect(result).toContain('### Doc B');
    expect(result).toContain('Content B');
  });
});

describe('routeQuery', () => {
  const testDir = join(__dirname, 'fixtures', 'router-test');
  const dbPath = join(testDir, 'test.db');
  const contentDir = join(testDir, 'content');
  let db: LuxDatabase;

  beforeEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    mkdirSync(testDir, { recursive: true });
    mkdirSync(contentDir, { recursive: true });
    db = new LuxDatabase(dbPath);
  });

  afterEach(() => {
    if (db) db.close();
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should return empty result when no experts exist', async () => {
    const sessionManager = createMockSessionManager();
    const result = await routeQuery('test query', db, sessionManager, { useLlmRouting: false });

    expect(result.query).toBe('test query');
    expect(result.matchedExperts).toHaveLength(0);
    expect(result.responses).toHaveLength(0);
    expect(result.routingMethod).toBe('fts5');
  });

  it('should fall back to first active expert when no FTS5 matches', async () => {
    const expertDir = join(contentDir, 'expert-a');
    mkdirSync(expertDir, { recursive: true });

    db.insertExpert({
      slug: 'expert-a',
      name: 'Expert A',
      mount_path: expertDir,
      status: 'active',
    });

    const sessionManager = createMockSessionManager({
      'expert-a': 'Expert A response',
    });

    const result = await routeQuery('completely unrelated query xyz', db, sessionManager, {
      useLlmRouting: false,
    });

    expect(result.responses).toHaveLength(1);
    expect(result.responses[0].expertSlug).toBe('expert-a');
    expect(result.responses[0].response).toBe('Expert A response');
    // Fallback sends raw question, not augmented
    expect(sessionManager.queryCalls[0].question).toBe('completely unrelated query xyz');
  });

  it('should skip inactive experts', async () => {
    const expertDir = join(contentDir, 'inactive');
    mkdirSync(expertDir, { recursive: true });

    db.insertExpert({
      slug: 'inactive-expert',
      name: 'Inactive Expert',
      mount_path: expertDir,
      status: 'inactive',
    });

    const sessionManager = createMockSessionManager();
    const result = await routeQuery('test', db, sessionManager, { useLlmRouting: false });

    expect(result.matchedExperts).toHaveLength(0);
    expect(result.responses).toHaveLength(0);
  });

  it('should match expert by knowledge entry file path', async () => {
    const expertDir = join(contentDir, 'methodology');
    mkdirSync(expertDir, { recursive: true });

    db.insertExpert({
      slug: 'method-expert',
      name: 'Methodology Expert',
      mount_path: expertDir,
      status: 'active',
    });

    db.insertKnowledgeEntry(
      makeKnowledgeEntry({
        type: 'methodology',
        title: 'Agile Process Guide',
        file_path: join(expertDir, 'agile-process.md'),
        tags: ['agile', 'process'],
        content: 'This is an agile process methodology guide for software development.',
      })
    );

    const sessionManager = createMockSessionManager({
      'method-expert': 'Agile is great!',
    });

    const result = await routeQuery('agile process', db, sessionManager, { useLlmRouting: false });

    expect(result.matchedExperts.length).toBeGreaterThanOrEqual(1);
    expect(result.matchedExperts[0].expert.slug).toBe('method-expert');
    expect(result.matchedExperts[0].hits).toBeGreaterThanOrEqual(1);
    expect(result.responses).toHaveLength(1);
    expect(result.responses[0].response).toBe('Agile is great!');
  });

  it('should send augmented query with document content to the expert', async () => {
    const expertDir = join(contentDir, 'platforms');
    mkdirSync(expertDir, { recursive: true });

    db.insertExpert({
      slug: 'platform-expert',
      name: 'Platform Expert',
      mount_path: expertDir,
      status: 'active',
    });

    db.insertKnowledgeEntry(
      makeKnowledgeEntry({
        type: 'doc',
        title: 'Auction Platforms',
        file_path: join(expertDir, 'auction-platforms.md'),
        content: 'We manage eBay, Amazon, and Shopify auction platforms.',
      })
    );

    const sessionManager = createMockSessionManager({
      'platform-expert': 'eBay, Amazon, and Shopify',
    });

    const result = await routeQuery('What auction platforms?', db, sessionManager, {
      useLlmRouting: false,
    });

    expect(result.responses).toHaveLength(1);
    // The query sent to the expert should include the document content
    const sentQuery = sessionManager.queryCalls[0].question;
    expect(sentQuery).toContain('Reference Documents');
    expect(sentQuery).toContain('eBay, Amazon, and Shopify auction platforms');
    expect(sentQuery).toContain('What auction platforms?');
  });

  it('should default to single-expert routing (maxExperts=1)', async () => {
    const dirA = join(contentDir, 'expert-a');
    mkdirSync(dirA, { recursive: true });
    db.insertExpert({
      slug: 'expert-a',
      name: 'Expert A',
      mount_path: dirA,
      status: 'active',
    });

    const dirB = join(contentDir, 'expert-b');
    mkdirSync(dirB, { recursive: true });
    db.insertExpert({
      slug: 'expert-b',
      name: 'Expert B',
      mount_path: dirB,
      status: 'active',
    });

    for (let i = 0; i < 3; i++) {
      db.insertKnowledgeEntry(
        makeKnowledgeEntry({
          type: 'guide',
          title: `Deployment Guide ${i}`,
          file_path: join(dirA, `deployment-${i}.md`),
          content: `Deployment strategies and patterns for microservices version ${i}.`,
        })
      );
    }

    db.insertKnowledgeEntry(
      makeKnowledgeEntry({
        type: 'guide',
        title: 'Deployment Basics',
        file_path: join(dirB, 'deployment-basics.md'),
        content: 'Basic deployment information.',
      })
    );

    const sessionManager = createMockSessionManager();
    const result = await routeQuery('deployment', db, sessionManager, { useLlmRouting: false });

    // Default maxExperts=1, so only the best expert (expert-a with 3 hits) is queried
    expect(result.matchedExperts).toHaveLength(1);
    expect(result.matchedExperts[0].expert.slug).toBe('expert-a');
    expect(result.matchedExperts[0].hits).toBe(3);
    expect(result.responses).toHaveLength(1);
    expect(sessionManager.queryCalls).toHaveLength(1);
  });

  it('should query multiple experts when maxExperts > 1', async () => {
    const dirA = join(contentDir, 'alpha');
    const dirB = join(contentDir, 'beta');
    mkdirSync(dirA, { recursive: true });
    mkdirSync(dirB, { recursive: true });

    db.insertExpert({ slug: 'alpha', name: 'Alpha', mount_path: dirA, status: 'active' });
    db.insertExpert({ slug: 'beta', name: 'Beta', mount_path: dirB, status: 'active' });

    db.insertKnowledgeEntry(
      makeKnowledgeEntry({
        type: 'guide',
        title: 'Architecture Overview',
        file_path: join(dirA, 'architecture.md'),
        content: 'Microservices architecture patterns and best practices.',
      })
    );

    db.insertKnowledgeEntry(
      makeKnowledgeEntry({
        type: 'guide',
        title: 'Architecture Standards',
        file_path: join(dirB, 'standards.md'),
        content: 'Architecture standards and compliance requirements.',
      })
    );

    const sessionManager = createMockSessionManager({
      alpha: 'Alpha perspective on architecture',
      beta: 'Beta perspective on architecture',
    });

    const result = await routeQuery('architecture', db, sessionManager, {
      maxExperts: 2,
      useLlmRouting: false,
    });

    expect(result.responses.length).toBe(2);
    // No synthesis field in the result
    expect(result).not.toHaveProperty('synthesis');
  });

  it('should cap experts at maxExperts option', async () => {
    for (let i = 0; i < 4; i++) {
      const dir = join(contentDir, `expert-${i}`);
      mkdirSync(dir, { recursive: true });
      db.insertExpert({
        slug: `expert-${i}`,
        name: `Expert ${i}`,
        mount_path: dir,
        status: 'active',
      });
      db.insertKnowledgeEntry(
        makeKnowledgeEntry({
          type: 'doc',
          title: `Testing Doc ${i}`,
          file_path: join(dir, `testing-${i}.md`),
          content: `Testing strategies and approaches for expert ${i}.`,
        })
      );
    }

    const sessionManager = createMockSessionManager();
    const result = await routeQuery('testing', db, sessionManager, {
      maxExperts: 2,
      useLlmRouting: false,
    });

    expect(result.matchedExperts.length).toBeLessThanOrEqual(2);
    expect(result.responses.length).toBeLessThanOrEqual(2);
  });

  it('should handle expert query failures gracefully', async () => {
    const dirA = join(contentDir, 'good');
    mkdirSync(dirA, { recursive: true });

    db.insertExpert({ slug: 'good', name: 'Good', mount_path: dirA, status: 'active' });

    db.insertKnowledgeEntry(
      makeKnowledgeEntry({
        type: 'doc',
        title: 'Shared Topic A',
        file_path: join(dirA, 'shared.md'),
        content: 'Shared topic for routing test.',
      })
    );

    const sessionManager = createMockSessionManager({ good: 'Good answer' });
    const originalQuery = sessionManager.query.bind(sessionManager);
    sessionManager.query = async (slug: string, question: string) => {
      if (slug === 'bad') {
        throw new Error('Expert session failed');
      }
      return originalQuery(slug, question);
    };

    const result = await routeQuery('shared topic', db, sessionManager, { useLlmRouting: false });

    expect(result.responses.length).toBeGreaterThanOrEqual(1);
    const goodResponse = result.responses.find((r) => r.expertSlug === 'good');
    expect(goodResponse).toBeDefined();
    expect(goodResponse!.response).toBe('Good answer');
  });

  it('should respect minHits option', async () => {
    const dir = join(contentDir, 'sparse');
    mkdirSync(dir, { recursive: true });

    db.insertExpert({ slug: 'sparse', name: 'Sparse', mount_path: dir, status: 'active' });
    db.insertKnowledgeEntry(
      makeKnowledgeEntry({
        type: 'doc',
        title: 'Sparse Entry',
        file_path: join(dir, 'sparse.md'),
        content: 'Sparse content with unique keywords.',
      })
    );

    const sessionManager = createMockSessionManager({ sparse: 'Sparse answer' });

    // With minHits=5, single hit shouldn't qualify — falls back to first active expert
    const result = await routeQuery('sparse', db, sessionManager, {
      minHits: 5,
      useLlmRouting: false,
    });

    expect(result.responses.length).toBeGreaterThanOrEqual(1);
  });

  it('should match knowledge records to expert mount paths', async () => {
    const docsDir = join(contentDir, 'docs', 'acme');
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(join(docsDir, 'README.md'), '# Acme Corp');

    db.insertExpert({
      slug: 'docs-expert',
      name: 'Docs Expert',
      mount_path: join(contentDir, 'docs'),
      status: 'active',
    });

    db.insertKnowledgeEntry(
      makeKnowledgeEntry({
        type: 'general',
        title: 'Acme Corporation',
        file_path: join(docsDir, 'README.md'),
        content: '# Acme Corp',
      })
    );

    const sessionManager = createMockSessionManager({
      'docs-expert': 'Acme details',
    });

    const result = await routeQuery('acme', db, sessionManager, { useLlmRouting: false });

    expect(result.matchedExperts.length).toBeGreaterThanOrEqual(1);
    expect(result.matchedExperts[0].expert.slug).toBe('docs-expert');
  });

  it('should not include synthesis in route result', async () => {
    const dir = join(contentDir, 'solo');
    mkdirSync(dir, { recursive: true });

    db.insertExpert({ slug: 'solo', name: 'Solo', mount_path: dir, status: 'active' });
    db.insertKnowledgeEntry(
      makeKnowledgeEntry({
        type: 'doc',
        title: 'Solo Topic',
        file_path: join(dir, 'solo-topic.md'),
        content: 'Unique solo topic content for testing.',
      })
    );

    const sessionManager = createMockSessionManager({ solo: 'Solo answer' });
    const result = await routeQuery('solo topic', db, sessionManager, { useLlmRouting: false });

    expect(result.responses).toHaveLength(1);
    expect(result).not.toHaveProperty('synthesis');
  });

  it('should set routingMethod to fts5 when useLlmRouting is false', async () => {
    const dir = join(contentDir, 'method-test');
    mkdirSync(dir, { recursive: true });

    db.insertExpert({
      slug: 'method-test',
      name: 'Method Test',
      mount_path: dir,
      status: 'active',
    });
    db.insertKnowledgeEntry(
      makeKnowledgeEntry({
        type: 'doc',
        title: 'Method Doc',
        file_path: join(dir, 'method.md'),
        content: 'Method test content.',
      })
    );

    const sessionManager = createMockSessionManager({ 'method-test': 'answer' });
    const result = await routeQuery('method', db, sessionManager, { useLlmRouting: false });

    expect(result.routingMethod).toBe('fts5');
  });

  it('should fall back to FTS5 when LLM routing fails', async () => {
    const dir = join(contentDir, 'fallback-test');
    mkdirSync(dir, { recursive: true });

    db.insertExpert({
      slug: 'fallback-expert',
      name: 'Fallback Expert',
      mount_path: dir,
      status: 'active',
    });
    db.insertKnowledgeEntry(
      makeKnowledgeEntry({
        type: 'doc',
        title: 'Fallback Doc',
        file_path: join(dir, 'fallback.md'),
        content: 'Content for fallback routing test.',
      })
    );

    // Mock spawn to fail (simulating missing claude binary)
    mockSpawn.mockImplementation(() => createMockRoutingProcess('', 1));

    const sessionManager = createMockSessionManager({ 'fallback-expert': 'Fallback answer' });
    const result = await routeQuery('fallback', db, sessionManager, { useLlmRouting: true });

    expect(result.routingMethod).toBe('fts5');
    expect(result.matchedExperts[0].expert.slug).toBe('fallback-expert');
    expect(result.responses[0].response).toBe('Fallback answer');
  });

  it('should forward onChunk callback to sessionManager.query()', async () => {
    const expertDir = join(contentDir, 'chunk-expert');
    mkdirSync(expertDir, { recursive: true });

    db.insertExpert({
      slug: 'chunk-expert',
      name: 'Chunk Expert',
      mount_path: expertDir,
      status: 'active',
    });

    const sessionManager = createMockSessionManager({
      'chunk-expert': 'Chunk response',
    });

    const onChunk = vi.fn();
    await routeQuery('test query', db, sessionManager, { useLlmRouting: false, onChunk });

    expect(sessionManager.queryCalls).toHaveLength(1);
    expect(sessionManager.queryCalls[0].options).toBeDefined();
    expect(sessionManager.queryCalls[0].options!.onChunk).toBe(onChunk);
  });

  it('should not pass QueryOptions when onChunk is not provided', async () => {
    const expertDir = join(contentDir, 'no-chunk');
    mkdirSync(expertDir, { recursive: true });

    db.insertExpert({
      slug: 'no-chunk',
      name: 'No Chunk',
      mount_path: expertDir,
      status: 'active',
    });

    const sessionManager = createMockSessionManager({
      'no-chunk': 'No chunk response',
    });

    await routeQuery('test query', db, sessionManager, { useLlmRouting: false });

    expect(sessionManager.queryCalls).toHaveLength(1);
    expect(sessionManager.queryCalls[0].options).toBeUndefined();
  });

  it('should use LLM-selected expert when LLM routing succeeds', async () => {
    const dirA = join(contentDir, 'llm-a');
    const dirB = join(contentDir, 'llm-b');
    mkdirSync(dirA, { recursive: true });
    mkdirSync(dirB, { recursive: true });

    db.insertExpert({ slug: 'llm-a', name: 'LLM Expert A', mount_path: dirA, status: 'active' });
    db.insertExpert({ slug: 'llm-b', name: 'LLM Expert B', mount_path: dirB, status: 'active' });

    // Give expert A more FTS5 hits so FTS5 would pick A
    for (let i = 0; i < 5; i++) {
      db.insertKnowledgeEntry(
        makeKnowledgeEntry({
          type: 'doc',
          title: `Topic ${i}`,
          file_path: join(dirA, `topic-${i}.md`),
          content: `Information about topics and routing ${i}.`,
        })
      );
    }
    db.insertKnowledgeEntry(
      makeKnowledgeEntry({
        type: 'doc',
        title: 'Topic B',
        file_path: join(dirB, 'topic-b.md'),
        content: 'Information about topics and routing for B.',
      })
    );

    // Mock spawn to return "llm-b" — LLM overrides FTS5
    mockSpawn.mockImplementation(() => createMockRoutingProcess('llm-b\n'));

    const sessionManager = createMockSessionManager({
      'llm-a': 'A answer',
      'llm-b': 'B answer',
    });

    const result = await routeQuery('topics routing', db, sessionManager, { useLlmRouting: true });

    expect(result.routingMethod).toBe('llm');
    expect(result.matchedExperts[0].expert.slug).toBe('llm-b');
    expect(result.responses[0].response).toBe('B answer');
  });

  it('uses structural ownership as tiebreaker when FTS5 hit counts are equal', async () => {
    // Two experts with equal FTS5 coverage; one has a structurally aligned signature.
    // The structurally aligned expert should rank first after enrichWithStructuralOwnership.
    const alphaDir = join(contentDir, 'alpha-domain');
    const betaDir = join(contentDir, 'beta-domain');
    mkdirSync(alphaDir, { recursive: true });
    mkdirSync(betaDir, { recursive: true });

    const alphaFile = join(alphaDir, 'alpha-guide.md');
    const betaFile = join(betaDir, 'beta-guide.md');
    writeFileSync(alphaFile, '# Alpha\nalpha delta routing payments', 'utf-8');
    writeFileSync(betaFile, '# Beta\nalpha delta routing payments', 'utf-8');

    // Expert-A: has a structural signature whose anchorFiles match the indexed hit files
    db.insertExpert({
      slug: 'alpha-expert',
      name: 'Alpha Expert',
      mount_path: alphaDir,
      status: 'active',
      structural_signature: JSON.stringify({
        version: 1,
        anchorFiles: [alphaFile, betaFile], // matches all hit files → high overlap
        dominantDirectories: [alphaDir],
      }),
    });

    // Expert-B: has a structural signature that does NOT match the hit files
    db.insertExpert({
      slug: 'beta-expert',
      name: 'Beta Expert',
      mount_path: betaDir,
      status: 'active',
      structural_signature: JSON.stringify({
        version: 1,
        anchorFiles: ['packages/completely-unrelated/Service.ts'],
        dominantDirectories: ['packages/completely-unrelated'],
      }),
    });

    // Index one file under each expert so FTS5 hits are equal (1 each)
    db.insertKnowledgeEntry(
      makeKnowledgeEntry({
        type: 'doc',
        title: 'Alpha Guide',
        file_path: alphaFile,
        content: 'alpha delta routing payments',
      })
    );
    db.insertKnowledgeEntry(
      makeKnowledgeEntry({
        type: 'doc',
        title: 'Beta Guide',
        file_path: betaFile,
        content: 'alpha delta routing payments',
      })
    );

    // Set overlay-complete trust state so structural scoring is active
    persistRebuildTrustState(
      db,
      {
        mode: 'overlay-complete',
        repoPath: contentDir,
        configSource: 'lux.yaml',
        configLspEnabled: false,
        surfaceCount: 1,
        detectorEdgeCount: 1,
        propagatedEdgeCount: 1,
        fileNodeCount: 2,
        symbolNodeCount: 2,
        controllerBackedCount: 1,
        closureBackedCount: 0,
        unknownProviderKindCount: 0,
        enrichmentStatus: 'active',
        propagationStatus: 'ran',
        warnings: [],
      },
      { sourceAction: 'index-rebuild' }
    );

    const sessionManager = createMockSessionManager({
      'alpha-expert': 'Alpha answer',
      'beta-expert': 'Beta answer',
    });

    const result = await routeQuery('alpha delta routing payments', db, sessionManager, {
      useLlmRouting: false,
      maxExperts: 2,
    });

    // Both experts should appear in results
    expect(result.matchedExperts.length).toBeGreaterThanOrEqual(2);

    // Alpha should be ranked first — it has higher structural ownership score
    expect(result.matchedExperts[0].expert.slug).toBe('alpha-expert');
    // Alpha's structural ownership should be populated and have non-zero score
    expect(result.matchedExperts[0].structuralOwnership?.trustAdjustedScore).toBeGreaterThan(0);
    // Beta's score should be lower than alpha's
    const alphaTrust = result.matchedExperts[0].structuralOwnership?.trustAdjustedScore ?? 0;
    const betaTrust =
      result.matchedExperts.find((s) => s.expert.slug === 'beta-expert')?.structuralOwnership
        ?.trustAdjustedScore ?? 0;
    expect(alphaTrust).toBeGreaterThan(betaTrust);
  });
});

describe('buildExpertRoster', () => {
  const testDir = join(__dirname, 'fixtures', 'roster-test');

  beforeEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  function makeExpert(overrides: Partial<Expert> & Pick<Expert, 'slug' | 'name'>): Expert {
    return {
      id: 1,
      mount_path: '/mock',
      model: 'claude-sonnet-4-20250514',
      status: 'active',
      created_at: Date.now(),
      updated_at: Date.now(),
      ...overrides,
    };
  }

  it('should build a roster with slug, name, and brief for each expert', () => {
    const claudeMdPath = join(testDir, 'expert.md');
    writeFileSync(
      claudeMdPath,
      '# Expert Title\n\nThis expert handles chiropractic practice management and billing.'
    );

    const roster = buildExpertRoster([
      makeExpert({ slug: 'example-app', name: 'example-app Expert', claude_md_path: claudeMdPath }),
    ]);

    expect(roster).toContain('`example-app`');
    expect(roster).toContain('example-app Expert');
    expect(roster).toContain('chiropractic practice management');
  });

  it('should use "No description available" when claude_md_path is missing', () => {
    const roster = buildExpertRoster([makeExpert({ slug: 'no-md', name: 'No MD Expert' })]);

    expect(roster).toContain('`no-md`');
    expect(roster).toContain('No description available');
  });

  it('should use "No description available" when file does not exist', () => {
    const roster = buildExpertRoster([
      makeExpert({ slug: 'gone', name: 'Gone Expert', claude_md_path: '/nonexistent/path.md' }),
    ]);

    expect(roster).toContain('No description available');
  });

  it('should strip YAML frontmatter from claude_md content', () => {
    const claudeMdPath = join(testDir, 'frontmatter.md');
    writeFileSync(
      claudeMdPath,
      '---\ntitle: Test\nauthor: AI\n---\n\n# Title\n\nActual description content here.'
    );

    const roster = buildExpertRoster([
      makeExpert({ slug: 'fm', name: 'FM Expert', claude_md_path: claudeMdPath }),
    ]);

    expect(roster).toContain('Actual description content here');
    expect(roster).not.toContain('author: AI');
  });

  it('should truncate brief to ~200 chars', () => {
    const claudeMdPath = join(testDir, 'long.md');
    const longContent = 'A'.repeat(500);
    writeFileSync(claudeMdPath, longContent);

    const roster = buildExpertRoster([
      makeExpert({ slug: 'long', name: 'Long Expert', claude_md_path: claudeMdPath }),
    ]);

    const briefMatch = roster.match(/Long Expert: (A+)/);
    expect(briefMatch).not.toBeNull();
    expect(briefMatch![1].length).toBe(200);
  });

  it('should list multiple experts on separate lines', () => {
    const roster = buildExpertRoster([
      makeExpert({ slug: 'alpha', name: 'Alpha' }),
      makeExpert({ slug: 'beta', name: 'Beta' }),
    ]);

    const lines = roster.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('`alpha`');
    expect(lines[1]).toContain('`beta`');
  });
});

describe('selectExpertWithLlm', () => {
  function makeExpert(overrides: Partial<Expert> & Pick<Expert, 'slug' | 'name'>): Expert {
    return {
      id: 1,
      mount_path: '/mock',
      model: 'claude-sonnet-4-20250514',
      status: 'active',
      created_at: Date.now(),
      updated_at: Date.now(),
      ...overrides,
    };
  }

  const experts = [
    makeExpert({ slug: 'example-app', name: 'example-app Expert' }),
    makeExpert({ slug: 'acme', name: 'acme Expert' }),
  ];

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should return the slug when LLM returns a valid expert', async () => {
    mockSpawn.mockImplementation(() => createMockRoutingProcess('example-app\n'));

    const result = await selectExpertWithLlm('What is example-app?', experts);
    expect(result.slug).toBe('example-app');
    expect(result.error).toBeNull();
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.prompt).toContain('example-app');
    expect(result.rawResponse).toContain('example-app');
  });

  it('should handle slug wrapped in backticks', async () => {
    mockSpawn.mockImplementation(() => createMockRoutingProcess('`acme`\n'));

    const result = await selectExpertWithLlm('What platforms does acme manage?', experts);
    expect(result.slug).toBe('acme');
  });

  it('should return null slug when LLM returns an invalid slug', async () => {
    mockSpawn.mockImplementation(() => createMockRoutingProcess('nonexistent-expert\n'));

    const result = await selectExpertWithLlm('test question', experts);
    expect(result.slug).toBeNull();
    expect(result.error).toContain('invalid slug');
    expect(result.rawResponse).toContain('nonexistent-expert');
  });

  it('should return null slug when spawn fails with non-zero exit', async () => {
    mockSpawn.mockImplementation(() => createMockRoutingProcess('', 1));

    const result = await selectExpertWithLlm('test question', experts);
    expect(result.slug).toBeNull();
    expect(result.error).toBeTruthy();
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('should pass the routing model to the routing CLI', async () => {
    let capturedArgs: string[] = [];
    mockSpawn.mockImplementation((_cmd, args) => {
      capturedArgs = args as string[];
      return createMockRoutingProcess('example-app\n');
    });

    const result = await selectExpertWithLlm('test', experts, 'custom-model');
    expect(capturedArgs).toContain('custom-model');
    expect(result.model).toBe('custom-model');
  });
});
