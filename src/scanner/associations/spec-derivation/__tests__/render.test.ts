import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LuxDatabase } from '../../../../db/index.js';
import { REPO_ROOT, cleanupSpecDb, makeSpecDb, seedRoute } from './test-helpers.js';
import { assembleSpecDerivationEvidencePacket } from '../assemble.js';
import {
  renderSpecDerivationEvidenceJson,
  renderSpecDerivationEvidenceMarkdown,
  renderSpecDerivationEvidenceText,
} from '../render.js';

describe('spec-derivation renderers', () => {
  let db: LuxDatabase;

  beforeEach(() => {
    db = makeSpecDb();
    seedRoute(db);
  });

  afterEach(() => cleanupSpecDb(db));

  it('renders evidence wording without spec-authoring language', () => {
    const packet = assembleSpecDerivationEvidencePacket(db, {
      question: 'What source evidence supports this operation?',
      target: 'POST /orders',
      kind: 'route',
      corpusPath: REPO_ROOT,
    });
    const text = renderSpecDerivationEvidenceText(packet);
    const markdown = renderSpecDerivationEvidenceMarkdown(packet);
    const json = renderSpecDerivationEvidenceJson(packet);

    expect(text).toContain('Spec-Derivation Evidence');
    expect(markdown).toContain('# Spec-Derivation Evidence');
    expect(JSON.parse(json).surface).toBe('spec-derivation-evidence');
    expect(`${text}\n${markdown}`).not.toContain('The system shall');
    expect(`${text}\n${markdown}`).not.toContain('Approved');
  });
});
