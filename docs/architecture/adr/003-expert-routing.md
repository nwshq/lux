# ADR-003: Three-Stage Expert Routing Algorithm

**Status:** accepted
**Date:** 2026-02-23

## Context

Lux maintains a panel of domain-specialist AI experts, each registered to a subdirectory (`mount_path`) of the CORPUS. When a user asks a question via `lux ask` or the MCP server, the system must decide which expert is best suited to answer and provide that expert with relevant context.

Two extremes exist:

1. **Pure text search routing.** Score experts by counting FTS5 hits under their mount paths. This is fast and deterministic but has no semantic understanding — an expert with many keyword matches may not be the best conceptual fit.

2. **Pure LLM routing.** Send the question and expert roster to an LLM and let it choose. This understands intent but is slower, costs money per call, and can fail (network errors, timeouts, hallucinated slugs).

A hybrid approach is needed that combines the strengths of both: FTS5 for context retrieval and relevance scoring, LLM for semantic expert selection, and a reliable fallback path when the LLM is unavailable.

Additionally, the chosen expert needs more than just the raw question — it needs relevant documents from the CORPUS to ground its answer in the knowledge base, implementing a Retrieval-Augmented Generation (RAG) pattern.

## Decision

We implement a **three-stage routing pipeline** in `src/experts/router.ts`:

### Stage 1: FTS5 Scoring (Context Retrieval)

Search all FTS5 indexes (clients, projects, communications, knowledge_entries) and map document hits to experts by `mount_path` prefix matching.

```typescript
// Sanitize user query for FTS5 — wrap tokens in quotes, join with OR
const ftsQuery = sanitizeFtsQuery(query);
// e.g., "agile process" → '"agile" OR "process"'

// Search all FTS5 tables: knowledge_entries, clients, projects, communications
const hits: FtsHit[] = collectFtsHits(ftsQuery, db);

// Map each hit to the owning expert by file_path → mount_path prefix
for (const hit of hits) {
  for (const expert of experts) {
    if (isUnderMountPath(hit.filePath, expert.mount_path)) {
      entry.hits += 1;
      entry.score += hit.rank; // FTS5 rank: more negative = more relevant
      break; // one hit maps to at most one expert
    }
  }
}

// Sort: most hits first, then by cumulative FTS5 rank (lower = better)
const sorted = scores.sort((a, b) => {
  if (b.hits !== a.hits) return b.hits - a.hits;
  return a.score - b.score;
});
```

This stage serves dual purposes:
- **Expert ranking** — produces a scored candidate list for FTS5 fallback routing.
- **Context collection** — gathers document content and LSP metadata that will be injected into the augmented query in Stage 3.

### Stage 2: LLM Selection (Haiku)

A lightweight LLM (Claude Haiku, `claude-haiku-4-5-20251001`) selects the best expert from the roster. The LLM receives a structured prompt with expert descriptions extracted from their `claude_md_path` files.

```typescript
const prompt = `You are a query router. Given a user's question and a list of \
domain experts, respond with ONLY the slug of the single best expert to answer \
the question. Do not explain your choice. Respond with just the slug.

## Available Experts

${roster}
// e.g., - `example-app` — example-app Expert: This expert handles chiropractic...
//       - `acme` — acme Expert: Manages eBay auction platforms...

## Question

${question}`;

// Spawn claude CLI as a stateless subprocess
const stdout = await spawnClaude(
  ['--print', '--model', 'claude-haiku-4-5-20251001', prompt],
  30_000, // 30s timeout
);

// Parse response: strip backticks and whitespace, validate against known slugs
const slug = stdout.trim().replace(/`/g, '').trim();
if (validSlugs.has(slug)) {
  return { slug, /* ...telemetry */ };
}
```

**Fallback behavior:** If LLM routing is disabled (`useLlmRouting: false`), times out, returns an invalid slug, or errors, the system falls back to Stage 1's FTS5 ranking. If FTS5 also produces no qualified matches (below `minHits` threshold), the first active expert is used as a last resort.

**Telemetry:** Every LLM routing call — success or failure — is logged to the `events` table with the prompt, raw response, chosen slug, model, duration, and error. A separate `expert_route` event captures the final routing decision alongside the FTS5 top-5 ranking, enabling after-the-fact comparison of LLM vs. FTS5 selection.

### Stage 3: Expert Query (Subprocess)

The chosen expert is queried via a Claude CLI subprocess. The user's question is augmented with FTS5-retrieved document content using a RAG pattern with a configurable context budget (default ~150KB).

```typescript
function buildAugmentedQuery(
  question: string,
  hits: FtsHit[],
  maxContextBytes: number = 153_600,
): string {
  // Filter to hits with content or LSP metadata
  // Pack documents into a "Reference Documents" section up to budget
  // Include LSP relationship summaries (extends, implements, dependencies)
  return `Answer the following question using the reference documents provided below.

## Reference Documents

### ${hit.title}
${lspRelationships}
${hit.content}
---

## Question

${question}`;
}
```

The subprocess is managed by `SubprocessSessionManager`, which:
- Spawns `claude --print --model <expert.model>` in the expert's `mount_path` directory
- Injects the expert's `claude_md_path` content as a `--system-prompt`
- Supports conversation resumption via `--resume <session_ref>`
- Prevents concurrent queries to the same expert
- Enforces a 5-minute timeout with SIGTERM → SIGKILL escalation
- Caps output at 10MB
- Streams response chunks via `onChunk` callback for real-time TTY output

### Pipeline Flow

```
User Question
    │
    ▼
┌─ Stage 1: FTS5 Scoring ──────────────────────────────────┐
│  sanitizeFtsQuery() → wrap tokens, join with OR           │
│  collectFtsHits() → search 4 FTS5 tables                  │
│  scoreExperts() → map hits to experts by mount_path       │
│  Output: ScoredExpert[] + FtsHit[] per expert              │
└────────────────────────────────┬──────────────────────────┘
                                 │
                                 ▼
┌─ Stage 2: LLM Selection (Haiku) ─────────────────────────┐
│  buildExpertRoster() → slug + name + brief per expert     │
│  selectExpertWithLlm() → spawn claude --print             │
│  Validate slug against known experts                       │
│  Log telemetry to events table                             │
│  Fallback: FTS5 top match → first active expert            │
│  Output: Expert (single selection)                         │
└────────────────────────────────┬──────────────────────────┘
                                 │
                                 ▼
┌─ Stage 3: Expert Query (Subprocess) ─────────────────────┐
│  buildAugmentedQuery() → inject FTS5 context + LSP data   │
│  SubprocessSessionManager.query() → spawn claude --print  │
│  Expert's model, system prompt, cwd = mount_path          │
│  Stream chunks via onChunk callback                        │
│  Output: QueryResult (response text)                       │
└───────────────────────────────────────────────────────────┘
```

### Configuration

All routing behavior is configurable via `RouterOptions`:

| Option | Default | Description |
|--------|---------|-------------|
| `maxExperts` | `1` | Number of experts to query per route |
| `minHits` | `1` | Minimum FTS5 hit count for expert qualification |
| `maxContextBytes` | `153,600` (~150KB) | Context budget for augmented query |
| `useLlmRouting` | `true` | Enable/disable LLM expert selection |
| `routingModel` | `claude-haiku-4-5-20251001` | Model for routing LLM |
| `onChunk` | — | Streaming callback for real-time output |

### Multi-Expert Mode

When `maxExperts > 1`, Stage 2 (LLM selection) is bypassed and the top N FTS5-qualified experts are each queried with their own augmented context. Responses are collected via `Promise.allSettled` — individual expert failures do not block other responses.

## Consequences

### Positive

- **Semantic selection with statistical fallback.** LLM routing understands intent ("Who handles billing?" → billing expert) while FTS5 provides a reliable deterministic backup when the LLM fails.
- **Context-grounded answers.** The RAG pattern in Stage 3 gives experts relevant documents from the knowledge base rather than relying solely on their training data.
- **Observable routing decisions.** Telemetry events capture both LLM and FTS5 rankings for every query, enabling analysis of routing accuracy and agreement rates.
- **Graceful degradation.** Three levels of fallback: LLM → FTS5 top match → first active expert. The system always produces an answer.
- **Subprocess isolation.** Expert queries run in clean environments (`buildCleanEnv()`) scoped to the expert's mount directory, preventing cross-expert state leakage.

### Negative

- **Two LLM calls per query.** Routing (Haiku) + expert query (configurable model) means two API calls per question. The routing call adds latency (~1-5 seconds) and cost.
- **FTS5 context is keyword-based.** The retrieval in Stage 1 uses tokenized keyword matching, not semantic similarity. Conceptually relevant documents with different terminology may be missed.
- **Subprocess overhead.** Each expert query spawns a new `claude` CLI process. There is no persistent connection or warm model cache between queries.
- **150KB context budget is a heuristic.** The budget was chosen to fit within typical model context windows, but may be too large for small queries or too small for complex multi-document questions.

### Neutral

- **Expert roster quality matters.** LLM routing quality depends on the descriptions in expert `claude_md_path` files. Poor or missing descriptions reduce routing accuracy, falling back to FTS5 scoring.
- **Haiku as routing model is a cost/quality tradeoff.** A more capable model could improve selection but at higher cost and latency. The routing model is configurable for experimentation.
- **Session tracking is database-backed.** Expert sessions (warm/active/idle states) are persisted in SQLite, enabling resumption but adding database writes per query.
