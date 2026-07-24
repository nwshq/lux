// The `embedding` section (Phase 4, Decision 7/11) — validateEmbeddingConfig via loadLspConfig. Pins
// the token-hygiene fail-closed gate (an inline token / near-miss secret key / unknown key throws), the
// provider/model contract, and that the section is inert-absent (byte-identical to no-Phase-4 when the
// section and env token are both absent). Env-only selection is exercised in the embedder tests; here
// the config LOAD contract is the subject.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadLspConfig } from '../config.js';

describe('loadLspConfig — embedding section (Phase 4, spec 19 Part A)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lux-embed-cfg-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const write = (yaml: string): void => writeFileSync(join(dir, 'lux.yaml'), yaml);

  it('accepts a valid { provider: openai, model } section', () => {
    write('embedding:\n  provider: openai\n  model: text-embedding-3-small\n');
    expect(loadLspConfig(dir).embedding).toEqual({
      provider: 'openai',
      model: 'text-embedding-3-small',
    });
  });

  it('accepts a provider-only and a model-only section', () => {
    write('embedding:\n  provider: openai\n');
    expect(loadLspConfig(dir).embedding).toEqual({ provider: 'openai' });
    write('embedding:\n  model: text-embedding-3-large\n');
    expect(loadLspConfig(dir).embedding).toEqual({ model: 'text-embedding-3-large' });
  });

  it('returns undefined embedding when the section is absent', () => {
    write('lsp:\n  enabled: false\n');
    expect(loadLspConfig(dir).embedding).toBeUndefined();
  });

  it('returns undefined embedding when no lux.yaml is present', () => {
    expect(loadLspConfig(dir).embedding).toBeUndefined();
  });

  it('FAILS CLOSED on an inline embedding.token (Decision 11) — with the rotate-the-key message', () => {
    write('embedding:\n  provider: openai\n  token: sk-leaked-into-a-committed-file\n');
    expect(() => loadLspConfig(dir)).toThrow(/embedding\.token` is not permitted/);
    expect(() => loadLspConfig(dir)).toThrow(/LUX_EMBEDDING_TOKEN/);
    expect(() => loadLspConfig(dir)).toThrow(/rotate/i);
  });

  it('rejects near-miss secret keys (apiKey / api_key / key / secret)', () => {
    for (const k of ['apiKey', 'api_key', 'key', 'secret']) {
      write(`embedding:\n  ${k}: whatever\n`);
      expect(() => loadLspConfig(dir), `key ${k}`).toThrow(/not permitted|rotate/i);
    }
  });

  it('routes re-cased / synonym secret keys to the ROTATE message (Token/auth/bearer/password, Fix 2)', () => {
    // These previously fell through to the generic "unknown key" arm: `'token' in obj` is case-sensitive
    // (misses Token/TOKEN) and the near-miss regex omitted auth/bearer/password/credential. All must now
    // get the rotate-the-key guidance (LUX_EMBEDDING_TOKEN + rotate), not a rename nudge.
    for (const k of ['Token', 'TOKEN', 'auth', 'Bearer', 'password', 'credential', 'credentials']) {
      write(`embedding:\n  ${k}: whatever\n`);
      expect(() => loadLspConfig(dir), `key ${k}`).toThrow(/not permitted/);
      expect(() => loadLspConfig(dir), `key ${k} rotate`).toThrow(/rotate/i);
      expect(() => loadLspConfig(dir), `key ${k} env`).toThrow(/LUX_EMBEDDING_TOKEN/);
    }
  });

  it('rejects an unknown key under embedding', () => {
    write('embedding:\n  provider: openai\n  endpoint: https://example.com\n');
    expect(() => loadLspConfig(dir)).toThrow(/unknown key `embedding\.endpoint`/);
  });

  it("rejects a provider other than 'openai'", () => {
    write('embedding:\n  provider: anthropic\n');
    expect(() => loadLspConfig(dir)).toThrow(/must be 'openai'/);
  });

  it('rejects an empty / non-string model', () => {
    write('embedding:\n  model: "   "\n');
    expect(() => loadLspConfig(dir)).toThrow(/`embedding\.model` must be a non-empty string/);
  });

  it('trims a surrounding-whitespace model before returning (Fix 7 — a trailing space would 400)', () => {
    write('embedding:\n  provider: openai\n  model: "  text-embedding-3-large  "\n');
    expect(loadLspConfig(dir).embedding).toEqual({
      provider: 'openai',
      model: 'text-embedding-3-large',
    });
  });

  it('rejects a non-mapping embedding section', () => {
    write('embedding:\n  - openai\n');
    expect(() => loadLspConfig(dir)).toThrow(/`embedding` must be a mapping/);
  });

  it('does not disturb the other config sections', () => {
    write('embedding:\n  provider: openai\nast:\n  enabled: false\n');
    const config = loadLspConfig(dir);
    expect(config.embedding).toEqual({ provider: 'openai' });
    expect(config.ast?.enabled).toBe(false);
    expect(config.deps.enabled).toBe(true);
    expect(config.lsp.enabled).toBe(false);
  });
});
