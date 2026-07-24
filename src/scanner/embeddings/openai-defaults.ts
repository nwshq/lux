// src/scanner/embeddings/openai-defaults.ts  (FENCED — scanner/embeddings/*)
//
// The single source of truth for the OpenAI default embedding-model id. Deliberately a plain,
// import-light string-const module: importing it pulls NO runtime class onto the caller's static graph
// (the tokenless-hot-path isolation is about ApiEmbedder — the runtime `fetch`-bearing class — NOT about
// a bare literal). Both api-embedder.ts (ApiEmbedder.fromConfig's model default) and active-model.ts
// (the pre-embedder queue-gate/coverage/read key) import THIS one literal, so the "no two-space split
// between the resolved model and what the read path keys on" guarantee is structural, not merely locked
// by active-model.test.ts. Living inside scanner/embeddings/, it is internal to the anchor-embeddings
// fence — both importers are already inside the fenced subtree.

/** OpenAI's 384-capable small model (returns exactly 384 dims via the `dimensions` request param). */
export const OPENAI_DEFAULT_MODEL = 'text-embedding-3-small';
