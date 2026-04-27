import type { Command } from 'commander';
import { LuxDatabase } from '../db/index.js';
import type {
  OperationalBoundary,
  OperationalBoundaryKind,
  OperationalContract,
  OperationalEdge,
  StructuralNode,
  TrustTier,
} from '../db/types.js';
import {
  getOperationalBoundaryHandlers,
  getOperationalDispatchSourcesForJob,
  getOperationalDispatchedJobs,
  getOperationalEventListeners,
  getOperationalUpstreamTriggers,
  getTrustAwareOperationalNeighborhood,
} from '../scanner/associations/operational/index.js';
import {
  deriveOverlayTrustLevelFromState,
  inspectOverlayTrustState,
} from '../scanner/overlay-trust-state.js';
import { resolveCorpusPath, resolveDbPath } from '../utils/runtime-paths.js';

type OperationalQuestionIntent =
  | 'schedule-sources'
  | 'dispatch-sources'
  | 'dispatched-jobs'
  | 'event-listeners'
  | 'neighborhood'
  | 'evidence';

interface OperationalNodePayload {
  id: string;
  kind: 'boundary' | 'structural-symbol' | 'unresolved';
  boundaryKind?: OperationalBoundaryKind;
  nodeType?: StructuralNode['node_type'];
  name?: string;
  trustTier?: TrustTier;
  filePath?: string | null;
}

interface OperationalContractPayload {
  id: string;
  trustTier: TrustTier;
  payloadSchema: unknown;
}

interface OperationalEvidencePayload {
  edge?: {
    id: string;
    edgeType: OperationalEdge['edge_type'];
    transport: OperationalEdge['transport'] | null;
    trustTier: TrustTier;
  };
  source?: OperationalNodePayload;
  target?: OperationalNodePayload;
  contracts?: OperationalContractPayload[];
  filePath?: string | null;
  note?: string;
}

interface OperationalAnswerPayload {
  question: string;
  intent: OperationalQuestionIntent;
  overlayTrustLevel: string;
  target: OperationalNodePayload | null;
  primaryAnswer: {
    summary: string;
    confidence: 'high' | 'medium' | 'none';
    items: OperationalNodePayload[];
  };
  trust: {
    targetTrustTier: TrustTier | null;
    evidenceTrustTiers: TrustTier[];
    mixedTrust: boolean;
  };
  transport: Array<{
    edgeId: string;
    edgeType: OperationalEdge['edge_type'];
    transport: OperationalEdge['transport'] | null;
    trustTier: TrustTier;
  }>;
  evidence: OperationalEvidencePayload[];
}

interface AskOptions {
  json?: boolean;
  target?: string;
  kind?: OperationalBoundaryKind;
  maxDepth?: number;
  minTrustTier?: number;
}

function parsePayloadSchema(payloadSchema?: string): unknown {
  if (!payloadSchema) return null;
  try {
    return JSON.parse(payloadSchema) as unknown;
  } catch {
    return payloadSchema;
  }
}

function mapContracts(contracts: OperationalContract[]): OperationalContractPayload[] {
  return contracts.map((contract) => ({
    id: contract.id,
    trustTier: contract.trust_tier,
    payloadSchema: parsePayloadSchema(contract.payload_schema),
  }));
}

function mapEdge(edge: OperationalEdge): NonNullable<OperationalEvidencePayload['edge']> {
  return {
    id: edge.id,
    edgeType: edge.edge_type,
    transport: edge.transport ?? null,
    trustTier: edge.trust_tier,
  };
}

function getNodePayload(db: LuxDatabase, nodeId: string): OperationalNodePayload {
  const boundary = db.getOperationalBoundary(nodeId);
  if (boundary) return boundaryPayload(boundary);

  const node = db.getStructuralNode(nodeId);
  if (node) {
    return {
      id: node.id,
      kind: 'structural-symbol',
      nodeType: node.node_type,
      name: node.symbol_name,
      filePath: node.file_path ?? null,
    };
  }

  return { id: nodeId, kind: 'unresolved' };
}

function boundaryPayload(boundary: OperationalBoundary): OperationalNodePayload {
  return {
    id: boundary.id,
    kind: 'boundary',
    boundaryKind: boundary.kind,
    name: boundary.name,
    trustTier: boundary.trust_tier,
    filePath: boundary.file_path ?? null,
  };
}

function nodeLabel(node: OperationalNodePayload): string {
  if (node.kind === 'boundary') return `${node.boundaryKind}:${node.name}`;
  return node.name ?? node.id;
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/^opb:/, '')
    .replace(/^command:/, '')
    .replace(/^job:/, '')
    .replace(/^event:/, '')
    .replace(/^schedule:/, '')
    .replace(/@\S+:\d+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function inferIntent(question: string): OperationalQuestionIntent {
  const normalized = question.toLowerCase();
  if (
    normalized.includes('evidence') ||
    normalized.includes('trust') ||
    normalized.includes('support')
  ) {
    return 'evidence';
  }
  if (normalized.includes('listener') || normalized.includes('handle')) return 'event-listeners';
  if (normalized.includes('dispatches') || normalized.includes('dispatched from')) {
    return 'dispatch-sources';
  }
  if (normalized.includes('triggered by') || normalized.includes('what command')) {
    return 'dispatched-jobs';
  }
  if (normalized.includes('schedule')) return 'schedule-sources';
  return 'neighborhood';
}

function extractTargetQuestionFragment(
  question: string,
  intent: OperationalQuestionIntent
): string {
  const withoutQuestion = question.replace(/\?$/, '').trim();
  const patterns: RegExp[] = [
    /what\s+dispatches\s+(.+)$/i,
    /where\s+is\s+(.+?)\s+dispatched\s+from$/i,
    /what\s+listeners\s+handle\s+(.+)$/i,
    /what\s+schedules\s+(.+)$/i,
    /what\s+command\s+is\s+triggered\s+by\s+(.+)$/i,
    /around\s+(.+)$/i,
    /support\s+(.+)$/i,
  ];

  for (const pattern of patterns) {
    const match = withoutQuestion.match(pattern);
    if (match?.[1]) return match[1].trim();
  }

  if (intent === 'neighborhood') return withoutQuestion;
  return withoutQuestion.split(/\s+/).at(-1) ?? withoutQuestion;
}

function preferredKindsForIntent(
  intent: OperationalQuestionIntent,
  explicitKind?: OperationalBoundaryKind,
  targetText?: string
): OperationalBoundaryKind[] | undefined {
  if (explicitKind) return [explicitKind];
  if (intent === 'dispatch-sources') return ['job'];
  if (intent === 'event-listeners') return ['event'];
  if (intent === 'schedule-sources') return ['command', 'job'];
  if (intent === 'dispatched-jobs' && targetText && /@\S+:\d+$/.test(targetText.trim())) {
    return ['schedule', 'command', 'http'];
  }
  if (intent === 'dispatched-jobs') return ['schedule', 'command', 'http'];
  return undefined;
}

function resolveBoundary(
  db: LuxDatabase,
  repoRoot: string,
  query: string,
  kinds?: OperationalBoundaryKind[]
): OperationalBoundary | null {
  const boundaries = db
    .getOperationalBoundariesByRepoRoot(repoRoot)
    .filter((boundary) => !kinds || kinds.includes(boundary.kind))
    .sort((left, right) => {
      if (!kinds) return 0;
      return kinds.indexOf(left.kind) - kinds.indexOf(right.kind);
    });
  const normalizedQuery = normalize(query);
  if (!normalizedQuery) return null;

  const exact = boundaries.find(
    (boundary) =>
      normalize(boundary.id) === normalizedQuery || normalize(boundary.name) === normalizedQuery
  );
  if (exact) return exact;

  const prefix = boundaries.find((boundary) =>
    normalize(boundary.name).startsWith(normalizedQuery)
  );
  if (prefix) return prefix;

  return (
    boundaries.find(
      (boundary) =>
        normalize(boundary.name).includes(normalizedQuery) ||
        normalizedQuery.includes(normalize(boundary.name))
    ) ?? null
  );
}

function confidenceFor(
  count: number,
  tiers: TrustTier[]
): OperationalAnswerPayload['primaryAnswer']['confidence'] {
  if (count === 0) return 'none';
  return tiers.some((tier) => tier < 4) ? 'medium' : 'high';
}

function buildEmptyAnswer(
  db: LuxDatabase,
  question: string,
  intent: OperationalQuestionIntent,
  target: OperationalNodePayload | null,
  reason: string
): OperationalAnswerPayload {
  return {
    question,
    intent,
    overlayTrustLevel: deriveOverlayTrustLevelFromState(inspectOverlayTrustState(db).state),
    target,
    primaryAnswer: {
      summary: reason,
      confidence: 'none',
      items: [],
    },
    trust: {
      targetTrustTier: target?.trustTier ?? null,
      evidenceTrustTiers: [],
      mixedTrust: false,
    },
    transport: [],
    evidence: [],
  };
}

function buildOperationalAnswer(
  db: LuxDatabase,
  question: string,
  target: OperationalBoundary,
  intent: OperationalQuestionIntent,
  options: AskOptions
): OperationalAnswerPayload {
  if (intent === 'event-listeners') return buildEventListenersAnswer(db, question, target);
  if (intent === 'dispatch-sources') return buildDispatchSourcesAnswer(db, question, target);
  if (intent === 'dispatched-jobs') return buildDispatchedJobsAnswer(db, question, target);
  if (intent === 'schedule-sources') return buildScheduleSourcesAnswer(db, question, target);
  if (intent === 'evidence') return buildEvidenceAnswer(db, question, target);
  return buildNeighborhoodAnswer(db, question, target, options);
}

function baseAnswer(
  db: LuxDatabase,
  question: string,
  intent: OperationalQuestionIntent,
  target: OperationalBoundary,
  items: OperationalNodePayload[],
  evidence: OperationalEvidencePayload[],
  summary: string
): OperationalAnswerPayload {
  const uniqueItems = uniqueNodes(items);
  const uniqueEvidence = uniqueEvidenceItems(evidence);
  const tiers = uniqueEvidence.flatMap((entry) => (entry.edge ? [entry.edge.trustTier] : []));
  const transport = uniqueEvidence.flatMap((entry) =>
    entry.edge
      ? [
          {
            edgeId: entry.edge.id,
            edgeType: entry.edge.edgeType,
            transport: entry.edge.transport,
            trustTier: entry.edge.trustTier,
          },
        ]
      : []
  );
  return {
    question,
    intent,
    overlayTrustLevel: deriveOverlayTrustLevelFromState(inspectOverlayTrustState(db).state),
    target: boundaryPayload(target),
    primaryAnswer: {
      summary,
      confidence: confidenceFor(uniqueItems.length, tiers.length > 0 ? tiers : [target.trust_tier]),
      items: uniqueItems,
    },
    trust: {
      targetTrustTier: target.trust_tier,
      evidenceTrustTiers: tiers,
      mixedTrust: new Set([target.trust_tier, ...tiers]).size > 1,
    },
    transport,
    evidence: uniqueEvidence,
  };
}

function uniqueNodes(nodes: OperationalNodePayload[]): OperationalNodePayload[] {
  const seen = new Set<string>();
  const result: OperationalNodePayload[] = [];
  for (const node of nodes) {
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    result.push(node);
  }
  return result;
}

function uniqueEvidenceItems(evidence: OperationalEvidencePayload[]): OperationalEvidencePayload[] {
  const seen = new Set<string>();
  const result: OperationalEvidencePayload[] = [];
  for (const item of evidence) {
    const key = `${item.edge?.id ?? 'no-edge'}:${item.source?.id ?? 'unknown'}:${item.target?.id ?? 'unknown'}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function buildScheduleSourcesAnswer(
  db: LuxDatabase,
  question: string,
  target: OperationalBoundary
): OperationalAnswerPayload {
  const upstream = getOperationalUpstreamTriggers(db, target.id);
  const schedules = (upstream?.triggers ?? []).filter(
    (entry) => entry.sourceBoundary.kind === 'schedule'
  );
  const items = schedules.map((entry) => boundaryPayload(entry.sourceBoundary));
  const evidence = schedules.map((entry) => ({
    edge: mapEdge(entry.edge),
    source: boundaryPayload(entry.sourceBoundary),
    target: boundaryPayload(target),
    contracts: mapContracts(entry.sourceContracts),
    filePath: entry.sourceBoundary.file_path ?? null,
  }));
  const summary =
    items.length === 0
      ? `No persisted schedule currently triggers ${nodeLabel(boundaryPayload(target))}.`
      : `${items.map(nodeLabel).join(', ')} schedules ${nodeLabel(boundaryPayload(target))}.`;
  return baseAnswer(db, question, 'schedule-sources', target, items, evidence, summary);
}

function buildDispatchSourcesAnswer(
  db: LuxDatabase,
  question: string,
  target: OperationalBoundary
): OperationalAnswerPayload {
  const dispatchSources = getOperationalDispatchSourcesForJob(db, target.id);
  const entries = dispatchSources?.dispatchSources ?? [];
  const items = entries.map((entry) => getNodePayload(db, entry.edge.source_id));
  const evidence = entries.map((entry) => ({
    edge: mapEdge(entry.edge),
    source: getNodePayload(db, entry.edge.source_id),
    target: boundaryPayload(target),
    contracts: mapContracts(entry.sourceContracts),
    filePath: getNodePayload(db, entry.edge.source_id).filePath ?? null,
  }));
  const summary =
    items.length === 0
      ? `No persisted dispatcher currently reaches ${nodeLabel(boundaryPayload(target))}.`
      : `${items.map(nodeLabel).join(', ')} dispatches ${nodeLabel(boundaryPayload(target))}.`;
  return baseAnswer(db, question, 'dispatch-sources', target, items, evidence, summary);
}

function buildDispatchedJobsAnswer(
  db: LuxDatabase,
  question: string,
  target: OperationalBoundary
): OperationalAnswerPayload {
  const dispatched = getOperationalDispatchedJobs(db, target.id);
  const dispatchEvidence = dispatched.dispatchedJobs.map((entry) => ({
    edge: mapEdge(entry.edge),
    source: boundaryPayload(target),
    target: boundaryPayload(entry.jobBoundary),
    contracts: mapContracts(entry.jobContracts),
    filePath: entry.jobBoundary.file_path ?? null,
  }));

  const triggerNeighborhood = getTrustAwareOperationalNeighborhood(db, target.id, {
    maxDepth: 1,
    minTrustTier: 1,
  });
  const triggerEvidence = triggerNeighborhood.edges
    .filter((edge) => edge.direction === 'outbound' && edge.edgeType === 'TRIGGERS')
    .map((edge) => {
      const targetBoundary = db.getOperationalBoundary(edge.targetId);
      return {
        edge: {
          id: edge.id,
          edgeType: edge.edgeType,
          transport: edge.transport ?? null,
          trustTier: edge.trustTier,
        },
        source: boundaryPayload(target),
        target: getNodePayload(db, edge.targetId),
        contracts: targetBoundary
          ? mapContracts(db.getOperationalContractsForBoundary(targetBoundary.id))
          : [],
        filePath: targetBoundary?.file_path ?? null,
      };
    });

  const evidence = [...dispatchEvidence, ...triggerEvidence];
  const items = evidence
    .map((entry) => entry.target)
    .filter((entry): entry is OperationalNodePayload => Boolean(entry));
  const summary =
    items.length === 0
      ? `No persisted command/job target is triggered by ${nodeLabel(boundaryPayload(target))}.`
      : `${nodeLabel(boundaryPayload(target))} triggers ${items.map(nodeLabel).join(', ')}.`;
  return baseAnswer(db, question, 'dispatched-jobs', target, items, evidence, summary);
}

function buildEventListenersAnswer(
  db: LuxDatabase,
  question: string,
  target: OperationalBoundary
): OperationalAnswerPayload {
  const eventListeners = getOperationalEventListeners(db, target.id);
  const entries = eventListeners?.listeners ?? [];
  const items = entries.map((entry) => getNodePayload(db, entry.handler.symbol_id));
  const evidence = entries.map((entry) => ({
    edge: mapEdge(entry.edge),
    source: boundaryPayload(target),
    target: getNodePayload(db, entry.handler.symbol_id),
    contracts: mapContracts(eventListeners?.contracts ?? []),
    filePath: getNodePayload(db, entry.handler.symbol_id).filePath ?? null,
  }));
  const summary =
    items.length === 0
      ? `No persisted listener currently handles ${nodeLabel(boundaryPayload(target))}.`
      : `${items.map(nodeLabel).join(', ')} handles ${nodeLabel(boundaryPayload(target))}.`;
  return baseAnswer(db, question, 'event-listeners', target, items, evidence, summary);
}

function buildEvidenceAnswer(
  db: LuxDatabase,
  question: string,
  target: OperationalBoundary
): OperationalAnswerPayload {
  const handlers = getOperationalBoundaryHandlers(db, target.id)?.handlers ?? [];
  const upstream = getOperationalUpstreamTriggers(db, target.id)?.triggers ?? [];
  const outbound = getOperationalDispatchedJobs(db, target.id).dispatchedJobs;
  const dispatchSources =
    target.kind === 'job'
      ? (getOperationalDispatchSourcesForJob(db, target.id)?.dispatchSources ?? [])
      : [];
  const eventListeners =
    target.kind === 'event' ? (getOperationalEventListeners(db, target.id)?.listeners ?? []) : [];

  const evidence: OperationalEvidencePayload[] = [
    ...upstream.map((entry) => ({
      edge: mapEdge(entry.edge),
      source: boundaryPayload(entry.sourceBoundary),
      target: boundaryPayload(target),
      contracts: mapContracts(entry.sourceContracts),
      filePath: entry.sourceBoundary.file_path ?? null,
    })),
    ...dispatchSources.map((entry) => ({
      edge: mapEdge(entry.edge),
      source: getNodePayload(db, entry.edge.source_id),
      target: boundaryPayload(target),
      contracts: mapContracts(entry.sourceContracts),
      filePath: getNodePayload(db, entry.edge.source_id).filePath ?? null,
    })),
    ...outbound.map((entry) => ({
      edge: mapEdge(entry.edge),
      source: boundaryPayload(target),
      target: boundaryPayload(entry.jobBoundary),
      contracts: mapContracts(entry.jobContracts),
      filePath: entry.jobBoundary.file_path ?? null,
    })),
    ...handlers.flatMap((entry) =>
      entry.edge
        ? [
            {
              edge: mapEdge(entry.edge),
              source: boundaryPayload(target),
              target: getNodePayload(db, entry.handler.symbol_id),
              filePath: getNodePayload(db, entry.handler.symbol_id).filePath ?? null,
              note: `handler tier ${entry.handler.trust_tier}`,
            },
          ]
        : []
    ),
    ...eventListeners.map((entry) => ({
      edge: mapEdge(entry.edge),
      source: boundaryPayload(target),
      target: getNodePayload(db, entry.handler.symbol_id),
      filePath: getNodePayload(db, entry.handler.symbol_id).filePath ?? null,
      note: `handler tier ${entry.handler.trust_tier}`,
    })),
  ];

  const items = evidence
    .map((entry) => entry.source)
    .filter((entry): entry is OperationalNodePayload => Boolean(entry));
  const summary =
    evidence.length === 0
      ? `No persisted operational evidence is attached to ${nodeLabel(boundaryPayload(target))}.`
      : `${nodeLabel(boundaryPayload(target))} is supported by ${evidence.length} persisted operational evidence item(s).`;
  return baseAnswer(db, question, 'evidence', target, items, evidence, summary);
}

function buildNeighborhoodAnswer(
  db: LuxDatabase,
  question: string,
  target: OperationalBoundary,
  options: AskOptions
): OperationalAnswerPayload {
  const minTrustTier = (options.minTrustTier ?? 1) as TrustTier;
  const neighborhood = getTrustAwareOperationalNeighborhood(db, target.id, {
    maxDepth: options.maxDepth ?? 2,
    minTrustTier,
  });
  const items = neighborhood.nodes
    .filter((node) => node.id !== target.id)
    .map((node) => getNodePayload(db, node.id));
  const evidence = neighborhood.edges.map((edge) => ({
    edge: {
      id: edge.id,
      edgeType: edge.edgeType,
      transport: edge.transport ?? null,
      trustTier: edge.trustTier,
    },
    source: getNodePayload(db, edge.sourceId),
    target: getNodePayload(db, edge.targetId),
  }));
  const summary =
    items.length === 0
      ? `No operational neighborhood was found around ${nodeLabel(boundaryPayload(target))}.`
      : `${nodeLabel(boundaryPayload(target))} can reach or be reached by ${items.map(nodeLabel).join(', ')}.`;
  return baseAnswer(db, question, 'neighborhood', target, items, evidence, summary);
}

function renderTextAnswer(payload: OperationalAnswerPayload): string {
  const lines: string[] = [];
  lines.push(payload.primaryAnswer.summary);
  lines.push(`Confidence: ${payload.primaryAnswer.confidence}`);
  lines.push(`Overlay Trust: ${payload.overlayTrustLevel}`);
  if (payload.target) {
    lines.push(
      `Target: ${nodeLabel(payload.target)}${payload.target.filePath ? ` (${payload.target.filePath})` : ''}`
    );
    if (payload.target.trustTier) lines.push(`Target Trust Tier: ${payload.target.trustTier}`);
  }
  if (payload.transport.length > 0) {
    lines.push('\nTransport');
    for (const transport of payload.transport) {
      lines.push(
        `- ${transport.edgeType} ${transport.transport ?? 'n/a'} tier=${transport.trustTier} evidence=${transport.edgeId}`
      );
    }
  }
  lines.push('\nEvidence');
  if (payload.evidence.length === 0) {
    lines.push('- none persisted');
  } else {
    for (const evidence of payload.evidence) {
      const source = evidence.source ? nodeLabel(evidence.source) : 'unknown';
      const target = evidence.target ? nodeLabel(evidence.target) : 'unknown';
      const edge = evidence.edge
        ? `${evidence.edge.edgeType} ${evidence.edge.transport ?? 'n/a'} tier=${evidence.edge.trustTier}`
        : 'no edge';
      lines.push(`- ${source} -> ${target}: ${edge}`);
      if (evidence.filePath) lines.push(`  file: ${evidence.filePath}`);
      if (evidence.contracts && evidence.contracts.length > 0) {
        lines.push(
          `  contracts: ${evidence.contracts
            .map((contract) => `${contract.id} tier=${contract.trustTier}`)
            .join(', ')}`
        );
      }
      if (evidence.note) lines.push(`  ${evidence.note}`);
    }
  }
  return lines.join('\n');
}

function validateOptions(options: AskOptions): void {
  if (options.kind) {
    const validKinds: OperationalBoundaryKind[] = ['command', 'schedule', 'job', 'event', 'http'];
    if (!validKinds.includes(options.kind)) {
      console.error(`Error: --kind must be one of ${validKinds.join(', ')}.`);
      process.exit(1);
    }
  }

  const maxDepth = options.maxDepth ?? 2;
  if (!Number.isInteger(maxDepth) || maxDepth < 1) {
    console.error('Error: --max-depth must be a positive integer.');
    process.exit(1);
  }

  const minTrustTier = options.minTrustTier ?? 1;
  if (!Number.isInteger(minTrustTier) || minTrustTier < 1 || minTrustTier > 5) {
    console.error('Error: --min-trust-tier must be an integer between 1 and 5.');
    process.exit(1);
  }
}

export function runOperationalAsk(
  program: Command,
  questionParts: string[],
  options: AskOptions
): void {
  validateOptions(options);

  const question = questionParts.join(' ').trim();
  if (!question && !options.target) {
    console.error('Error: ask requires a question or --target.');
    process.exit(1);
  }

  const opts = program.opts();
  const corpusPath = resolveCorpusPath({ corpus: opts.corpus as string | undefined });
  const db = new LuxDatabase(
    resolveDbPath({ corpus: corpusPath, db: opts.db as string | undefined })
  );

  const intent = inferIntent(question);
  const targetText = options.target ?? extractTargetQuestionFragment(question, intent);
  const target = resolveBoundary(
    db,
    corpusPath,
    targetText,
    preferredKindsForIntent(intent, options.kind, targetText)
  );
  const payload = target
    ? buildOperationalAnswer(db, question, target, intent, options)
    : buildEmptyAnswer(
        db,
        question,
        intent,
        null,
        `No persisted operational boundary matched "${targetText}".`
      );

  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(renderTextAnswer(payload));
  }

  db.close();
  if (!target) process.exit(1);
}
