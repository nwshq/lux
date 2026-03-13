#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { LuxDatabase } from '../db/index.js';
import { GeneralScanner } from '../scanner/index.js';
import { SubprocessSessionManager } from '../experts/subprocess-manager.js';
import { routeQuery } from '../experts/router.js';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { mkdirSync } from 'fs';

const DEFAULT_DB_PATH = process.env.LUX_DB_PATH || join(homedir(), '.lux', 'lux.db');
const DEFAULT_CORPUS_PATH = process.env.LUX_CORPUS_PATH || join(homedir(), 'CORPUS');

// Ensure .lux directory exists
mkdirSync(dirname(DEFAULT_DB_PATH), { recursive: true });

const db = new LuxDatabase(DEFAULT_DB_PATH);
const sessionManager = new SubprocessSessionManager(db);

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
      'Search all indexed documents. Returns document title and file path. Optionally filter by entity type.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query string',
        },
        type: {
          type: 'string',
          enum: ['all', 'knowledge'],
          description: 'Filter by entity type',
          default: 'all',
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
    description: 'Read and return the content of an indexed file by path.',
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
      'Rebuild the entire index by scanning the content directory. Run this after content files are updated.',
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
      'Ask a question to the expert panel. Auto-routes to the most relevant expert(s) using FTS5 search, or routes to a specific expert when expert_hint is provided. Returns a structured response with the answer, which experts were consulted, and the routing reason.',
    inputSchema: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: 'The question or prompt to send to the expert(s)',
        },
        expert_hint: {
          type: 'string',
          description: 'Optional expert slug to route to a specific expert instead of auto-routing',
        },
        context: {
          type: 'string',
          description:
            'Optional additional context to include with the question (e.g., relevant background information)',
        },
      },
      required: ['question'],
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
          limit = 20,
        } = args as {
          query: string;
          type?: string;
          limit?: number;
        };

        const results: Array<{
          type: string;
          title: string;
          path: string;
          context?: string;
        }> = [];

        try {
          if (type === 'all') {
            // Unified document search across all entity types
            const docs = db.searchAllDocuments(query);
            for (const doc of docs) {
              results.push({
                type: 'document',
                title: doc.title,
                path: doc.file_path,
              });
            }
          } else if (type === 'knowledge') {
            const entries = db.searchKnowledgeEntries(query);
            for (const entry of entries) {
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

      case 'lux_log_event': {
        const { source, event_type, summary, payload } = args as {
          source: string;
          event_type: string;
          summary: string;
          payload?: Record<string, unknown>;
        };

        db.insertEvent({
          source,
          event_type,
          summary,
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
        const scanner = new GeneralScanner(DEFAULT_CORPUS_PATH);
        const result = await scanner.scan();

        db.clearAll();

        // Use the scanner's index() method to write to database
        await scanner.index(db, result);

        db.insertEvent({
          source: 'mcp',
          event_type: 'index_rebuild',
          summary: `Indexed ${result.knowledge.length} knowledge entries`,
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  indexed: {
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
          claude_md: e.claude_md_path ? existsSync(e.claude_md_path) : false,
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
        const {
          question,
          expert_hint: expertHint,
          context,
        } = args as {
          question: string;
          expert_hint?: string;
          context?: string;
        };

        // Build the full question including context if provided
        const fullQuestion = context ? `${question}\n\nContext:\n${context}` : question;

        // If expert_hint is provided, route to that specific expert
        if (expertHint) {
          const expert = db.getExpert(expertHint);
          if (!expert) {
            return {
              content: [{ type: 'text', text: `Expert not found: ${expertHint}` }],
              isError: true,
            };
          }

          if (expert.status !== 'active') {
            return {
              content: [
                {
                  type: 'text',
                  text: `Expert is not active: ${expertHint} (status: ${expert.status})`,
                },
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

          try {
            const result = await sessionManager.query(expertHint, fullQuestion);

            db.insertEvent({
              source: 'mcp',
              event_type: 'expert_ask',
              summary: `Asked expert "${expert.name}": ${question.slice(0, 100)}`,
              payload: {
                expert_hint: expertHint,
                question,
                context: context ?? null,
                response_length: result.response.length,
              },
            });

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(
                    {
                      answer: result.response,
                      experts_consulted: [expertHint],
                      routing_reason: `Directly routed to expert "${expert.name}" via expert_hint`,
                    },
                    null,
                    2
                  ),
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
                expert_hint: expertHint,
                question,
                error: message,
              },
            });

            return {
              content: [{ type: 'text', text: `Expert session failed: ${message}` }],
              isError: true,
            };
          }
        }

        // No expert_hint — auto-route using the query router
        try {
          const routeResult = await routeQuery(fullQuestion, db, sessionManager, {
            maxExperts: 1,
          });

          if (routeResult.responses.length === 0) {
            return {
              content: [{ type: 'text', text: 'No experts were able to respond to this query.' }],
              isError: true,
            };
          }

          const expertsConsulted = routeResult.responses.map((r) => r.expertSlug);
          const answer = routeResult.responses[0].response;

          // Build routing reason
          let routingReason: string;
          if (routeResult.matchedExperts.some((m) => m.hits > 0)) {
            const matches = routeResult.matchedExperts
              .filter((m) => m.hits > 0)
              .map((m) => `${m.expert.slug} (${m.hits} hits)`)
              .join(', ');
            routingReason = `FTS5 search matched: ${matches}`;
          } else {
            routingReason = 'No FTS5 matches — queried first active expert as fallback';
          }

          db.insertEvent({
            source: 'mcp',
            event_type: 'expert_ask',
            summary: `Auto-routed question to ${expertsConsulted.join(', ')}: ${question.slice(0, 100)}`,
            payload: {
              question,
              context: context ?? null,
              experts_consulted: expertsConsulted,
              routing_reason: routingReason,
            },
          });

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    answer,
                    experts_consulted: expertsConsulted,
                    routing_reason: routingReason,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);

          db.insertEvent({
            source: 'mcp',
            event_type: 'expert_ask_error',
            summary: `Auto-routed expert ask failed: ${message.slice(0, 200)}`,
            payload: {
              question,
              error: message,
            },
          });

          return {
            content: [{ type: 'text', text: `Expert panel query failed: ${message}` }],
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

// Graceful shutdown: terminate any active expert subprocesses
process.on('SIGTERM', () => {
  sessionManager.terminateAll();
  process.exit(0);
});
process.on('SIGINT', () => {
  sessionManager.terminateAll();
  process.exit(0);
});

main().catch((error) => {
  console.error('Fatal error:', error);
  sessionManager.terminateAll();
  process.exit(1);
});
