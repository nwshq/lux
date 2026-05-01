import { Command } from 'commander';
import { LuxDatabase } from '../db/index.js';
import { SubprocessSessionManager } from '../experts/subprocess-manager.js';
import { resolveCorpusPath, resolveDbPath } from '../utils/runtime-paths.js';
import type { ExpertSessionManager } from '../experts/session-manager.js';
import { routeQuery } from '../experts/router.js';
import type { RouteResult } from '../experts/router.js';
import { executeFeaturePathAsk } from './feature-path.js';
import { executeOperationalAsk, inferOperationalAskIntent } from './operational.js';
import { inferFeaturePathIntent } from '../scanner/associations/feature-path/intents.js';

export function addAskCommand(program: Command) {
  program
    .command('ask <question>')
    .description('Retrieve evidence-first Lux views, then fall back to the expert panel')
    .option('--expert <slug>', 'Route to a specific expert instead of auto-routing')
    .option('--verbose', 'Show detailed routing and scoring information')
    .option('--json', 'Output as JSON')
    .option('--stream', 'Stream response tokens as they arrive (default for TTY)')
    .option('--no-stream', 'Buffer complete response before outputting')
    .option('--routing-model <model>', 'Model to use for panel routing')
    .option('--routing-backend <backend>', 'Routing backend (claude|pi)')
    .option('--routing-provider <provider>', 'Provider for Pi-backed routing (for example openai)')
    .option(
      '--routing-thinking <level>',
      'Pi thinking level for routing (off|minimal|low|medium|high|xhigh)'
    )
    .action(
      async (
        question: string,
        options: {
          expert?: string;
          verbose?: boolean;
          json?: boolean;
          stream?: boolean;
          routingModel?: string;
          routingBackend?: 'claude' | 'pi';
          routingProvider?: string;
          routingThinking?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
        }
      ) => {
        const opts = program.opts();
        const corpusPath = resolveCorpusPath({ corpus: opts.corpus as string | undefined });
        const db = new LuxDatabase(
          resolveDbPath({ corpus: corpusPath, db: opts.db as string | undefined })
        );
        const sessionManager = new SubprocessSessionManager(db);

        try {
          if (options.expert) {
            await askSpecificExpert(db, sessionManager, question, options.expert, options);
          } else if (tryAskFeaturePath(db, question, options, corpusPath)) {
            // Promoted retrieval answers are emitted by tryAskFeaturePath.
          } else if (tryAskOperational(db, question, options, corpusPath)) {
            // Promoted retrieval answers are emitted by tryAskOperational.
          } else {
            await askPanel(db, sessionManager, question, options, corpusPath);
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

export type AskJsonSurface = 'feature-path' | 'operational' | 'expert-panel' | 'expert';
export type AskJsonMode = 'retrieval' | 'panel' | 'expert';

export interface AskJsonEnvelope<TPayload> {
  schemaVersion: 1;
  surface: AskJsonSurface;
  mode: AskJsonMode;
  question: string;
  payload: TPayload;
}

export function formatAskJsonEnvelope<TPayload>(
  surface: AskJsonSurface,
  mode: AskJsonMode,
  question: string,
  payload: TPayload
): AskJsonEnvelope<TPayload> {
  return {
    schemaVersion: 1,
    surface,
    mode,
    question,
    payload,
  };
}

function hasFeaturePathSurfaceCue(question: string): boolean {
  const normalized = question.toLowerCase();
  return (
    /\b(get|post|put|patch|delete|options|head)\s+\//i.test(question) ||
    /\s\/[a-z0-9_{}/:-]+/i.test(normalized)
  );
}

export function tryAskFeaturePath(
  db: LuxDatabase,
  question: string,
  options: { json?: boolean },
  corpusPath: string
): boolean {
  if (!hasFeaturePathSurfaceCue(question)) return false;

  const intentResolution = inferFeaturePathIntent(question);
  if (!intentResolution.intent) return false;

  const result = executeFeaturePathAsk(db, question, { json: options.json, corpusPath });
  const output = options.json
    ? JSON.stringify(
        formatAskJsonEnvelope('feature-path', 'retrieval', question, result.answer),
        null,
        2
      )
    : result.rendered;
  console.log(output);
  if (result.exitCode !== 0) {
    process.exitCode = result.exitCode;
  }
  return true;
}

export function tryAskOperational(
  db: LuxDatabase,
  question: string,
  options: { json?: boolean },
  corpusPath: string
): boolean {
  const intentResolution = inferOperationalAskIntent(question);
  if (!intentResolution.intent) return false;

  const result = executeOperationalAsk(db, question, { json: options.json, corpusPath });
  const output = options.json
    ? JSON.stringify(
        formatAskJsonEnvelope('operational', 'retrieval', question, result.answer),
        null,
        2
      )
    : result.rendered;
  console.log(output);
  if (result.exitCode !== 0) {
    process.exitCode = result.exitCode;
  }
  return true;
}

export async function askSpecificExpert(
  db: LuxDatabase,
  sessionManager: ExpertSessionManager,
  question: string,
  expertSlug: string,
  options: { verbose?: boolean; json?: boolean; stream?: boolean }
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

  const shouldStream = options.json
    ? false
    : options.stream !== undefined
      ? options.stream
      : (process.stdout.isTTY ?? false);

  const queryOpts = shouldStream
    ? { onChunk: (chunk: string) => process.stdout.write(chunk) }
    : undefined;

  const result = await sessionManager.query(expertSlug, question, queryOpts);

  if (options.json) {
    const payload = {
      query: question,
      expert: {
        slug: expert.slug,
        name: expert.name,
        model: expert.model,
      },
      response: result.response,
      sessionId: result.sessionId,
    };
    console.log(
      JSON.stringify(formatAskJsonEnvelope('expert', 'expert', question, payload), null, 2)
    );
    return;
  }

  if (options.verbose) {
    console.error(`Session ID: ${result.sessionId}`);
    console.error('---');
    console.error('');
  }

  if (shouldStream) {
    // Response was already written chunk-by-chunk; ensure trailing newline
    if (!result.response.endsWith('\n')) {
      process.stdout.write('\n');
    }
  } else {
    console.log(result.response);
  }
}

export async function askPanel(
  db: LuxDatabase,
  sessionManager: ExpertSessionManager,
  question: string,
  options: {
    verbose?: boolean;
    json?: boolean;
    stream?: boolean;
    routingModel?: string;
    routingBackend?: 'claude' | 'pi';
    routingProvider?: string;
    routingThinking?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  },
  corpusPath?: string
): Promise<void> {
  if (options.verbose && !options.json) {
    const activeExperts = db.getExpertsByStatus('active');
    console.error(`Active experts: ${activeExperts.length}`);
    console.error(`Routing query: "${question}"`);
    console.error('');
  }

  const shouldStream = options.json
    ? false
    : options.stream !== undefined
      ? options.stream
      : (process.stdout.isTTY ?? false);

  const routerOpts = {
    ...(shouldStream ? { onChunk: (chunk: string) => process.stdout.write(chunk) } : {}),
    ...(corpusPath ? { rootPath: corpusPath } : {}),
    ...(options.routingModel ? { routingModel: options.routingModel } : {}),
    ...(options.routingBackend ? { routingBackend: options.routingBackend } : {}),
    ...(options.routingProvider ? { routingProvider: options.routingProvider } : {}),
    ...(options.routingThinking ? { routingThinking: options.routingThinking } : {}),
  };

  const routeResult = await routeQuery(question, db, sessionManager, routerOpts);

  if (options.json) {
    const payload = formatRouteResultJson(routeResult);
    console.log(
      JSON.stringify(formatAskJsonEnvelope('expert-panel', 'panel', question, payload), null, 2)
    );
    return;
  }

  if (options.verbose) {
    printVerboseRouting(routeResult);
  }

  if (routeResult.responses.length === 0) {
    console.error('No experts were able to respond to this query.');
    return;
  }

  // Single expert response — just output the answer
  const resp = routeResult.responses[0];
  if (options.verbose) {
    console.error(`\nResponse from: ${resp.expertSlug}`);
    console.error('---');
    console.error('');
  }

  if (shouldStream) {
    // Response was already written chunk-by-chunk; ensure trailing newline
    if (!resp.response.endsWith('\n')) {
      process.stdout.write('\n');
    }
  } else {
    console.log(resp.response);
  }
}

function printVerboseRouting(result: RouteResult): void {
  if (result.matchedExperts.length > 0) {
    const chosen = result.matchedExperts[0];
    if (result.routingMethod === 'llm') {
      console.error(`LLM-routed to: ${chosen.expert.name} (${chosen.expert.slug})`);
    } else {
      console.error(
        `FTS5-routed to: ${chosen.expert.name} (${chosen.expert.slug}), ${chosen.hits} hits`
      );
    }
    if (result.matchedExperts.length > 1) {
      console.error('Other matches:');
      for (const match of result.matchedExperts.slice(1)) {
        console.error(`  ${match.expert.slug}: ${match.hits} hits`);
      }
    }
    console.error('');
  } else {
    console.error('No FTS5 matches — using first active expert as fallback.');
    console.error('');
  }
}

export function formatRouteResultJson(result: RouteResult): Record<string, unknown> {
  return {
    query: result.query,
    routingMethod: result.routingMethod,
    matchedExperts: result.matchedExperts.map((m) => ({
      slug: m.expert.slug,
      name: m.expert.name,
      hits: m.hits,
    })),
    responses: result.responses.map((r) => ({
      expertSlug: r.expertSlug,
      sessionId: r.sessionId,
      response: r.response,
    })),
  };
}
