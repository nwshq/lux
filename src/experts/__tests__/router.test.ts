import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'fs';
import { LuxDatabase } from '../../db/index.js';
import { routeQuery, sanitizeFtsQuery } from '../router.js';
import type { ExpertSessionManager, QueryResult, SessionInfo } from '../session-manager.js';
import type { Expert, ExpertSession, KnowledgeEntryInsert, ClientInsert } from '../../db/types.js';

/** Helper to create knowledge entry with all required named params. */
function makeKnowledgeEntry(
  overrides: Partial<KnowledgeEntryInsert> & Pick<KnowledgeEntryInsert, 'type' | 'title' | 'file_path'>,
): KnowledgeEntryInsert {
  return {
    client_id: undefined,
    project_id: undefined,
    tags: undefined,
    metadata: undefined,
    content: undefined,
    ...overrides,
  };
}

/** Helper to create client insert with all required named params. */
function makeClientInsert(
  overrides: Partial<ClientInsert> & Pick<ClientInsert, 'slug' | 'name' | 'file_path'>,
): ClientInsert {
  return {
    type: undefined,
    status: undefined,
    metadata: undefined,
    content: undefined,
    ...overrides,
  };
}

/** A mock ExpertSessionManager that returns canned responses. */
function createMockSessionManager(
  responses: Record<string, string> = {},
): ExpertSessionManager & { queryCalls: Array<{ slug: string; question: string }> } {
  const queryCalls: Array<{ slug: string; question: string }> = [];

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

    async query(expertSlug: string, question: string): Promise<QueryResult> {
      queryCalls.push({ slug: expertSlug, question });
      const response = responses[expertSlug] ?? `Response from ${expertSlug}`;
      return {
        response,
        sessionId: 1,
        expertSlug,
      };
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

describe('routeQuery', () => {
  const testDir = join(__dirname, 'fixtures', 'router-test');
  const dbPath = join(testDir, 'test.db');
  const corpusDir = join(testDir, 'corpus');
  let db: LuxDatabase;

  beforeEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    mkdirSync(testDir, { recursive: true });
    mkdirSync(corpusDir, { recursive: true });
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
    const result = await routeQuery('test query', db, sessionManager);

    expect(result.query).toBe('test query');
    expect(result.matchedExperts).toHaveLength(0);
    expect(result.responses).toHaveLength(0);
    expect(result.synthesis).toBeUndefined();
  });

  it('should fall back to all active experts when no FTS5 matches', async () => {
    const expertDir = join(corpusDir, 'expert-a');
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

    const result = await routeQuery('completely unrelated query xyz', db, sessionManager);

    expect(result.responses).toHaveLength(1);
    expect(result.responses[0].expertSlug).toBe('expert-a');
    expect(result.responses[0].response).toBe('Expert A response');
  });

  it('should skip inactive experts', async () => {
    const expertDir = join(corpusDir, 'inactive');
    mkdirSync(expertDir, { recursive: true });

    db.insertExpert({
      slug: 'inactive-expert',
      name: 'Inactive Expert',
      mount_path: expertDir,
      status: 'inactive',
    });

    const sessionManager = createMockSessionManager();
    const result = await routeQuery('test', db, sessionManager);

    expect(result.matchedExperts).toHaveLength(0);
    expect(result.responses).toHaveLength(0);
  });

  it('should match expert by knowledge entry file path', async () => {
    const expertDir = join(corpusDir, 'methodology');
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
      }),
    );

    const sessionManager = createMockSessionManager({
      'method-expert': 'Agile is great!',
    });

    const result = await routeQuery('agile process', db, sessionManager);

    expect(result.matchedExperts.length).toBeGreaterThanOrEqual(1);
    expect(result.matchedExperts[0].expert.slug).toBe('method-expert');
    expect(result.matchedExperts[0].hits).toBeGreaterThanOrEqual(1);
    expect(result.responses).toHaveLength(1);
    expect(result.responses[0].response).toBe('Agile is great!');
  });

  it('should rank experts by hit count', async () => {
    const dirA = join(corpusDir, 'expert-a');
    mkdirSync(dirA, { recursive: true });
    db.insertExpert({
      slug: 'expert-a',
      name: 'Expert A',
      mount_path: dirA,
      status: 'active',
    });

    const dirB = join(corpusDir, 'expert-b');
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
        }),
      );
    }

    db.insertKnowledgeEntry(
      makeKnowledgeEntry({
        type: 'guide',
        title: 'Deployment Basics',
        file_path: join(dirB, 'deployment-basics.md'),
        content: 'Basic deployment information.',
      }),
    );

    const sessionManager = createMockSessionManager();
    const result = await routeQuery('deployment', db, sessionManager);

    expect(result.matchedExperts.length).toBe(2);
    expect(result.matchedExperts[0].expert.slug).toBe('expert-a');
    expect(result.matchedExperts[0].hits).toBeGreaterThan(result.matchedExperts[1].hits);
  });

  it('should cap experts at maxExperts option', async () => {
    for (let i = 0; i < 4; i++) {
      const dir = join(corpusDir, `expert-${i}`);
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
        }),
      );
    }

    const sessionManager = createMockSessionManager();
    const result = await routeQuery('testing', db, sessionManager, {
      maxExperts: 2,
    });

    expect(result.matchedExperts.length).toBeLessThanOrEqual(2);
    expect(result.responses.length).toBeLessThanOrEqual(2);
  });

  it('should produce synthesis when multiple experts respond', async () => {
    const dirA = join(corpusDir, 'alpha');
    const dirB = join(corpusDir, 'beta');
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
      }),
    );

    db.insertKnowledgeEntry(
      makeKnowledgeEntry({
        type: 'guide',
        title: 'Architecture Standards',
        file_path: join(dirB, 'standards.md'),
        content: 'Architecture standards and compliance requirements.',
      }),
    );

    const sessionManager = createMockSessionManager({
      alpha: 'Alpha perspective on architecture',
      beta: 'Beta perspective on architecture',
    });

    const result = await routeQuery('architecture', db, sessionManager);

    expect(result.responses.length).toBe(2);
    expect(result.synthesis).toBeDefined();
    expect(result.synthesis).toContain('alpha');
    expect(result.synthesis).toContain('beta');
    expect(result.synthesis).toContain('Alpha perspective');
    expect(result.synthesis).toContain('Beta perspective');
  });

  it('should not produce synthesis for single expert response', async () => {
    const dir = join(corpusDir, 'solo');
    mkdirSync(dir, { recursive: true });

    db.insertExpert({ slug: 'solo', name: 'Solo', mount_path: dir, status: 'active' });
    db.insertKnowledgeEntry(
      makeKnowledgeEntry({
        type: 'doc',
        title: 'Solo Topic',
        file_path: join(dir, 'solo-topic.md'),
        content: 'Unique solo topic content for testing.',
      }),
    );

    const sessionManager = createMockSessionManager({ solo: 'Solo answer' });
    const result = await routeQuery('solo topic', db, sessionManager);

    expect(result.responses).toHaveLength(1);
    expect(result.synthesis).toBeUndefined();
  });

  it('should handle expert query failures gracefully', async () => {
    const dirA = join(corpusDir, 'good');
    const dirB = join(corpusDir, 'bad');
    mkdirSync(dirA, { recursive: true });
    mkdirSync(dirB, { recursive: true });

    db.insertExpert({ slug: 'good', name: 'Good', mount_path: dirA, status: 'active' });
    db.insertExpert({ slug: 'bad', name: 'Bad', mount_path: dirB, status: 'active' });

    db.insertKnowledgeEntry(
      makeKnowledgeEntry({
        type: 'doc',
        title: 'Shared Topic A',
        file_path: join(dirA, 'shared.md'),
        content: 'Shared topic for routing test.',
      }),
    );
    db.insertKnowledgeEntry(
      makeKnowledgeEntry({
        type: 'doc',
        title: 'Shared Topic B',
        file_path: join(dirB, 'shared.md'),
        content: 'Shared topic for routing test.',
      }),
    );

    const sessionManager = createMockSessionManager({ good: 'Good answer' });
    const originalQuery = sessionManager.query.bind(sessionManager);
    sessionManager.query = async (slug: string, question: string) => {
      if (slug === 'bad') {
        throw new Error('Expert session failed');
      }
      return originalQuery(slug, question);
    };

    const result = await routeQuery('shared topic', db, sessionManager);

    expect(result.responses.length).toBeGreaterThanOrEqual(1);
    const goodResponse = result.responses.find((r) => r.expertSlug === 'good');
    expect(goodResponse).toBeDefined();
    expect(goodResponse!.response).toBe('Good answer');
  });

  it('should respect minHits option', async () => {
    const dir = join(corpusDir, 'sparse');
    mkdirSync(dir, { recursive: true });

    db.insertExpert({ slug: 'sparse', name: 'Sparse', mount_path: dir, status: 'active' });
    db.insertKnowledgeEntry(
      makeKnowledgeEntry({
        type: 'doc',
        title: 'Sparse Entry',
        file_path: join(dir, 'sparse.md'),
        content: 'Sparse content with unique keywords.',
      }),
    );

    const sessionManager = createMockSessionManager({ sparse: 'Sparse answer' });

    // With minHits=5, single hit shouldn't qualify — falls back to all active
    const result = await routeQuery('sparse', db, sessionManager, { minHits: 5 });

    expect(result.responses.length).toBeGreaterThanOrEqual(1);
  });

  it('should match client records to expert mount paths', async () => {
    const clientDir = join(corpusDir, 'clients', 'acme');
    mkdirSync(clientDir, { recursive: true });
    writeFileSync(join(clientDir, 'README.md'), '# Acme Corp');

    db.insertExpert({
      slug: 'client-expert',
      name: 'Client Expert',
      mount_path: join(corpusDir, 'clients'),
      status: 'active',
    });

    db.insertClient(
      makeClientInsert({
        slug: 'acme',
        name: 'Acme Corporation',
        file_path: join(clientDir, 'README.md'),
        type: 'client',
        status: 'active',
        content: '# Acme Corp',
      }),
    );

    const sessionManager = createMockSessionManager({
      'client-expert': 'Acme details',
    });

    const result = await routeQuery('acme', db, sessionManager);

    expect(result.matchedExperts.length).toBeGreaterThanOrEqual(1);
    expect(result.matchedExperts[0].expert.slug).toBe('client-expert');
  });
});
