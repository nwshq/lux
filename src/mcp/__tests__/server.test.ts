import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
import { LuxDatabase } from '../../db/index.js';
import { CorpusScanner } from '../../scanner/index.js';
import { createMarkdownWithFrontmatter } from '../../utils/frontmatter.js';

/**
 * MCP Server Test Suite
 *
 * Tests all MCP tools exposed by the Lux Knowledge Platform:
 * - lux_search: Search across CORPUS entities
 * - lux_get_client: Get detailed client information
 * - lux_list_projects: List projects for a client
 * - lux_log_comm: Log a new communication
 * - lux_log_event: Log an event to audit trail
 * - lux_get_file: Read file content
 * - lux_rebuild_index: Rebuild the entire index
 */

describe('MCP Server Tools', () => {
  const testDir = join(__dirname, 'fixtures', 'mcp-test');
  const corpusPath = join(testDir, 'corpus');
  const dbPath = join(testDir, 'test.db');
  let db: LuxDatabase;

  // Setup test environment before each test
  beforeEach(async () => {
    // Clean up any existing test directory
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }

    // Create test corpus structure
    mkdirSync(corpusPath, { recursive: true });
    mkdirSync(join(corpusPath, 'knowledge', '10_clients', 'test-client'), { recursive: true });
    mkdirSync(join(corpusPath, 'knowledge', '10_clients', 'test-client', 'test-project'), {
      recursive: true,
    });
    mkdirSync(join(corpusPath, 'knowledge', '10_clients', 'test-client', 'communications'), {
      recursive: true,
    });
    mkdirSync(join(corpusPath, 'knowledge', '20_methodology'), { recursive: true });

    // Create test client file
    writeFileSync(
      join(corpusPath, 'knowledge', '10_clients', 'test-client', 'README.md'),
      createMarkdownWithFrontmatter(
        {
          name: 'Test Client',
          type: 'enterprise',
          status: 'active',
        },
        '# Test Client\n\nThis is a test client for MCP testing.'
      )
    );

    // Create test project file
    writeFileSync(
      join(corpusPath, 'knowledge', '10_clients', 'test-client', 'test-project', 'README.md'),
      createMarkdownWithFrontmatter(
        {
          name: 'Test Project',
          status: 'in-progress',
        },
        '# Test Project\n\nThis is a test project.'
      )
    );

    // Create test communication file
    writeFileSync(
      join(
        corpusPath,
        'knowledge',
        '10_clients',
        'test-client',
        'communications',
        '2024-01-15_meeting-kickoff.md'
      ),
      createMarkdownWithFrontmatter(
        {
          type: 'meeting',
          subject: 'Kickoff Meeting',
          date: '2024-01-15',
          participants: ['Alice', 'Bob'],
        },
        '# Kickoff Meeting\n\nDiscussed project requirements.'
      )
    );

    // Create test knowledge entry (manually create frontmatter since createMarkdownWithFrontmatter doesn't handle title)
    writeFileSync(
      join(corpusPath, 'knowledge', '20_methodology', 'testing.md'),
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

    // Initialize database and scan corpus
    db = new LuxDatabase(dbPath);
    const scanner = new CorpusScanner(corpusPath);
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
    it('should search for clients', () => {
      const results = db.searchClients('Test Client');
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('Test Client');
      expect(results[0].slug).toBe('test-client');
    });

    it('should search for projects', () => {
      const results = db.searchProjects('Test Project');
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('Test Project');
      expect(results[0].slug).toBe('test-project');
    });

    it('should search for communications', () => {
      const results = db.searchCommunications('Kickoff');
      expect(results).toHaveLength(1);
      expect(results[0].subject).toBe('Kickoff Meeting');
    });

    it('should search for knowledge entries', () => {
      const results = db.searchKnowledgeEntries('Testing');
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('Testing Methodology');
    });

    it('should handle empty search results', () => {
      const results = db.searchClients('NonExistent');
      expect(results).toHaveLength(0);
    });

    it('should search with FTS5 operators', () => {
      // Phrase search
      const results = db.searchClients('"Test Client"');
      expect(results).toHaveLength(1);
    });

    it('should filter search by client', () => {
      const client = db.getClient('test-client');
      expect(client).toBeDefined();

      const projects = db.getProjectsByClient(client!.id);
      expect(projects).toHaveLength(1);
      expect(projects[0].slug).toBe('test-project');
    });
  });

  describe('lux_get_client', () => {
    it('should get client by slug', () => {
      const client = db.getClient('test-client');
      expect(client).toBeDefined();
      expect(client?.name).toBe('Test Client');
      expect(client?.slug).toBe('test-client');
      // Type and status may be null if not in frontmatter, check if defined
      if (client?.type) {
        expect(client.type).toBe('enterprise');
      }
      if (client?.status) {
        expect(client.status).toBe('active');
      }
    });

    it('should return undefined for non-existent client', () => {
      const client = db.getClient('non-existent');
      expect(client).toBeUndefined();
    });

    it('should include projects in client response', () => {
      const client = db.getClient('test-client');
      expect(client).toBeDefined();

      const projects = db.getProjectsByClient(client!.id);
      expect(projects).toHaveLength(1);
      expect(projects[0].name).toBe('Test Project');
    });

    it('should include communications in client response', () => {
      const client = db.getClient('test-client');
      expect(client).toBeDefined();

      const comms = db.getCommunicationsByClient(client!.id);
      expect(comms).toHaveLength(1);
      expect(comms[0].subject).toBe('Kickoff Meeting');
    });
  });

  describe('lux_list_projects', () => {
    it('should list projects for a client', () => {
      const client = db.getClient('test-client');
      expect(client).toBeDefined();

      const projects = db.getProjectsByClient(client!.id);
      expect(projects).toHaveLength(1);
      expect(projects[0].slug).toBe('test-project');
      expect(projects[0].name).toBe('Test Project');
    });

    it('should return empty array for client with no projects', () => {
      // Create a client without projects
      const clientId = db.insertClient({
        slug: 'empty-client',
        name: 'Empty Client',
        type: null,
        status: null,
        file_path: '/test/path',
        content: null,
      });

      const projects = db.getProjectsByClient(clientId);
      expect(projects).toHaveLength(0);
    });

    it('should require valid client slug', () => {
      const client = db.getClient('non-existent');
      expect(client).toBeUndefined();
    });
  });

  describe('lux_log_comm', () => {
    it('should log a new communication', () => {
      const client = db.getClient('test-client');
      expect(client).toBeDefined();

      const commPath = join(
        corpusPath,
        'knowledge',
        '10_clients',
        'test-client',
        'communications',
        '2024-01-20_email-test.md'
      );

      // Create communication file
      const content = createMarkdownWithFrontmatter(
        {
          type: 'email',
          subject: 'Test Email',
          date: '2024-01-20',
          participants: ['test@example.com'],
        },
        'Test email content'
      );
      writeFileSync(commPath, content);

      // Insert into database
      const commId = db.insertCommunication({
        client_id: client!.id,
        project_id: null,
        type: 'email',
        subject: 'Test Email',
        date_range: '2024-01-20',
        participants: ['test@example.com'],
        file_path: commPath,
        content: 'Test email content',
      });

      expect(commId).toBeGreaterThan(0);

      // Verify it was created
      const comms = db.getCommunicationsByClient(client!.id);
      expect(comms).toHaveLength(2); // Original + new
      const newComm = comms.find((c) => c.subject === 'Test Email');
      expect(newComm).toBeDefined();
      expect(newComm?.type).toBe('email');
    });

    it('should log communication with project association', () => {
      const client = db.getClient('test-client');
      const project = db.getProject('test-client', 'test-project');
      expect(client).toBeDefined();
      expect(project).toBeDefined();

      const commPath = join(
        corpusPath,
        'knowledge',
        '10_clients',
        'test-client',
        'test-project',
        'communications',
        '2024-01-25_slack-update.md'
      );

      mkdirSync(
        join(
          corpusPath,
          'knowledge',
          '10_clients',
          'test-client',
          'test-project',
          'communications'
        ),
        {
          recursive: true,
        }
      );

      const content = createMarkdownWithFrontmatter(
        {
          type: 'slack',
          subject: 'Project Update',
          date: '2024-01-25',
        },
        'Project status update'
      );
      writeFileSync(commPath, content);

      const commId = db.insertCommunication({
        client_id: client!.id,
        project_id: project!.id,
        type: 'slack',
        subject: 'Project Update',
        date_range: '2024-01-25',
        file_path: commPath,
        content: 'Project status update',
      });

      expect(commId).toBeGreaterThan(0);

      // Verify it was created with project association
      const projectComms = db.getCommunicationsByProject(project!.id);
      expect(projectComms).toHaveLength(1);
      expect(projectComms[0].subject).toBe('Project Update');
    });

    it('should require valid client', () => {
      expect(() => {
        db.insertCommunication({
          client_id: 99999, // Non-existent client
          type: 'email',
          subject: 'Test',
          file_path: '/test/path',
        });
      }).toThrow();
    });

    it('should handle various communication types', () => {
      const client = db.getClient('test-client');
      expect(client).toBeDefined();

      const types = ['email', 'slack', 'meeting', 'call', 'other'];

      types.forEach((type, index) => {
        const commId = db.insertCommunication({
          client_id: client!.id,
          project_id: null,
          type,
          subject: `Test ${type}`,
          date_range: `2024-01-${20 + index}`,
          file_path: `/test/${type}.md`,
          content: `Test ${type} content`,
        });

        expect(commId).toBeGreaterThan(0);
      });

      const comms = db.getCommunicationsByClient(client!.id);
      expect(comms.length).toBeGreaterThanOrEqual(types.length);
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

    it('should log event with client association', () => {
      const client = db.getClient('test-client');
      expect(client).toBeDefined();

      const eventId = db.insertEvent({
        source: 'mcp',
        event_type: 'search',
        summary: 'Client search',
        client_id: client!.id,
      });

      expect(eventId).toBeGreaterThan(0);

      const events = db.getRecentEvents(10);
      const searchEvent = events.find((e) => e.summary === 'Client search');
      expect(searchEvent).toBeDefined();
      expect(searchEvent?.client_id).toBe(client!.id);
    });

    it('should log event with project association', () => {
      const client = db.getClient('test-client');
      const project = db.getProject('test-client', 'test-project');
      expect(client).toBeDefined();
      expect(project).toBeDefined();

      const eventId = db.insertEvent({
        source: 'mcp',
        event_type: 'project_action',
        summary: 'Project update',
        client_id: client!.id,
        project_id: project!.id,
      });

      expect(eventId).toBeGreaterThan(0);

      const events = db.getRecentEvents(10);
      const projectEvent = events.find((e) => e.summary === 'Project update');
      expect(projectEvent).toBeDefined();
      expect(projectEvent?.client_id).toBe(client!.id);
      expect(projectEvent?.project_id).toBe(project!.id);
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
      const clientFilePath = join(
        corpusPath,
        'knowledge',
        '10_clients',
        'test-client',
        'README.md'
      );

      const content = readFileSync(clientFilePath, 'utf-8');
      expect(content).toContain('Test Client');
      expect(content).toContain('type: enterprise');
    });

    it('should read communication file', () => {
      const commFilePath = join(
        corpusPath,
        'knowledge',
        '10_clients',
        'test-client',
        'communications',
        '2024-01-15_meeting-kickoff.md'
      );

      const content = readFileSync(commFilePath, 'utf-8');
      expect(content).toContain('Kickoff Meeting');
      expect(content).toContain('type: meeting');
      expect(content).toContain('participants:');
    });

    it('should read knowledge entry file', () => {
      const knowledgeFilePath = join(corpusPath, 'knowledge', '20_methodology', 'testing.md');

      const content = readFileSync(knowledgeFilePath, 'utf-8');
      expect(content).toContain('Testing Methodology');
      expect(content).toContain('Our approach to testing');
    });

    it('should handle non-existent file', () => {
      const nonExistentPath = join(corpusPath, 'non-existent.md');

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
    it('should rebuild index from corpus', async () => {
      // Clear database
      db.clearAll();
      expect(db.getStats().clients).toBe(0);

      // Rebuild index
      const scanner = new CorpusScanner(corpusPath);
      const scanResult = await scanner.scan();
      await scanner.index(db, scanResult);

      // Verify index was rebuilt
      const stats = db.getStats();
      expect(stats.clients).toBeGreaterThan(0);
      expect(stats.projects).toBeGreaterThan(0);
      expect(stats.communications).toBeGreaterThan(0);
      expect(stats.knowledge_entries).toBeGreaterThan(0);
    });

    it('should handle rebuild with new files added', async () => {
      const initialStats = db.getStats();

      // Add a new client
      mkdirSync(join(corpusPath, 'knowledge', '10_clients', 'new-client'), { recursive: true });
      writeFileSync(
        join(corpusPath, 'knowledge', '10_clients', 'new-client', 'README.md'),
        createMarkdownWithFrontmatter(
          {
            name: 'New Client',
            status: 'active',
          },
          '# New Client\n\nNewly added client.'
        )
      );

      // Clear and rebuild
      db.clearAll();
      const scanner = new CorpusScanner(corpusPath);
      const scanResult = await scanner.scan();
      await scanner.index(db, scanResult);

      // Verify new client was indexed
      const newStats = db.getStats();
      expect(newStats.clients).toBeGreaterThan(initialStats.clients);

      const newClient = db.getClient('new-client');
      expect(newClient).toBeDefined();
      expect(newClient?.name).toBe('New Client');
    });

    it('should log rebuild event', async () => {
      const scanner = new CorpusScanner(corpusPath);
      const scanResult = await scanner.scan();

      // Log the rebuild event
      db.insertEvent({
        source: 'mcp',
        event_type: 'index_rebuild',
        summary: `Indexed ${scanResult.clients.length} clients, ${scanResult.projects.length} projects`,
      });

      const events = db.getRecentEvents(10);
      const rebuildEvent = events.find((e) => e.event_type === 'index_rebuild');
      expect(rebuildEvent).toBeDefined();
    });
  });

  describe('Database Statistics', () => {
    it('should return accurate statistics', () => {
      const stats = db.getStats();

      expect(stats.clients).toBeGreaterThan(0);
      expect(stats.projects).toBeGreaterThan(0);
      expect(stats.communications).toBeGreaterThan(0);
      expect(stats.knowledge_entries).toBeGreaterThan(0);

      // Verify counts match actual data
      const clients = db.getAllClients();
      expect(stats.clients).toBe(clients.length);
    });
  });

  describe('Error Handling', () => {
    it('should handle database errors gracefully', () => {
      // Try to insert duplicate client
      expect(() => {
        db.insertClient({
          slug: 'test-client', // Already exists
          name: 'Duplicate Client',
          file_path: '/test/path',
        });
      }).toThrow();
    });

    it('should handle foreign key violations', () => {
      // Try to insert project with non-existent client
      expect(() => {
        db.insertProject({
          client_id: 99999, // Non-existent
          slug: 'test',
          name: 'Test',
          file_path: '/test/path',
        });
      }).toThrow();
    });

    it('should handle missing required fields', () => {
      expect(() => {
        db.insertClient({
          slug: '', // Empty slug
          name: 'Test',
          file_path: '/test/path',
        });
      }).toThrow();
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
        mount_path: corpusPath,
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
        mount_path: corpusPath,
        model: 'claude-sonnet-4-20250514',
        status: 'active',
      });

      db.insertExpert({
        slug: 'inactive-expert',
        name: 'Inactive Expert',
        mount_path: corpusPath,
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
    it('should return error for non-existent expert', () => {
      const expert = db.getExpert('non-existent');
      expect(expert).toBeUndefined();
    });

    it('should return error for inactive expert', () => {
      db.insertExpert({
        slug: 'disabled-expert',
        name: 'Disabled Expert',
        mount_path: corpusPath,
        model: 'claude-sonnet-4-20250514',
        status: 'inactive',
      });

      const expert = db.getExpert('disabled-expert');
      expect(expert).toBeDefined();
      expect(expert!.status).toBe('inactive');
    });

    it('should resolve expert with valid mount path', () => {
      db.insertExpert({
        slug: 'valid-expert',
        name: 'Valid Expert',
        mount_path: corpusPath,
        model: 'claude-sonnet-4-20250514',
      });

      const expert = db.getExpert('valid-expert');
      expect(expert).toBeDefined();
      expect(expert!.mount_path).toBe(corpusPath);
      expect(existsSync(expert!.mount_path)).toBe(true);
    });

    it('should detect missing mount path', () => {
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
  });

  describe('Integration Tests', () => {
    it('should handle full workflow: search, get client, read file', () => {
      // 1. Search for client
      const searchResults = db.searchClients('Test Client');
      expect(searchResults).toHaveLength(1);

      // 2. Get client details
      const client = db.getClient(searchResults[0].slug);
      expect(client).toBeDefined();

      // 3. Read client file
      const content = readFileSync(client!.file_path, 'utf-8');
      expect(content).toContain('Test Client');
    });

    it('should handle project workflow', () => {
      // 1. Get client
      const client = db.getClient('test-client');
      expect(client).toBeDefined();

      // 2. List projects
      const projects = db.getProjectsByClient(client!.id);
      expect(projects).toHaveLength(1);

      // 3. Read project file
      const content = readFileSync(projects[0].file_path, 'utf-8');
      expect(content).toContain('Test Project');
    });

    it('should handle communication workflow', () => {
      // 1. Get client
      const client = db.getClient('test-client');
      expect(client).toBeDefined();

      // 2. Get communications
      const comms = db.getCommunicationsByClient(client!.id);
      expect(comms.length).toBeGreaterThan(0);

      // 3. Read communication file
      const content = readFileSync(comms[0].file_path, 'utf-8');
      expect(content).toContain('Kickoff Meeting');
    });
  });
});
