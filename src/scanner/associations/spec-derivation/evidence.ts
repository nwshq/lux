import { createHash } from 'node:crypto';
import type {
  SpecDerivationClaimType,
  SpecDerivationEvidenceClaim,
  SpecDerivationEvidenceRef,
  SpecDerivationMutationKind,
  SpecDerivationSupport,
} from './contract.js';

function stableClaimId(parts: readonly string[]): string {
  return `sdc:${createHash('sha1').update(parts.join('\0')).digest('hex').slice(0, 12)}`;
}

export function buildSpecEvidenceClaim(input: {
  claimType: SpecDerivationClaimType;
  sourceFact: string;
  support: SpecDerivationSupport;
  evidence: SpecDerivationEvidenceRef[];
  possibleInterpretation?: string;
  mutationKind?: SpecDerivationMutationKind;
  idParts?: string[];
}): SpecDerivationEvidenceClaim {
  const claimId = stableClaimId([
    input.claimType,
    input.sourceFact,
    ...input.evidence.map(
      (ref) => `${ref.kind}:${ref.path ?? ''}:${ref.symbol ?? ''}:${ref.summary}`
    ),
    ...(input.idParts ?? []),
  ]);

  return {
    claimId,
    claimType: input.claimType,
    sourceFact: input.sourceFact,
    possibleInterpretation: input.possibleInterpretation,
    support: input.support,
    evidence: input.evidence,
    mutationKind: input.mutationKind,
  };
}

export function pathEvidenceRef(
  path: string | null | undefined,
  summary: string,
  kind: SpecDerivationEvidenceRef['kind'] = 'file',
  evidenceStrength: SpecDerivationEvidenceRef['evidenceStrength'] = 'direct'
): SpecDerivationEvidenceRef {
  return {
    kind,
    path: path ?? undefined,
    summary,
    evidenceStrength,
  };
}

export function symbolEvidenceRef(
  symbol: string,
  summary: string,
  path?: string | null,
  evidenceStrength: SpecDerivationEvidenceRef['evidenceStrength'] = 'direct'
): SpecDerivationEvidenceRef {
  return {
    kind: 'symbol',
    symbol,
    path: path ?? undefined,
    summary,
    evidenceStrength,
  };
}
