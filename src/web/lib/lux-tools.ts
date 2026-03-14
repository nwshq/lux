import { tool } from 'ai';
import { z } from 'zod';
import { getLuxDatabase, getSessionManager } from './lux-singleton.js';
import { routeQuery } from '../../experts/router.js';

export const luxSearch = tool({
  description:
    'Search the Lux knowledge base for documents matching a query. Returns titles, file paths, and content snippets.',
  parameters: z.object({
    query: z.string().describe('Search query string'),
    limit: z.number().optional().default(10).describe('Maximum number of results to return'),
  }),
  execute: async ({ query, limit }) => {
    const db = getLuxDatabase();
    const results = db.searchAllDocuments(query);

    db.insertEvent({
      source: 'web',
      event_type: 'search',
      summary: `Search query: "${query}" (results: ${results.length})`,
      payload: { query, limit, results_count: results.length },
    });

    return results.slice(0, limit).map((doc) => ({
      title: doc.title,
      path: doc.file_path,
      snippet: doc.content ? doc.content.slice(0, 500) : null,
      rank: doc.rank,
    }));
  },
});

export const luxAskExpert = tool({
  description:
    'Route a question to the Lux expert panel. An expert with relevant domain knowledge will answer based on indexed organizational documents.',
  parameters: z.object({
    question: z.string().describe('The question to ask the expert panel'),
  }),
  execute: async ({ question }) => {
    const db = getLuxDatabase();
    const sessionManager = getSessionManager();

    const result = await routeQuery(question, db, sessionManager, {
      maxExperts: 1,
      useLlmRouting: true,
    });

    if (result.responses.length === 0) {
      return {
        answer: null,
        expert: null,
        routingMethod: result.routingMethod,
        confidence: 'none' as const,
        reason: 'No experts were able to respond.',
      };
    }

    const topMatch = result.matchedExperts[0];
    const hits = topMatch?.hits ?? 0;
    const confidence =
      hits > 2 ? ('high' as const) : hits > 0 ? ('moderate' as const) : ('low' as const);

    const response = result.responses[0];

    db.insertEvent({
      source: 'web',
      event_type: 'expert_ask',
      summary: `Asked expert "${response.expertSlug}": ${question.slice(0, 100)}`,
      payload: {
        question,
        expert: response.expertSlug,
        routingMethod: result.routingMethod,
        confidence,
        hits,
      },
    });

    return {
      answer: response.response,
      expert: response.expertSlug,
      routingMethod: result.routingMethod,
      confidence,
    };
  },
});
