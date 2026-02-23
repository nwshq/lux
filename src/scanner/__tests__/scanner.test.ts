import { describe, it, expect, beforeEach, vi } from 'vitest';
import { join } from 'path';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { GeneralScanner } from '../index.js';
import type { LuxDatabase } from '../../db/index.js';
import type { ScanResult } from '../types.js';

describe('GeneralScanner', () => {
  const fixturesPath = join(__dirname, 'fixtures');

  describe('constructor', () => {
    it('should create scanner with root path', () => {
      const scanner = new GeneralScanner('/test/path');
      expect(scanner).toBeInstanceOf(GeneralScanner);
    });

    it('should create scanner without root path', () => {
      const scanner = new GeneralScanner();
      expect(scanner).toBeInstanceOf(GeneralScanner);
    });
  });

  describe('scan()', () => {
    it('should throw error if no root path provided', async () => {
      const scanner = new GeneralScanner();
      await expect(scanner.scan()).rejects.toThrow(
        'Root path must be provided either to constructor or scan()'
      );
    });

    it('should use constructor root path if not provided to scan()', async () => {
      const scanner = new GeneralScanner(fixturesPath);
      const result = await scanner.scan();
      expect(result).toBeDefined();
      expect(result.clients).toBeInstanceOf(Array);
    });

    it('should use scan() root path over constructor path', async () => {
      const scanner = new GeneralScanner('/wrong/path');
      const result = await scanner.scan(fixturesPath);
      expect(result).toBeDefined();
      expect(result.clients).toBeInstanceOf(Array);
    });

    it('should scan clients correctly', async () => {
      const scanner = new GeneralScanner(fixturesPath);
      const result = await scanner.scan();

      expect(result.clients).toHaveLength(1);

      const client = result.clients[0];
      expect(client.slug).toBe('test-client-1');
      expect(client.name).toBe('Test Client One');
      expect(client.type).toBe('enterprise');
      expect(client.status).toBe('active');
      expect(client.filePath).toContain('README.md');
      expect(client.content).toContain('This is a test client');
    });

    it('should scan projects correctly', async () => {
      const scanner = new GeneralScanner(fixturesPath);
      const result = await scanner.scan();

      expect(result.projects).toHaveLength(1);

      const project = result.projects[0];
      expect(project.clientSlug).toBe('test-client-1');
      expect(project.slug).toBe('test-project');
      expect(project.name).toBe('Test Project');
      expect(project.status).toBe('in-progress');
      expect(project.filePath).toContain('README.md');
      expect(project.content).toContain('This is a test project');
    });

    it('should detect explorations/ and payloads/ subdirs in projects', async () => {
      const scanner = new GeneralScanner(fixturesPath);
      const result = await scanner.scan();

      const project = result.projects[0];
      expect(project.hasExplorations).toBe(true);
      expect(project.hasPayloads).toBe(true);
    });

    it('should set hasExplorations/hasPayloads to false when subdirs missing', async () => {
      const tempPath = join(__dirname, 'temp-no-subdirs');
      const clientPath = join(tempPath, 'knowledge/10_clients/test-client');

      try {
        mkdirSync(join(clientPath, 'bare-project'), { recursive: true });
        writeFileSync(join(clientPath, 'README.md'), '---\nname: Test Client\n---\n');
        writeFileSync(
          join(clientPath, 'bare-project', 'README.md'),
          '---\nname: Bare Project\n---\n'
        );

        const scanner = new GeneralScanner(tempPath);
        const result = await scanner.scan();

        const project = result.projects[0];
        expect(project.hasExplorations).toBe(false);
        expect(project.hasPayloads).toBe(false);
      } finally {
        if (existsSync(tempPath)) {
          rmSync(tempPath, { recursive: true, force: true });
        }
      }
    });

    it('should scan project-scoped explorations as knowledge entries', async () => {
      const scanner = new GeneralScanner(fixturesPath);
      const result = await scanner.scan();

      const projectExploration = result.knowledge.find(
        (k) =>
          k.type === 'exploration' &&
          k.clientSlug === 'test-client-1' &&
          k.projectSlug === 'test-project'
      );
      expect(projectExploration).toBeDefined();
      expect(projectExploration?.title).toBe('API Design Exploration');
      expect(projectExploration?.tags).toEqual(['api', 'design']);
      expect(projectExploration?.filePath).toContain('explorations/2026-02-15-api-design.md');
    });

    it('should scan project-scoped payloads as knowledge entries', async () => {
      const scanner = new GeneralScanner(fixturesPath);
      const result = await scanner.scan();

      const projectPayload = result.knowledge.find(
        (k) =>
          k.type === 'payload' &&
          k.clientSlug === 'test-client-1' &&
          k.projectSlug === 'test-project'
      );
      expect(projectPayload).toBeDefined();
      expect(projectPayload?.title).toBe('Feature Implementation Tasks');
      expect(projectPayload?.filePath).toContain('payloads/2026-02-15-feature/TASKS.md');
    });

    it('should skip special directories for projects', async () => {
      // Create a temporary test directory with special folders
      const tempPath = join(__dirname, 'temp-fixtures');
      const clientPath = join(tempPath, 'knowledge/10_clients/temp-client');

      try {
        mkdirSync(clientPath, { recursive: true });
        mkdirSync(join(clientPath, 'communications'), { recursive: true });
        mkdirSync(join(clientPath, '_meta'), { recursive: true });
        mkdirSync(join(clientPath, 'archive'), { recursive: true });
        mkdirSync(join(clientPath, 'implementation-payloads'), { recursive: true });
        mkdirSync(join(clientPath, 'hiring'), { recursive: true });
        mkdirSync(join(clientPath, 'valid-project'), { recursive: true });

        writeFileSync(join(clientPath, 'README.md'), '---\nname: Temp Client\n---\n');
        writeFileSync(
          join(clientPath, 'valid-project', 'README.md'),
          '---\nname: Valid Project\n---\n'
        );

        const scanner = new GeneralScanner(tempPath);
        const result = await scanner.scan();

        // Should only find the valid-project, not the special directories
        expect(result.projects).toHaveLength(1);
        expect(result.projects[0].slug).toBe('valid-project');
      } finally {
        if (existsSync(tempPath)) {
          rmSync(tempPath, { recursive: true, force: true });
        }
      }
    });

    it('should scan communications correctly', async () => {
      const scanner = new GeneralScanner(fixturesPath);
      const result = await scanner.scan();

      expect(result.communications).toHaveLength(1);

      const comm = result.communications[0];
      expect(comm.clientSlug).toBe('test-client-1');
      expect(comm.type).toBe('meeting');
      expect(comm.subject).toBe('Kickoff Meeting');
      expect(comm.dateRange).toBe('2024-01-15');
      expect(comm.participants).toEqual(['Alice', 'Bob']);
      expect(comm.content).toContain('Discussion about project requirements');
    });

    it('should extract date from filename for communications', async () => {
      const scanner = new GeneralScanner(fixturesPath);
      const result = await scanner.scan();

      const comm = result.communications[0];
      expect(comm.dateRange).toBe('2024-01-15');
    });

    it('should infer communication type from filename', async () => {
      const tempPath = join(__dirname, 'temp-comm-fixtures');
      const commsPath = join(tempPath, 'knowledge/10_clients/test/communications');

      try {
        mkdirSync(commsPath, { recursive: true });
        mkdirSync(join(tempPath, 'knowledge/10_clients/test'), { recursive: true });

        writeFileSync(
          join(tempPath, 'knowledge/10_clients/test/README.md'),
          '---\nname: Test\n---\n'
        );
        writeFileSync(join(commsPath, '2024-01-01_email-thread.md'), '# Email');
        writeFileSync(join(commsPath, '2024-01-02_slack-conversation.md'), '# Slack');
        writeFileSync(join(commsPath, '2024-01-03_call-notes.md'), '# Call');

        const scanner = new GeneralScanner(tempPath);
        const result = await scanner.scan();

        expect(result.communications).toHaveLength(3);
        expect(result.communications.find((c) => c.filePath.includes('email'))?.type).toBe('email');
        expect(result.communications.find((c) => c.filePath.includes('slack'))?.type).toBe('slack');
        expect(result.communications.find((c) => c.filePath.includes('call'))?.type).toBe('call');
      } finally {
        if (existsSync(tempPath)) {
          rmSync(tempPath, { recursive: true, force: true });
        }
      }
    });

    it('should scan knowledge entries correctly', async () => {
      const scanner = new GeneralScanner(fixturesPath);
      const result = await scanner.scan();

      expect(result.knowledge.length).toBeGreaterThan(0);

      const methodologyEntry = result.knowledge.find((k) => k.type === 'methodology');
      expect(methodologyEntry).toBeDefined();
      expect(methodologyEntry?.title).toBe('Agile Development Process');
      expect(methodologyEntry?.tags).toEqual(['agile', 'process']);
      expect(methodologyEntry?.content).toContain('Our standard agile methodology');
    });

    it('should infer knowledge type from directory path', async () => {
      const scanner = new GeneralScanner(fixturesPath);
      const result = await scanner.scan();

      const methodologyEntry = result.knowledge.find((k) => k.filePath.includes('methodology'));
      expect(methodologyEntry?.type).toBe('methodology');
    });

    it('should handle client directory without markdown files', async () => {
      const tempPath = join(__dirname, 'temp-no-md');
      const clientPath = join(tempPath, 'knowledge/10_clients/no-md-client');

      try {
        mkdirSync(clientPath, { recursive: true });
        mkdirSync(join(clientPath, 'some-project'), { recursive: true });

        const scanner = new GeneralScanner(tempPath);
        const result = await scanner.scan();

        // Should still create client entry using directory as reference
        expect(result.clients).toHaveLength(1);
        expect(result.clients[0].slug).toBe('no-md-client');
        expect(result.clients[0].name).toBe('No Md Client'); // Slug to title conversion
        expect(result.clients[0].filePath).toBe(clientPath);
      } finally {
        if (existsSync(tempPath)) {
          rmSync(tempPath, { recursive: true, force: true });
        }
      }
    });

    it('should try multiple file candidates for client metadata', async () => {
      const tempPath = join(__dirname, 'temp-multiple-files');
      const clientPath = join(tempPath, 'knowledge/10_clients/multi-client');

      try {
        mkdirSync(clientPath, { recursive: true });

        // Create AGENTS.md (second priority)
        writeFileSync(join(clientPath, 'AGENTS.md'), '---\nname: From Agents\n---\n# Agent file');

        const scanner = new GeneralScanner(tempPath);
        const result = await scanner.scan();

        expect(result.clients[0].name).toBe('From Agents');
        expect(result.clients[0].filePath).toContain('AGENTS.md');
      } finally {
        if (existsSync(tempPath)) {
          rmSync(tempPath, { recursive: true, force: true });
        }
      }
    });

    it('should handle empty root directory', async () => {
      const tempPath = join(__dirname, 'temp-empty');

      try {
        mkdirSync(tempPath, { recursive: true });
        mkdirSync(join(tempPath, 'knowledge/10_clients'), { recursive: true });

        const scanner = new GeneralScanner(tempPath);
        const result = await scanner.scan();

        expect(result.clients).toHaveLength(0);
        expect(result.projects).toHaveLength(0);
        expect(result.communications).toHaveLength(0);
        expect(result.knowledge).toHaveLength(0);
      } finally {
        if (existsSync(tempPath)) {
          rmSync(tempPath, { recursive: true, force: true });
        }
      }
    });
  });

  describe('index()', () => {
    let mockDb: LuxDatabase;
    let scanResult: ScanResult;

    beforeEach(() => {
      // Create mock database
      mockDb = {
        insertClient: vi.fn((client) => {
          if (!client.slug || !client.name) throw new Error('Invalid client data');
          return 1;
        }),
        insertProject: vi.fn((project) => {
          if (!project.client_id || !project.slug) throw new Error('Invalid project data');
          return 1;
        }),
        insertCommunication: vi.fn(() => 1),
        insertKnowledgeEntry: vi.fn(() => 1),
      } as unknown as LuxDatabase;

      // Create valid scan result
      scanResult = {
        clients: [
          {
            slug: 'test-client',
            name: 'Test Client',
            filePath: '/test/client/README.md',
            content: 'Test content',
          },
        ],
        projects: [
          {
            clientSlug: 'test-client',
            slug: 'test-project',
            name: 'Test Project',
            filePath: '/test/project/README.md',
            content: 'Project content',
          },
        ],
        communications: [
          {
            clientSlug: 'test-client',
            type: 'email',
            subject: 'Test Email',
            filePath: '/test/comm.md',
            content: 'Email content',
          },
        ],
        knowledge: [
          {
            type: 'methodology',
            title: 'Test Knowledge',
            filePath: '/test/knowledge.md',
            content: 'Knowledge content',
          },
        ],
      };
    });

    it('should throw error if database not provided', async () => {
      const scanner = new GeneralScanner();
      await expect(scanner.index(null as any, scanResult)).rejects.toThrow(
        'Database instance is required for indexing'
      );
    });

    it('should throw error if scan result is invalid', async () => {
      const scanner = new GeneralScanner();
      await expect(scanner.index(mockDb, null as any)).rejects.toThrow(
        'Invalid scan result: must be an object'
      );
    });

    it('should throw error if clients array is missing', async () => {
      const scanner = new GeneralScanner();
      const invalidResult = { ...scanResult, clients: undefined as any };
      await expect(scanner.index(mockDb, invalidResult)).rejects.toThrow(
        'Invalid scan result: clients must be an array'
      );
    });

    it('should index all entities successfully', async () => {
      const scanner = new GeneralScanner();
      const result = await scanner.index(mockDb, scanResult);

      expect(result).toEqual({
        clients: 1,
        projects: 1,
        communications: 1,
        knowledge: 1,
      });

      expect(mockDb.insertClient).toHaveBeenCalledTimes(1);
      expect(mockDb.insertProject).toHaveBeenCalledTimes(1);
      expect(mockDb.insertCommunication).toHaveBeenCalledTimes(1);
      expect(mockDb.insertKnowledgeEntry).toHaveBeenCalledTimes(1);
    });

    it('should validate client data before indexing', async () => {
      const scanner = new GeneralScanner();
      const invalidResult = {
        ...scanResult,
        clients: [{ slug: '', name: 'Test', filePath: '/test' }],
      };

      await expect(scanner.index(mockDb, invalidResult)).rejects.toThrow(
        'Invalid client: missing or invalid slug'
      );
    });

    it('should validate project data before indexing', async () => {
      const scanner = new GeneralScanner();
      const invalidResult = {
        ...scanResult,
        projects: [
          {
            clientSlug: '',
            slug: 'test',
            name: 'Test',
            filePath: '/test',
          },
        ],
      };

      await expect(scanner.index(mockDb, invalidResult)).rejects.toThrow(
        'Invalid project: missing or invalid clientSlug'
      );
    });

    it('should throw error if client not found for project', async () => {
      const scanner = new GeneralScanner();
      const invalidResult = {
        ...scanResult,
        projects: [
          {
            clientSlug: 'non-existent',
            slug: 'test',
            name: 'Test',
            filePath: '/test',
          },
        ],
      };

      await expect(scanner.index(mockDb, invalidResult)).rejects.toThrow(
        'Client "non-existent" not found for project "test"'
      );
    });

    it('should validate communication data before indexing', async () => {
      const scanner = new GeneralScanner();
      const invalidResult = {
        ...scanResult,
        communications: [
          {
            clientSlug: '',
            type: 'email',
            filePath: '/test',
          },
        ],
      };

      await expect(scanner.index(mockDb, invalidResult)).rejects.toThrow(
        'Invalid communication: missing or invalid clientSlug'
      );
    });

    it('should throw error if client not found for communication', async () => {
      const scanner = new GeneralScanner();
      const invalidResult = {
        ...scanResult,
        communications: [
          {
            clientSlug: 'non-existent',
            type: 'email',
            subject: 'Test',
            filePath: '/test',
          },
        ],
      };

      await expect(scanner.index(mockDb, invalidResult)).rejects.toThrow(
        'Client "non-existent" not found for communication'
      );
    });

    it('should validate knowledge data before indexing', async () => {
      const scanner = new GeneralScanner();
      const invalidResult = {
        ...scanResult,
        knowledge: [
          {
            type: '',
            title: 'Test',
            filePath: '/test',
          },
        ],
      };

      await expect(scanner.index(mockDb, invalidResult)).rejects.toThrow(
        'Invalid knowledge entry: missing or invalid type'
      );
    });

    it('should handle database insertion errors gracefully', async () => {
      const scanner = new GeneralScanner();
      const errorDb = {
        ...mockDb,
        insertClient: vi.fn(() => {
          throw new Error('Database error');
        }),
      } as unknown as LuxDatabase;

      await expect(scanner.index(errorDb, scanResult)).rejects.toThrow(
        'Failed to insert client "test-client"'
      );
    });

    it('should provide partial index information on error', async () => {
      const scanner = new GeneralScanner();

      // Mock DB that fails on projects
      const partialDb = {
        insertClient: vi.fn(() => 1),
        insertProject: vi.fn(() => {
          throw new Error('Project insertion failed');
        }),
        insertCommunication: vi.fn(() => 1),
        insertKnowledgeEntry: vi.fn(() => 1),
      } as unknown as LuxDatabase;

      try {
        await scanner.index(partialDb, scanResult);
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain('Partial index created: 1 clients');
      }
    });

    it('should handle knowledge entries with clientSlug', async () => {
      const scanner = new GeneralScanner();
      const resultWithClientKnowledge: ScanResult = {
        clients: [
          {
            slug: 'test-client',
            name: 'Test Client',
            filePath: '/test/client/README.md',
            content: 'Test content',
          },
        ],
        projects: [],
        communications: [],
        knowledge: [
          {
            clientSlug: 'test-client',
            type: 'methodology',
            title: 'Client Knowledge',
            filePath: '/test/knowledge.md',
            content: 'Knowledge content',
          },
        ],
      };

      const clientIdCapture = { id: 0 };
      const knowledgeCapture = { clientId: 0 };

      const trackingDb = {
        insertClient: vi.fn(() => {
          clientIdCapture.id = 42;
          return 42;
        }),
        insertProject: vi.fn(() => 1),
        insertCommunication: vi.fn(() => 1),
        insertKnowledgeEntry: vi.fn((entry) => {
          knowledgeCapture.clientId = entry.client_id;
          return 1;
        }),
      } as unknown as LuxDatabase;

      await scanner.index(trackingDb, resultWithClientKnowledge);

      expect(knowledgeCapture.clientId).toBe(42);
    });

    it('should handle knowledge entries with projectSlug', async () => {
      const scanner = new GeneralScanner();
      const resultWithProjectKnowledge: ScanResult = {
        clients: [
          {
            slug: 'test-client',
            name: 'Test Client',
            filePath: '/test/client/README.md',
            content: 'Test content',
          },
        ],
        projects: [
          {
            clientSlug: 'test-client',
            slug: 'test-project',
            name: 'Test Project',
            filePath: '/test/project/README.md',
            content: 'Project content',
          },
        ],
        communications: [],
        knowledge: [
          {
            clientSlug: 'test-client',
            projectSlug: 'test-project',
            type: 'methodology',
            title: 'Project Knowledge',
            filePath: '/test/knowledge.md',
            content: 'Knowledge content',
          },
        ],
      };

      const projectIdCapture = { id: 0 };
      const knowledgeCapture = { projectId: 0 };

      const trackingDb = {
        insertClient: vi.fn(() => 1),
        insertProject: vi.fn(() => {
          projectIdCapture.id = 99;
          return 99;
        }),
        insertCommunication: vi.fn(() => 1),
        insertKnowledgeEntry: vi.fn((entry) => {
          knowledgeCapture.projectId = entry.project_id;
          return 1;
        }),
      } as unknown as LuxDatabase;

      await scanner.index(trackingDb, resultWithProjectKnowledge);

      expect(knowledgeCapture.projectId).toBe(99);
    });

    it('should throw wrapped error for knowledge insertion failures', async () => {
      const scanner = new GeneralScanner();

      const errorDb = {
        insertClient: vi.fn(() => 1),
        insertProject: vi.fn(() => 1),
        insertCommunication: vi.fn(() => 1),
        insertKnowledgeEntry: vi.fn(() => {
          throw new Error('DB constraint violation');
        }),
      } as unknown as LuxDatabase;

      await expect(scanner.index(errorDb, scanResult)).rejects.toThrow(
        'Failed to insert knowledge entry "Test Knowledge"'
      );
    });

    it('should handle non-Error exceptions during indexing', async () => {
      const scanner = new GeneralScanner();

      const errorDb = {
        insertClient: vi.fn(() => 1),
        insertProject: vi.fn(() => 1),
        insertCommunication: vi.fn(() => 1),
        insertKnowledgeEntry: vi.fn(() => {
          throw 'String error'; // Non-Error exception
        }),
      } as unknown as LuxDatabase;

      await expect(scanner.index(errorDb, scanResult)).rejects.toThrow();
    });

    it('should validate communication type', async () => {
      const scanner = new GeneralScanner();
      const invalidResult = {
        ...scanResult,
        communications: [
          {
            clientSlug: 'test-client',
            type: '',
            filePath: '/test',
          },
        ],
      };

      await expect(scanner.index(mockDb, invalidResult)).rejects.toThrow(
        'Invalid communication: missing or invalid type'
      );
    });

    it('should validate knowledge title', async () => {
      const scanner = new GeneralScanner();
      const invalidResult = {
        ...scanResult,
        knowledge: [
          {
            type: 'methodology',
            title: '',
            filePath: '/test',
          },
        ],
      };

      await expect(scanner.index(mockDb, invalidResult)).rejects.toThrow(
        'Invalid knowledge entry: missing or invalid title'
      );
    });

    it('should handle communications with projectSlug', async () => {
      const scanner = new GeneralScanner();
      const resultWithProjectComm: ScanResult = {
        clients: [
          {
            slug: 'test-client',
            name: 'Test Client',
            filePath: '/test/client/README.md',
            content: 'Test content',
          },
        ],
        projects: [
          {
            clientSlug: 'test-client',
            slug: 'test-project',
            name: 'Test Project',
            filePath: '/test/project/README.md',
            content: 'Project content',
          },
        ],
        communications: [
          {
            clientSlug: 'test-client',
            projectSlug: 'test-project',
            type: 'email',
            subject: 'Project Email',
            filePath: '/test/comm.md',
            content: 'Email content',
          },
        ],
        knowledge: [],
      };

      const commCapture = { projectId: undefined as number | undefined };

      const trackingDb = {
        insertClient: vi.fn(() => 1),
        insertProject: vi.fn(() => 77),
        insertCommunication: vi.fn((entry) => {
          commCapture.projectId = entry.project_id;
          return 1;
        }),
        insertKnowledgeEntry: vi.fn(() => 1),
      } as unknown as LuxDatabase;

      await scanner.index(trackingDb, resultWithProjectComm);

      expect(commCapture.projectId).toBe(77);
    });

    it('should handle empty scan result', async () => {
      const scanner = new GeneralScanner();
      const emptyResult: ScanResult = {
        clients: [],
        projects: [],
        communications: [],
        knowledge: [],
      };

      const result = await scanner.index(mockDb, emptyResult);

      expect(result).toEqual({
        clients: 0,
        projects: 0,
        communications: 0,
        knowledge: 0,
      });
    });

    it('should pass metadata and content to database', async () => {
      const scanner = new GeneralScanner();
      const resultWithMetadata: ScanResult = {
        clients: [
          {
            slug: 'test-client',
            name: 'Test Client',
            type: 'enterprise',
            status: 'active',
            filePath: '/test/client/README.md',
            frontmatter: { name: 'Test Client', custom: 'value' },
            content: 'Test content',
          },
        ],
        projects: [],
        communications: [],
        knowledge: [],
      };

      await scanner.index(mockDb, resultWithMetadata);

      expect(mockDb.insertClient).toHaveBeenCalledWith({
        slug: 'test-client',
        name: 'Test Client',
        type: 'enterprise',
        status: 'active',
        file_path: '/test/client/README.md',
        metadata: { name: 'Test Client', custom: 'value' },
        content: 'Test content',
      });
    });
  });

  describe('private helper methods', () => {
    describe('slugToTitle', () => {
      it('should convert slug to title case', async () => {
        const tempPath = join(__dirname, 'temp-slug');
        const clientPath = join(tempPath, 'knowledge/10_clients/test-client-name');

        try {
          mkdirSync(clientPath, { recursive: true });

          const scanner = new GeneralScanner(tempPath);
          const result = await scanner.scan();

          expect(result.clients[0].name).toBe('Test Client Name');
        } finally {
          if (existsSync(tempPath)) {
            rmSync(tempPath, { recursive: true, force: true });
          }
        }
      });
    });

    describe('extractTitleFromFilename', () => {
      it('should remove date prefix and convert to title', async () => {
        const tempPath = join(__dirname, 'temp-title');
        const commsPath = join(tempPath, 'knowledge/10_clients/test/communications');

        try {
          mkdirSync(commsPath, { recursive: true });
          mkdirSync(join(tempPath, 'knowledge/10_clients/test'), { recursive: true });

          writeFileSync(
            join(tempPath, 'knowledge/10_clients/test/README.md'),
            '---\nname: Test\n---\n'
          );
          writeFileSync(join(commsPath, '2024-01-15_project-kickoff.md'), '# Meeting');

          const scanner = new GeneralScanner(tempPath);
          const result = await scanner.scan();

          expect(result.communications[0].subject).toBe('Project Kickoff');
        } finally {
          if (existsSync(tempPath)) {
            rmSync(tempPath, { recursive: true, force: true });
          }
        }
      });
    });

    describe('inferCommType', () => {
      it('should infer type "other" for unknown communication files', async () => {
        const tempPath = join(__dirname, 'temp-other');
        const commsPath = join(tempPath, 'knowledge/10_clients/test/communications');

        try {
          mkdirSync(commsPath, { recursive: true });
          mkdirSync(join(tempPath, 'knowledge/10_clients/test'), { recursive: true });

          writeFileSync(
            join(tempPath, 'knowledge/10_clients/test/README.md'),
            '---\nname: Test\n---\n'
          );
          writeFileSync(join(commsPath, 'random-notes.md'), '# Notes');

          const scanner = new GeneralScanner(tempPath);
          const result = await scanner.scan();

          expect(result.communications[0].type).toBe('other');
        } finally {
          if (existsSync(tempPath)) {
            rmSync(tempPath, { recursive: true, force: true });
          }
        }
      });
    });

    describe('inferKnowledgeType', () => {
      it('should respect frontmatter type over directory inference', async () => {
        const tempPath = join(__dirname, 'temp-type');
        const knowledgePath = join(tempPath, 'knowledge/20_methodology');

        try {
          mkdirSync(knowledgePath, { recursive: true });
          writeFileSync(
            join(knowledgePath, 'custom.md'),
            '---\ntitle: Custom\ntype: custom-type\n---\n# Custom'
          );

          const scanner = new GeneralScanner(tempPath);
          const result = await scanner.scan();

          expect(result.knowledge[0].type).toBe('custom-type');
        } finally {
          if (existsSync(tempPath)) {
            rmSync(tempPath, { recursive: true, force: true });
          }
        }
      });
    });
  });
});
