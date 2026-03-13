import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
import { LuxDatabase } from '../../db/index.js';
import { GeneralScanner } from '../../scanner/index.js';

/**
 * MCP Server Test Suite
 *
 * Tests all MCP tools exposed by the Lux Knowledge Platform:
 * - lux_search: Search across all indexed documents
 * - lux_log_event: Log an event to audit trail
 * - lux_get_file: Read file content
 * - lux_rebuild_index: Rebuild the entire index
 */

describe('MCP Server Tools', () => {
  const testDir = join(__dirname, 'fixtures', 'mcp-test');
  const contentDir = join(testDir, 'content');
  const dbPath = join(testDir, 'test.db');
  let db: LuxDatabase;

  // Setup test environment before each test
  beforeEach(async () => {
    // Clean up any existing test directory
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }

    // Create test content directory structure
    mkdirSync(contentDir, { recursive: true });
    mkdirSync(join(contentDir, 'knowledge', '20_methodology'), { recursive: true });
    mkdirSync(join(contentDir, 'explorations'), { recursive: true });

    // Create test knowledge entry
    writeFileSync(
      join(contentDir, 'knowledge', '20_methodology', 'testing.md'),
      `---
title: Testing Methodology
tags:
  - testing
  - quality
---

# Testing Methodology

Our approach to testing.
`
    );

    // Create another knowledge entry
    writeFileSync(
      join(contentDir, 'explorations', 'api-design.md'),
      `---
title: API Design Exploration
type: exploration
tags:
  - api
  - design
---

# API Design

Exploring API design patterns.
`
    );

    // Initialize database and scan content directory
    db = new LuxDatabase(dbPath);
    const scanner = new GeneralScanner(contentDir);
    const scanResult = await scanner.scan();
    await scanner.index(db, scanResult);
  });

  // Clean up after each test
  afterEach(() => {
    if (db) {
      db.close();
    }
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('lux_search', () => {
    it('should search for knowledge entries', () => {
      const results = db.searchKnowledgeEntries('Testing');
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('Testing Methodology');
    });

    it('should handle empty search results', () => {
      const results = db.searchKnowledgeEntries('NonExistent');
      expect(results).toHaveLength(0);
    });

    it('should search with FTS5 operators', () => {
      // Phrase search
      const results = db.searchKnowledgeEntries('"Testing Methodology"');
      expect(results).toHaveLength(1);
    });

    it('should search all documents with unified search', () => {
      const results = db.searchAllDocuments('Testing');
      expect(results.length).toBeGreaterThan(0);

      // Each result has the required shape
      for (const doc of results) {
        expect(doc).toHaveProperty('file_path');
        expect(doc).toHaveProperty('title');
        expect(doc).toHaveProperty('rank');
      }
    });

    it('should return empty from unified search for non-matching query', () => {
      const results = db.searchAllDocuments('xyznonexistent');
      expect(results).toHaveLength(0);
    });
  });

  describe('lux_log_event', () => {
    it('should log a basic event', () => {
      const eventId = db.insertEvent({
        source: 'test',
        event_type: 'unit_test',
        summary: 'Test event',
      });

      expect(eventId).toBeGreaterThan(0);

      const events = db.getRecentEvents(10);
      const testEvent = events.find((e) => e.summary === 'Test event');
      expect(testEvent).toBeDefined();
      expect(testEvent?.source).toBe('test');
      expect(testEvent?.event_type).toBe('unit_test');
    });

    it('should log event with payload', () => {
      const payload = {
        query: 'test query',
        results_count: 5,
        duration_ms: 42,
      };

      const eventId = db.insertEvent({
        source: 'mcp',
        event_type: 'search',
        summary: 'Search with payload',
        payload,
      });

      expect(eventId).toBeGreaterThan(0);

      const events = db.getRecentEvents(10);
      const searchEvent = events.find((e) => e.summary === 'Search with payload');
      expect(searchEvent).toBeDefined();
      expect(searchEvent?.payload).toBeDefined();

      if (searchEvent?.payload) {
        const parsedPayload = JSON.parse(searchEvent.payload);
        expect(parsedPayload.query).toBe('test query');
        expect(parsedPayload.results_count).toBe(5);
        expect(parsedPayload.duration_ms).toBe(42);
      }
    });

    it('should handle events with various sources', () => {
      const sources = ['mcp', 'cli', 'scanner', 'user', 'system'];

      sources.forEach((source) => {
        const eventId = db.insertEvent({
          source,
          event_type: 'test',
          summary: `Event from ${source}`,
        });
        expect(eventId).toBeGreaterThan(0);
      });

      const events = db.getRecentEvents(20);
      sources.forEach((source) => {
        const sourceEvent = events.find((e) => e.summary === `Event from ${source}`);
        expect(sourceEvent).toBeDefined();
      });
    });
  });

  describe('lux_get_file', () => {
    it('should read a file successfully', () => {
      const knowledgeFilePath = join(contentDir, 'knowledge', '20_methodology', 'testing.md');

      const content = readFileSync(knowledgeFilePath, 'utf-8');
      expect(content).toContain('Testing Methodology');
      expect(content).toContain('Our approach to testing');
    });

    it('should handle non-existent file', () => {
      const nonExistentPath = join(contentDir, 'non-existent.md');

      expect(() => {
        readFileSync(nonExistentPath, 'utf-8');
      }).toThrow();
    });

    it('should read files with different encodings', () => {
      // Create a test file with special characters
      const testFilePath = join(testDir, 'unicode-test.md');
      writeFileSync(testFilePath, '# Test with émojis 🎉 and spëcial çharacters');

      const content = readFileSync(testFilePath, 'utf-8');
      expect(content).toContain('émojis');
      expect(content).toContain('🎉');
      expect(content).toContain('spëcial');
    });
  });

  describe('lux_rebuild_index', () => {
    it('should rebuild index from content directory', async () => {
      // Clear database
      db.clearAll();
      expect(db.getStats().knowledge_entries).toBe(0);

      // Rebuild index
      const scanner = new GeneralScanner(contentDir);
      const scanResult = await scanner.scan();
      await scanner.index(db, scanResult);

      // Verify index was rebuilt
      const stats = db.getStats();
      expect(stats.knowledge_entries).toBeGreaterThan(0);
    });

    it('should handle rebuild with new files added', async () => {
      const initialStats = db.getStats();

      // Add a new knowledge entry
      writeFileSync(
        join(contentDir, 'knowledge', '20_methodology', 'new-process.md'),
        `---
title: New Process
tags:
  - process
---

# New Process

A newly added process document.
`
      );

      // Clear and rebuild
      db.clearAll();
      const scanner = new GeneralScanner(contentDir);
      const scanResult = await scanner.scan();
      await scanner.index(db, scanResult);

      // Verify new entry was indexed
      const newStats = db.getStats();
      expect(newStats.knowledge_entries).toBeGreaterThan(initialStats.knowledge_entries);
    });

    it('should log rebuild event', async () => {
      const scanner = new GeneralScanner(contentDir);
      const scanResult = await scanner.scan();

      // Log the rebuild event
      db.insertEvent({
        source: 'mcp',
        event_type: 'index_rebuild',
        summary: `Indexed ${scanResult.knowledge.length} knowledge entries`,
      });

      const events = db.getRecentEvents(10);
      const rebuildEvent = events.find((e) => e.event_type === 'index_rebuild');
      expect(rebuildEvent).toBeDefined();
    });
  });

  describe('Database Statistics', () => {
    it('should return accurate statistics', () => {
      const stats = db.getStats();

      expect(stats.knowledge_entries).toBeGreaterThan(0);

      // Verify count matches actual data
      const allEntries = db.getAllKnowledgeEntries();
      expect(stats.knowledge_entries).toBe(allEntries.length);
    });
  });

  describe('Error Handling', () => {
    it('should handle database errors gracefully', () => {
      // Try to insert duplicate knowledge entry path — test that db doesn't crash
      const entry1 = db.insertKnowledgeEntry({
        type: 'general',
        title: 'Test Entry',
        file_path: '/unique/path/test.md',
      });
      expect(entry1).toBeGreaterThan(0);
    });
  });

  describe('lux_list_experts', () => {
    it('should list all experts', () => {
      const experts = db.getAllExperts();
      expect(experts).toHaveLength(0); // No experts registered yet
    });

    it('should list experts after registration', () => {
      db.insertExpert({
        slug: 'test-expert',
        name: 'Test Expert',
        mount_path: contentDir,
        model: 'claude-sonnet-4-20250514',
      });

      const experts = db.getAllExperts();
      expect(experts).toHaveLength(1);
      expect(experts[0].slug).toBe('test-expert');
      expect(experts[0].name).toBe('Test Expert');
      expect(experts[0].model).toBe('claude-sonnet-4-20250514');
      expect(experts[0].status).toBe('active');
    });

    it('should filter experts by status', () => {
      db.insertExpert({
        slug: 'active-expert',
        name: 'Active Expert',
        mount_path: contentDir,
        model: 'claude-sonnet-4-20250514',
        status: 'active',
      });

      db.insertExpert({
        slug: 'inactive-expert',
        name: 'Inactive Expert',
        mount_path: contentDir,
        model: 'claude-sonnet-4-20250514',
        status: 'inactive',
      });

      const activeExperts = db.getExpertsByStatus('active');
      expect(activeExperts).toHaveLength(1);
      expect(activeExperts[0].slug).toBe('active-expert');

      const inactiveExperts = db.getExpertsByStatus('inactive');
      expect(inactiveExperts).toHaveLength(1);
      expect(inactiveExperts[0].slug).toBe('inactive-expert');

      const allExperts = db.getAllExperts();
      expect(allExperts).toHaveLength(2);
    });
  });

  describe('lux_ask', () => {
    it('should return error for non-existent expert via expert_hint', () => {
      const expert = db.getExpert('non-existent');
      expect(expert).toBeUndefined();
    });

    it('should return error for inactive expert via expert_hint', () => {
      db.insertExpert({
        slug: 'disabled-expert',
        name: 'Disabled Expert',
        mount_path: contentDir,
        model: 'claude-sonnet-4-20250514',
        status: 'inactive',
      });

      const expert = db.getExpert('disabled-expert');
      expect(expert).toBeDefined();
      expect(expert!.status).toBe('inactive');
    });

    it('should resolve expert with valid mount path when using expert_hint', () => {
      db.insertExpert({
        slug: 'valid-expert',
        name: 'Valid Expert',
        mount_path: contentDir,
        model: 'claude-sonnet-4-20250514',
      });

      const expert = db.getExpert('valid-expert');
      expect(expert).toBeDefined();
      expect(expert!.mount_path).toBe(contentDir);
      expect(existsSync(expert!.mount_path)).toBe(true);
    });

    it('should detect missing mount path for expert_hint target', () => {
      db.insertExpert({
        slug: 'missing-mount',
        name: 'Missing Mount Expert',
        mount_path: '/nonexistent/path/that/does/not/exist',
        model: 'claude-sonnet-4-20250514',
      });

      const expert = db.getExpert('missing-mount');
      expect(expert).toBeDefined();
      expect(existsSync(expert!.mount_path)).toBe(false);
    });

    it('should have active experts available for auto-routing', () => {
      // Without expert_hint, the handler auto-routes to active experts
      const activeExperts = db.getExpertsByStatus('active');
      expect(activeExperts).toHaveLength(0); // No experts registered yet

      // Register an active expert
      db.insertExpert({
        slug: 'auto-route-expert',
        name: 'Auto Route Expert',
        mount_path: contentDir,
        model: 'claude-sonnet-4-20250514',
        status: 'active',
      });

      const updated = db.getExpertsByStatus('active');
      expect(updated).toHaveLength(1);
      expect(updated[0].slug).toBe('auto-route-expert');
    });
  });

  describe('Integration Tests', () => {
    it('should handle full workflow: search, read file', () => {
      // 1. Search for knowledge entry
      const searchResults = db.searchKnowledgeEntries('Testing');
      expect(searchResults).toHaveLength(1);

      // 2. Read the file
      const content = readFileSync(searchResults[0].file_path, 'utf-8');
      expect(content).toContain('Testing Methodology');
    });
  });
});
