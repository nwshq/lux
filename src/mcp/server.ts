#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { LuxDatabase } from '../db/index.js';
import { CorpusScanner } from '../scanner/index.js';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { createMarkdownWithFrontmatter } from '../utils/frontmatter.js';

const execFileAsync = promisify(execFile);

const DEFAULT_DB_PATH = join(homedir(), '.lux', 'lux.db');
const DEFAULT_CORPUS_PATH = join(homedir(), 'CORPUS');

// Ensure .lux directory exists
mkdirSync(dirname(DEFAULT_DB_PATH), { recursive: true });

const db = new LuxDatabase(DEFAULT_DB_PATH);

const server = new Server(
  {
    name: 'lux-knowledge-platform',
    version: '0.1.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Tool definitions
const TOOLS: Tool[] = [
  {
    name: 'lux_search',
    description:
      'Search for clients, projects, communications, or knowledge entries in CORPUS by metadata. Returns entity type, title, slug, and file path.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query string',
        },
        type: {
          type: 'string',
          enum: ['all', 'client', 'project', 'comm', 'knowledge'],
          description: 'Filter by entity type',
          default: 'all',
        },
        client: {
          type: 'string',
          description: 'Filter by client slug (optional)',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results',
          default: 20,
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'lux_get_client',
    description:
      'Get detailed information about a specific client including file path and metadata.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: {
          type: 'string',
          description: 'Client slug',
        },
      },
      required: ['slug'],
    },
  },
  {
    name: 'lux_list_projects',
    description: 'List all projects for a given client.',
    inputSchema: {
      type: 'object',
      properties: {
        client_slug: {
          type: 'string',
          description: 'Client slug',
        },
      },
      required: ['client_slug'],
    },
  },
  {
    name: 'lux_log_comm',
    description:
      'Log a new communication (email, slack, meeting, call, etc.). Creates a markdown file with frontmatter and indexes it.',
    inputSchema: {
      type: 'object',
      properties: {
        client_slug: {
          type: 'string',
          description: 'Client slug',
        },
        project_slug: {
          type: 'string',
          description: 'Project slug (optional)',
        },
        type: {
          type: 'string',
          description: 'Communication type (email, slack, meeting, call, etc.)',
        },
        subject: {
          type: 'string',
          description: 'Communication subject or title',
        },
        date: {
          type: 'string',
          description: 'Date in YYYY-MM-DD format',
        },
        participants: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of participants',
        },
        content: {
          type: 'string',
          description: 'Communication content (markdown)',
        },
      },
      required: ['client_slug', 'type', 'subject', 'date'],
    },
  },
  {
    name: 'lux_log_event',
    description: 'Log an event to the audit trail for tracking system activity.',
    inputSchema: {
      type: 'object',
      properties: {
        source: {
          type: 'string',
          description: 'Event source (e.g., mcp, cli, scanner)',
        },
        event_type: {
          type: 'string',
          description: 'Type of event',
        },
        summary: {
          type: 'string',
          description: 'Event summary',
        },
        client_slug: {
          type: 'string',
          description: 'Related client slug (optional)',
        },
        project_slug: {
          type: 'string',
          description: 'Related project slug (optional)',
        },
        payload: {
          type: 'object',
          description: 'Additional event data (optional)',
        },
      },
      required: ['source', 'event_type', 'summary'],
    },
  },
  {
    name: 'lux_get_file',
    description: 'Read and return the content of a CORPUS file by path.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Absolute or relative file path',
        },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'lux_rebuild_index',
    description:
      'Rebuild the entire index by scanning CORPUS directory. This should be run after CORPUS files are updated.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'lux_list_experts',
    description:
      'List all registered domain experts in the expert panel. Returns expert slug, name, mount path, model, and status.',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['active', 'inactive', 'all'],
          description: 'Filter by expert status',
          default: 'all',
        },
      },
    },
  },
  {
    name: 'lux_ask',
    description:
      'Ask a domain expert a question. Spawns a Claude session scoped to the expert\'s CORPUS mount path with their configured model and system prompt. Returns the expert\'s response.',
    inputSchema: {
      type: 'object',
      properties: {
        expert: {
          type: 'string',
          description: 'Expert slug identifying which expert to ask',
        },
        question: {
          type: 'string',
          description: 'The question or prompt to send to the expert',
        },
      },
      required: ['expert', 'question'],
    },
  },
];

// Tool handlers
server.setRequestHandler(ListToolsRequestSchema, () => {
  return { tools: TOOLS };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'lux_search': {
        const {
          query,
          type = 'all',
          client,
          limit = 20,
        } = args as {
          query: string;
          type?: string;
          client?: string;
          limit?: number;
        };

        const results: Array<{
          type: string;
          title: string;
          slug?: string;
          path: string;
          context?: string;
        }> = [];

        try {
          // Use FTS5 search by default
          // Search clients
          if (type === 'all' || type === 'client') {
            const clients = db.searchClients(query);
            for (const c of clients) {
              results.push({
                type: 'client',
                title: c.name,
                slug: c.slug,
                path: c.file_path,
                context: c.status,
              });
            }
          }

          // Search projects
          if (type === 'all' || type === 'project') {
            const projects = db.searchProjects(query);
            for (const p of projects) {
              // Filter by client if specified
              if (client && p.client_slug !== client) continue;

              results.push({
                type: 'project',
                title: `${p.client_slug}/${p.name}`,
                slug: p.slug,
                path: p.file_path,
                context: p.status,
              });
            }
          }

          // Search communications
          if (type === 'all' || type === 'comm') {
            const communications = db.searchCommunications(query);
            for (const comm of communications) {
              // Filter by client if specified
              if (client) {
                const clientRecord = db.getAllClients().find((c) => c.id === comm.client_id);
                if (!clientRecord || clientRecord.slug !== client) continue;
              }

              const subject = comm.subject ?? '';
              results.push({
                type: 'communication',
                title: `[${comm.type}] ${subject}`,
                path: comm.file_path,
                context: comm.date_range,
              });
            }
          }

          // Search knowledge entries
          if (type === 'all' || type === 'knowledge') {
            const entries = db.searchKnowledgeEntries(query);
            for (const entry of entries) {
              // Filter by client if specified
              if (client && entry.client_id) {
                const clientRecord = db.getAllClients().find((c) => c.id === entry.client_id);
                if (!clientRecord || clientRecord.slug !== client) continue;
              }

              results.push({
                type: 'knowledge',
                title: entry.title,
                path: entry.file_path,
                context: entry.type,
              });
            }
          }
        } catch (error) {
          // If FTS5 fails (e.g., schema not migrated), fall back to legacy search
          console.error(
            'FTS5 search failed, falling back to legacy search:',
            (error as Error).message
          );

          const searchQuery = query.toLowerCase();

          // Legacy search - clients
          if (type === 'all' || type === 'client') {
            const clients = db.getAllClients();
            for (const c of clients) {
              if (
                c.slug.toLowerCase().includes(searchQuery) ||
                c.name.toLowerCase().includes(searchQuery)
              ) {
                results.push({
                  type: 'client',
                  title: c.name,
                  slug: c.slug,
                  path: c.file_path,
                  context: c.status,
                });
              }
            }
          }

          // Legacy search - projects
          if (type === 'all' || type === 'project') {
            const clients = client
              ? [db.getClient(client)].filter((c) => c !== undefined)
              : db.getAllClients();
            for (const c of clients) {
              if (!c) continue;
              const projects = db.getProjectsByClient(c.id);
              for (const p of projects) {
                if (
                  p.slug.toLowerCase().includes(searchQuery) ||
                  p.name.toLowerCase().includes(searchQuery)
                ) {
                  results.push({
                    type: 'project',
                    title: `${c.slug}/${p.name}`,
                    slug: p.slug,
                    path: p.file_path,
                    context: p.status,
                  });
                }
              }
            }
          }

          // Legacy search - communications
          if (type === 'all' || type === 'comm') {
            const clients = client
              ? [db.getClient(client)].filter((c) => c !== undefined)
              : db.getAllClients();
            for (const c of clients) {
              if (!c) continue;
              const comms = db.getCommunicationsByClient(c.id);
              for (const comm of comms) {
                const subject = comm.subject ?? '';
                if (
                  subject.toLowerCase().includes(searchQuery) ||
                  comm.type.toLowerCase().includes(searchQuery)
                ) {
                  results.push({
                    type: 'communication',
                    title: `[${comm.type}] ${subject}`,
                    path: comm.file_path,
                    context: comm.date_range,
                  });
                }
              }
            }
          }

          // Legacy search - knowledge
          if (type === 'all' || type === 'knowledge') {
            const types = [
              'methodology',
              'spec',
              'architecture',
              'exploration',
              'implementation-payload',
              'general',
            ];
            const allKnowledge = types.flatMap((t) => db.getKnowledgeEntriesByType(t));
            for (const entry of allKnowledge) {
              if (
                entry.title.toLowerCase().includes(searchQuery) ||
                entry.type.toLowerCase().includes(searchQuery)
              ) {
                results.push({
                  type: 'knowledge',
                  title: entry.title,
                  path: entry.file_path,
                  context: entry.type,
                });
              }
            }
          }
        }

        // Log search event
        db.insertEvent({
          source: 'mcp',
          event_type: 'search',
          summary: `Search query: "${query}" (type: ${type}, results: ${results.length})`,
          payload: {
            query,
            type,
            client,
            limit,
            results_count: results.length,
          },
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(results.slice(0, limit), null, 2),
            },
          ],
        };
      }

      case 'lux_get_client': {
        const { slug } = args as { slug: string };
        const client = db.getClient(slug);

        if (!client) {
          return {
            content: [{ type: 'text', text: `Client not found: ${slug}` }],
            isError: true,
          };
        }

        const projects = db.getProjectsByClient(client.id);
        const comms = db.getCommunicationsByClient(client.id);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  client,
                  projects,
                  recent_communications: comms.slice(0, 10),
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case 'lux_list_projects': {
        const { client_slug } = args as { client_slug: string };
        const client = db.getClient(client_slug);

        if (!client) {
          return {
            content: [{ type: 'text', text: `Client not found: ${client_slug}` }],
            isError: true,
          };
        }

        const projects = db.getProjectsByClient(client.id);

        return {
          content: [{ type: 'text', text: JSON.stringify(projects, null, 2) }],
        };
      }

      case 'lux_log_comm': {
        const {
          client_slug,
          project_slug,
          type,
          subject,
          date,
          participants = [],
          content = '',
        } = args as {
          client_slug: string;
          project_slug?: string;
          type: string;
          subject: string;
          date: string;
          participants?: string[];
          content?: string;
        };

        const client = db.getClient(client_slug);
        if (!client) {
          return {
            content: [{ type: 'text', text: `Client not found: ${client_slug}` }],
            isError: true,
          };
        }

        let project;
        if (project_slug) {
          project = db.getProject(client_slug, project_slug);
          if (!project) {
            return {
              content: [
                { type: 'text', text: `Project not found: ${client_slug}/${project_slug}` },
              ],
              isError: true,
            };
          }
        }

        // Generate filename
        const subjectSlug = subject
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '');
        const filename = `${date}_${type}_${subjectSlug}.md`;

        // Determine file path
        const commsDir = join(dirname(client.file_path), project_slug ?? '', 'communications');
        mkdirSync(commsDir, { recursive: true });
        const filePath = join(commsDir, filename);

        // Generate file content with frontmatter
        const fileContent = createMarkdownWithFrontmatter(
          {
            type,
            subject,
            date,
            participants: participants.length > 0 ? participants : undefined,
          },
          content
        );

        // Write file
        writeFileSync(filePath, fileContent, 'utf-8');

        // Add to database
        db.insertCommunication({
          client_id: client.id,
          project_id: project?.id,
          type,
          subject,
          date_range: date,
          participants,
          file_path: filePath,
          metadata: {},
          content,
        });

        // Log event
        db.insertEvent({
          source: 'mcp',
          event_type: 'comm_logged',
          client_id: client.id,
          project_id: project?.id,
          summary: `Logged ${type}: ${subject}`,
          payload: { file_path: filePath },
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ success: true, file_path: filePath }, null, 2),
            },
          ],
        };
      }

      case 'lux_log_event': {
        const { source, event_type, summary, client_slug, project_slug, payload } = args as {
          source: string;
          event_type: string;
          summary: string;
          client_slug?: string;
          project_slug?: string;
          payload?: Record<string, unknown>;
        };

        let clientId;
        let projectId;

        if (client_slug) {
          const client = db.getClient(client_slug);
          if (client) {
            clientId = client.id;

            if (project_slug) {
              const project = db.getProject(client_slug, project_slug);
              if (project) projectId = project.id;
            }
          }
        }

        db.insertEvent({
          source,
          event_type,
          summary,
          client_id: clientId,
          project_id: projectId,
          payload,
        });

        return {
          content: [{ type: 'text', text: JSON.stringify({ success: true }, null, 2) }],
        };
      }

      case 'lux_get_file': {
        const { file_path } = args as { file_path: string };

        try {
          const content = readFileSync(file_path, 'utf-8');
          return {
            content: [{ type: 'text', text: content }],
          };
        } catch (error) {
          return {
            content: [{ type: 'text', text: `Error reading file: ${String(error)}` }],
            isError: true,
          };
        }
      }

      case 'lux_rebuild_index': {
        const scanner = new CorpusScanner(DEFAULT_CORPUS_PATH);
        const result = await scanner.scan();

        db.clearAll();

        // Use the scanner's index() method to write to database
        await scanner.index(db, result);

        db.insertEvent({
          source: 'mcp',
          event_type: 'index_rebuild',
          summary: `Indexed ${result.clients.length} clients, ${result.projects.length} projects, ${result.communications.length} communications, ${result.knowledge.length} knowledge entries`,
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  indexed: {
                    clients: result.clients.length,
                    projects: result.projects.length,
                    communications: result.communications.length,
                    knowledge: result.knowledge.length,
                  },
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case 'lux_list_experts': {
        const { status = 'all' } = args as { status?: string };

        let experts;
        if (status === 'all') {
          experts = db.getAllExperts();
        } else {
          experts = db.getExpertsByStatus(status);
        }

        const result = experts.map((e) => ({
          slug: e.slug,
          name: e.name,
          mount_path: e.mount_path,
          model: e.model,
          status: e.status,
          claude_md: e.claude_md_path
            ? existsSync(e.claude_md_path)
            : false,
        }));

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'lux_ask': {
        const { expert: expertSlug, question } = args as {
          expert: string;
          question: string;
        };

        const expert = db.getExpert(expertSlug);
        if (!expert) {
          return {
            content: [{ type: 'text', text: `Expert not found: ${expertSlug}` }],
            isError: true,
          };
        }

        if (expert.status !== 'active') {
          return {
            content: [
              { type: 'text', text: `Expert is not active: ${expertSlug} (status: ${expert.status})` },
            ],
            isError: true,
          };
        }

        if (!existsSync(expert.mount_path)) {
          return {
            content: [
              { type: 'text', text: `Expert mount path does not exist: ${expert.mount_path}` },
            ],
            isError: true,
          };
        }

        // Build claude CLI arguments
        const claudeArgs = ['--print', '--model', expert.model];

        // Append system prompt from claude.md if available
        if (expert.claude_md_path && existsSync(expert.claude_md_path)) {
          const systemPrompt = readFileSync(expert.claude_md_path, 'utf-8');
          claudeArgs.push('--system-prompt', systemPrompt);
        }

        claudeArgs.push(question);

        try {
          const { stdout } = await execFileAsync('claude', claudeArgs, {
            cwd: expert.mount_path,
            timeout: 300_000, // 5 minute timeout
            maxBuffer: 10 * 1024 * 1024, // 10MB
          });

          // Log the expert ask event
          db.insertEvent({
            source: 'mcp',
            event_type: 'expert_ask',
            summary: `Asked expert "${expert.name}": ${question.slice(0, 100)}`,
            payload: {
              expert_slug: expertSlug,
              question,
              response_length: stdout.length,
            },
          });

          return {
            content: [
              {
                type: 'text',
                text: stdout,
              },
            ],
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);

          db.insertEvent({
            source: 'mcp',
            event_type: 'expert_ask_error',
            summary: `Expert ask failed for "${expert.name}": ${message.slice(0, 200)}`,
            payload: {
              expert_slug: expertSlug,
              question,
              error: message,
            },
          });

          return {
            content: [
              { type: 'text', text: `Expert session failed: ${message}` },
            ],
            isError: true,
          };
        }
      }

      default:
        return {
          content: [{ type: 'text', text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${String(error)}` }],
      isError: true,
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Lux MCP server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
