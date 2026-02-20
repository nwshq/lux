import { Command } from 'commander';
import { LuxDatabase } from '../db/index.js';
import { ExpertSessionManagerImpl } from '../experts/session-manager.js';
import type { ExpertSessionManager } from '../experts/session-manager.js';
import { routeQuery } from '../experts/router.js';
import type { RouteResult } from '../experts/router.js';

export function addAskCommand(program: Command) {
  program
    .command('ask <question>')
    .description('Ask a question to the expert panel')
    .option('--expert <slug>', 'Route to a specific expert instead of auto-routing')
    .option('--verbose', 'Show detailed routing and scoring information')
    .option('--json', 'Output as JSON')
    .action(
      async (
        question: string,
        options: { expert?: string; verbose?: boolean; json?: boolean }
      ) => {
        const opts = program.opts();
        const db = new LuxDatabase(opts.db as string);
        const sessionManager = new ExpertSessionManagerImpl(db);

        try {
          if (options.expert) {
            await askSpecificExpert(db, sessionManager, question, options.expert, options);
          } else {
            await askPanel(db, sessionManager, question, options);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (options.json) {
            console.log(JSON.stringify({ error: message }, null, 2));
          } else {
            console.error(`Error: ${message}`);
          }
          db.close();
          process.exit(1);
        }

        db.close();
      }
    );
}

export async function askSpecificExpert(
  db: LuxDatabase,
  sessionManager: ExpertSessionManager,
  question: string,
  expertSlug: string,
  options: { verbose?: boolean; json?: boolean }
): Promise<void> {
  const expert = db.getExpert(expertSlug);
  if (!expert) {
    throw new Error(`Expert not found: ${expertSlug}`);
  }

  if (expert.status !== 'active') {
    throw new Error(`Expert is not active: ${expertSlug} (status: ${expert.status})`);
  }

  if (options.verbose && !options.json) {
    console.error(`Routing to expert: ${expert.name} (${expert.slug})`);
    console.error(`Model: ${expert.model}`);
    console.error(`Mount: ${expert.mount_path}`);
    console.error('');
  }

  const result = await sessionManager.query(expertSlug, question);

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          query: question,
          expert: {
            slug: expert.slug,
            name: expert.name,
            model: expert.model,
          },
          response: result.response,
          sessionId: result.sessionId,
        },
        null,
        2
      )
    );
    return;
  }

  if (options.verbose) {
    console.error(`Session ID: ${result.sessionId}`);
    console.error('---');
    console.error('');
  }

  console.log(result.response);
}

export async function askPanel(
  db: LuxDatabase,
  sessionManager: ExpertSessionManager,
  question: string,
  options: { verbose?: boolean; json?: boolean }
): Promise<void> {
  const activeExperts = db.getExpertsByStatus('active');
  if (activeExperts.length === 0) {
    throw new Error('No active experts registered. Use "lux expert add" to register experts.');
  }

  if (options.verbose && !options.json) {
    console.error(`Active experts: ${activeExperts.length}`);
    console.error(`Routing query: "${question}"`);
    console.error('');
  }

  const routeResult = await routeQuery(question, db, sessionManager);

  if (options.json) {
    console.log(JSON.stringify(formatRouteResultJson(routeResult), null, 2));
    return;
  }

  if (options.verbose) {
    printVerboseRouting(routeResult);
  }

  if (routeResult.responses.length === 0) {
    console.error('No experts were able to respond to this query.');
    return;
  }

  if (routeResult.synthesis) {
    console.log(routeResult.synthesis);
  } else if (routeResult.responses.length === 1) {
    const resp = routeResult.responses[0];
    if (options.verbose) {
      console.error(`\nResponse from: ${resp.expertSlug}`);
      console.error('---');
      console.error('');
    }
    console.log(resp.response);
  }
}

function printVerboseRouting(result: RouteResult): void {
  if (result.matchedExperts.length > 0) {
    console.error('Matched experts:');
    for (const match of result.matchedExperts) {
      console.error(
        `  ${match.expert.slug}: ${match.hits} hits, score ${match.score.toFixed(2)}`
      );
    }
    console.error('');
  } else {
    console.error('No FTS5 matches — querying all active experts.');
    console.error('');
  }

  console.error(`Experts queried: ${result.responses.length}`);
  for (const resp of result.responses) {
    console.error(`  ${resp.expertSlug}: ${resp.response.length} chars`);
  }
}

export function formatRouteResultJson(result: RouteResult): Record<string, unknown> {
  return {
    query: result.query,
    matchedExperts: result.matchedExperts.map((m) => ({
      slug: m.expert.slug,
      name: m.expert.name,
      hits: m.hits,
      score: m.score,
    })),
    responses: result.responses.map((r) => ({
      expertSlug: r.expertSlug,
      sessionId: r.sessionId,
      response: r.response,
    })),
    synthesis: result.synthesis ?? null,
  };
}
