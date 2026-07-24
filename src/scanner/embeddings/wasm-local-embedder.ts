// src/scanner/embeddings/wasm-local-embedder.ts  (FENCED — scanner/embeddings/*)
//
// Production Embedder (Phase 3): pure-WASM local inference via onnxruntime-web + @huggingface/
// tokenizers, bge-small-en-v1.5 (q8), CLS pooling, 384-dim. The session/tokenizer bring-up and the
// batched tensor feeds transfer verbatim from the validated bake-off glue (scratchpad model-bakeoff/
// embed-score.mjs, POOL='cls' branch); the POOLING is bge's CLS objective — NOT a mean-pool.

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import * as ort from 'onnxruntime-web';
import { Tokenizer as HuggingFaceTokenizer } from '@huggingface/tokenizers';
import { ANCHOR_EMBED_MODEL, ANCHOR_EMBED_DIMS, BGE_QUERY_PREFIX } from './model-pin.js';
import { ensureModelWeights } from './model-cache.js';
import type { Embedder } from './embedder.js';

// ---------------------------------------------------------------------------------------------
// OQ2 — the bge asymmetric query instruction
// ---------------------------------------------------------------------------------------------
//
// bge-small-en-v1.5 is trained with an ASYMMETRIC retrieval objective: the QUERY side is prefixed
// with a short instruction while the PASSAGE side is left bare. embedQuery() applies BGE_QUERY_PREFIX
// iff this flag is true; passage-side embed() NEVER prefixes, under either setting. Shipped APPLIED
// (the model card default; OQ2 confirmed the prefix helps this corpus's concept->node retrieval).
// Gating the decision behind one module-level flag makes "drop the prefix" a one-line change.
const USE_QUERY_PREFIX = true;

// bge-small-en-v1.5's trained maximum sequence length. Longer inputs are truncated to this many
// tokens before inference. Enforced JS-side after encode (independent of whether the tokenizer honors
// an encode-time truncation option), and it preserves position 0 ([CLS]), which CLS pooling reads — a
// tail truncation can never drop the pooled token.
const MAX_SEQ_TOKENS = 256;

// ---------------------------------------------------------------------------------------------
// Module-level onnxruntime-web configuration (SC-DETERM)
// ---------------------------------------------------------------------------------------------
//
// onnxruntime-web's env config is a process-wide singleton (`ort.env`), not a per-session option, so
// these assignments run once, at module load, before any session is created. The shipped contract
// (SC-DETERM) is: identical prepared text + the pinned model + THIS EXACT runtime config ->
// byte-identical Float32Array vectors across process invocations on ONE machine. Every knob is pinned:
//
//  - numThreads = 1 — single-threaded WASM. A multi-threaded reduction sums partial results in a
//    data-race-dependent ORDER, and float addition is not associative, so pinning to 1 makes the
//    output bytes a pure function of the input bytes.
//  - proxy = false — do not proxy WASM out to a Web Worker (a browser knob, pinned rather than left to
//    an environment-sniffed default that could drift between patch releases).
//  - wasmPaths — an explicit filesystem dir pointing at the INSTALLED onnxruntime-web's own `dist/`,
//    so the exact compiled `.wasm` kernels are this npm-resolved dependency's build.
//  - logLevel = 'error' — suppress info/warning console noise; does not affect the computed vectors.
//
// Resolving wasmPaths: the tree-sitter precedent (src/scanner/ast/extract.ts:19-22) resolves a WASM
// asset dir via `createRequire(...).resolve('<pkg>/package.json')`. onnxruntime-web@1.27 does NOT
// export "./package.json" (require.resolve throws ERR_PACKAGE_PATH_NOT_EXPORTED — confirmed against
// the installed 1.27.0), so that exact form fails for THIS package. Its main "." export (the node
// condition) resolves to `dist/ort.node.min.js`, and the compiled `.wasm` kernels sit in that same
// `dist/` dir — so `dirname(require.resolve('onnxruntime-web'))` IS the wasm asset dir, resolved
// through an exports subpath that actually exists.
const require = createRequire(import.meta.url);
const ONNXRUNTIME_WASM_DIR = dirname(require.resolve('onnxruntime-web'));

ort.env.wasm.numThreads = 1;
ort.env.wasm.proxy = false;
ort.env.wasm.wasmPaths = `${ONNXRUNTIME_WASM_DIR}/`;
ort.env.logLevel = 'error';

// ---------------------------------------------------------------------------------------------
// Tokenizer bring-up — grounded in the bake-off glue (NOT a guessed API)
// ---------------------------------------------------------------------------------------------
//
// @huggingface/tokenizers@0.1.3 (NOT @huggingface/transformers — the meta-package Decision 3/4
// rejects for pulling in native onnxruntime-node + sharp). Native-free (its installed tree ships zero
// `.node` binaries — verified). The constructor is 2-arg `new Tokenizer(tokenizerJson, tokenizerConfig)`
// over the parsed tokenizer.json + tokenizer_config.json, and `encode(text, { add_special_tokens,
// return_token_type_ids })` returns `{ ids, attention_mask, token_type_ids }` — proven by the embed
// spike and matched by the package's own shipped type declarations (types/core/Tokenizer.d.ts).
// tsc resolves those declarations, but @typescript-eslint's typed program does not pick them up
// (the import surfaces as an unresolved/`any` type under type-aware linting → no-unsafe-* errors),
// so we pin the exact runtime slice we use in a local typed handle rather than let `any` propagate.

/** The narrow slice of Tokenizer#encode()'s output this class consumes. */
interface TokenizerEncoding {
  ids: number[];
  attention_mask: number[];
  token_type_ids?: number[];
}

/** The narrow instance surface this class uses (see the note above on why it is declared locally). */
interface Tokenizer {
  encode(
    text: string,
    opts: { add_special_tokens: boolean; return_token_type_ids: boolean }
  ): TokenizerEncoding;
}

/** Typed 2-arg constructor handle over the imported class (`new Tokenizer(tokenizerJson, config)`). */
const TokenizerCtor = HuggingFaceTokenizer as unknown as new (
  tokenizerJson: object,
  tokenizerConfig: object
) => Tokenizer;

function encode(tokenizer: Tokenizer, text: string): TokenizerEncoding {
  const enc: TokenizerEncoding = tokenizer.encode(text, {
    add_special_tokens: true,
    return_token_type_ids: true,
  });
  // Truncate to the bge trained sequence length. JS-side (engine-API-independent, deterministic).
  // Position 0 ([CLS]) is always preserved, so CLS pooling is unaffected.
  if (enc.ids.length <= MAX_SEQ_TOKENS) return enc;
  return {
    ids: enc.ids.slice(0, MAX_SEQ_TOKENS),
    attention_mask: enc.attention_mask.slice(0, MAX_SEQ_TOKENS),
    token_type_ids: enc.token_type_ids?.slice(0, MAX_SEQ_TOKENS),
  };
}

// ---------------------------------------------------------------------------------------------
// Output-tensor name resolution
// ---------------------------------------------------------------------------------------------
//
// A hardcoded `out.last_hidden_state` is true only for one exact ONNX export. Resolve it robustly, so
// a re-export or a q8-vs-fp32 swap can't silently read `undefined` at runtime:
function resolveOutputName(session: ort.InferenceSession): string {
  const named = session.outputNames.find((n) => /last_hidden|token_embed|hidden/.test(n));
  if (named) return named;
  const [first] = session.outputNames;
  if (!first) {
    throw new Error('WasmLocalEmbedder: the ONNX session declares zero outputs.');
  }
  return first;
}

const toInt64 = (nums: number[]): BigInt64Array => BigInt64Array.from(nums.map((n) => BigInt(n)));

export class WasmLocalEmbedder implements Embedder {
  private constructor(
    private readonly tokenizer: Tokenizer,
    private readonly session: ort.InferenceSession,
    private readonly outputName: string
  ) {}

  get model(): string {
    return ANCHOR_EMBED_MODEL;
  }

  get dims(): number {
    return ANCHOR_EMBED_DIMS;
  }

  /**
   * Batched embedding — the PASSAGE side: tokenize every text, right-pad to the batch's own max
   * sequence length, run ONE session.run() over the whole batch, then CLS-pool + L2-normalize each
   * row. The embed pass always calls this with a batch, never per-text in a loop.
   *
   * CLS POOLING: bge-small-en-v1.5's sentence embedding is the [CLS] token's last-hidden-state —
   * sequence position 0 — then L2-normalized. bge is trained with a CLS-pooled contrastive objective,
   * so reading position 0 (NEVER a mask-weighted mean) reproduces its published relatedness. The
   * attention_mask is still built and fed (the network attends over it); it just no longer
   * participates in POOLING.
   *
   * Guards beyond the raw glue: an explicit empty-input guard (Math.max() over [] is -Infinity and
   * would corrupt the batch) and a `pooled.length === ANCHOR_EMBED_DIMS` guard per row (so a
   * pinned-model/pinned-dims mismatch fails loudly at the first embed call, not as a silent shape bug).
   */
  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];

    const encodings = texts.map((t) => encode(this.tokenizer, t));
    const maxLen = Math.max(...encodings.map((e) => e.ids.length));
    const batchSize = encodings.length;

    const ids: number[] = [];
    const mask: number[] = [];
    const types: number[] = [];
    for (const e of encodings) {
      const pad = maxLen - e.ids.length;
      ids.push(...e.ids, ...new Array<number>(pad).fill(0));
      mask.push(...e.attention_mask, ...new Array<number>(pad).fill(0));
      const rowTypes = e.token_type_ids ?? new Array<number>(e.ids.length).fill(0);
      types.push(...rowTypes, ...new Array<number>(pad).fill(0));
    }

    const feeds: Record<string, ort.Tensor> = {
      input_ids: new ort.Tensor('int64', toInt64(ids), [batchSize, maxLen]),
      attention_mask: new ort.Tensor('int64', toInt64(mask), [batchSize, maxLen]),
    };
    // Conditional token_type_ids — not every BERT-family ONNX export declares this input.
    if (this.session.inputNames.includes('token_type_ids')) {
      feeds.token_type_ids = new ort.Tensor('int64', toInt64(types), [batchSize, maxLen]);
    }

    const out = await this.session.run(feeds);
    const hidden = out[this.outputName];
    if (!hidden) {
      throw new Error(
        `WasmLocalEmbedder: session.run() did not return the resolved output "${this.outputName}".`
      );
    }
    const [, seqLen, hiddenSize] = hidden.dims; // [batch, seq, hidden]
    // last_hidden_state is float32 for this model family. onnxruntime-web types Tensor#data as a
    // union across every possible element type; this is the one explicit, documented narrowing.
    const data = hidden.data as Float32Array;

    const vectors: Float32Array[] = [];
    for (let b = 0; b < batchSize; b++) {
      // CLS pooling: take hidden[b, 0, :] — row b, token 0 ([CLS]) — as the pooled vector, verbatim
      // (no mask, no mean). The row's [CLS] hidden state begins at flat offset (b * seqLen + 0) *
      // hiddenSize and runs `hiddenSize` contiguous floats.
      const pooled = new Float32Array(hiddenSize);
      const clsBase = b * seqLen * hiddenSize; // = (b * seqLen + 0) * hiddenSize
      for (let h = 0; h < hiddenSize; h++) pooled[h] = data[clsBase + h];

      // L2-normalize (fixed-order reduction — deterministic under numThreads=1).
      let norm = 0;
      for (let h = 0; h < hiddenSize; h++) norm += pooled[h] * pooled[h];
      norm = Math.sqrt(norm) || 1;
      for (let h = 0; h < hiddenSize; h++) pooled[h] /= norm;

      if (pooled.length !== ANCHOR_EMBED_DIMS) {
        throw new Error(
          `WasmLocalEmbedder: pooled vector length ${pooled.length} !== ANCHOR_EMBED_DIMS (${ANCHOR_EMBED_DIMS}). ` +
            `The pinned model's hidden size no longer matches the committed dims constant.`
        );
      }
      vectors.push(pooled);
    }
    return vectors;
  }

  /**
   * The QUERY side. Prepends BGE_QUERY_PREFIX (the bge asymmetric retrieval instruction) when
   * USE_QUERY_PREFIX (OQ2) is set, then runs the single-text passage path. Passage-side embed() is
   * never prefixed — only the query is. Returns the one pooled, L2-normalized query vector.
   */
  async embedQuery(text: string): Promise<Float32Array> {
    const prepared = USE_QUERY_PREFIX ? `${BGE_QUERY_PREFIX}${text}` : text;
    const [vector] = await this.embed([prepared]);
    return vector;
  }

  /** Wires ensureModelWeights -> tokenizer -> ONNX session in that exact order: weights first, so a
   *  cache/hash failure surfaces before any WASM work; tokenizer second; session third.
   *
   *  `noFetch: true` — NO embedder-create path ever fetches. Every caller that constructs an embedder
   *  (the read tail's getSharedEmbedder, the index tail's memo, the tests' real-weights smoke) reaches
   *  create() here, so hardcoding verify-only makes "embedder-create never fetches" hold universally.
   *  A missing OR present-but-corrupt cache throws (the caller degrades to lexical-only / skips the
   *  pass). The ONLY fetch path is the explicit `--embeddings` opt-in, which calls ensureModelWeights()
   *  WITHOUT noFetch (default fetch) BEFORE this tail, after which create() finds the cache valid. */
  static async create(): Promise<WasmLocalEmbedder> {
    const { modelPath, tokenizerJsonPath, tokenizerConfigPath } = await ensureModelWeights({
      noFetch: true,
    });

    const tokenizerJson = JSON.parse(readFileSync(tokenizerJsonPath, 'utf8')) as object;
    const tokenizerConfig = JSON.parse(readFileSync(tokenizerConfigPath, 'utf8')) as object;
    const tokenizer = new TokenizerCtor(tokenizerJson, tokenizerConfig);

    const modelBuffer = readFileSync(modelPath);
    const session = await ort.InferenceSession.create(modelBuffer, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    });
    const outputName = resolveOutputName(session);

    return new WasmLocalEmbedder(tokenizer, session, outputName);
  }
}
