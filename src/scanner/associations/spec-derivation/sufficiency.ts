import type {
  SpecDerivationEvidenceClaim,
  SpecDerivationSufficiencyBlock,
  SpecDerivationTarget,
} from './contract.js';
import { claimsIncludeDirectEvidence } from './mutations.js';

export function classifySpecDerivationSufficiency(input: {
  target: SpecDerivationTarget;
  stateChanges: SpecDerivationEvidenceClaim[];
  decisionLogic: SpecDerivationEvidenceClaim[];
  dataFlow: SpecDerivationEvidenceClaim[];
  operationalEffects: SpecDerivationEvidenceClaim[];
  supportingContext: SpecDerivationEvidenceClaim[];
}): SpecDerivationSufficiencyBlock {
  const missingEvidence: string[] = [];
  const conflictingEvidence = [
    ...input.stateChanges,
    ...input.decisionLogic,
    ...input.dataFlow,
    ...input.operationalEffects,
    ...input.supportingContext,
  ]
    .filter((claim) => claim.support === 'conflicting')
    .map((claim) => claim.sourceFact);

  if (input.target.resolutionState !== 'resolved') {
    return {
      overall: 'insufficient',
      canSupportSpecDraft: false,
      reasons: [`Target resolution is ${input.target.resolutionState}.`],
      missingEvidence: ['A resolved route, handler, job, listener, or command seed is required.'],
      conflictingEvidence,
    };
  }

  const trackDirect = {
    stateChanges: claimsIncludeDirectEvidence(input.stateChanges),
    decisionLogic: claimsIncludeDirectEvidence(input.decisionLogic),
    dataFlow: claimsIncludeDirectEvidence(input.dataFlow),
    operationalEffects: claimsIncludeDirectEvidence(input.operationalEffects),
  };

  for (const [track, found] of Object.entries(trackDirect)) {
    if (!found) missingEvidence.push(`No direct ${track} evidence was found.`);
  }

  const directTrackCount = Object.values(trackDirect).filter(Boolean).length;

  if (conflictingEvidence.length > 0) {
    return {
      overall: 'conflicting',
      canSupportSpecDraft: false,
      reasons: ['One or more evidence claims are marked conflicting.'],
      missingEvidence,
      conflictingEvidence,
    };
  }

  if (directTrackCount === 0) {
    return {
      overall: 'insufficient',
      canSupportSpecDraft: false,
      reasons: ['R11 requires at least one direct source-evidence path in a core track.'],
      missingEvidence,
      conflictingEvidence,
    };
  }

  if (missingEvidence.length > 0) {
    return {
      overall: 'partial',
      canSupportSpecDraft: true,
      reasons: [`Direct evidence exists in ${directTrackCount} core track(s).`],
      missingEvidence,
      conflictingEvidence,
    };
  }

  return {
    overall: 'sufficient',
    canSupportSpecDraft: true,
    reasons: ['Direct evidence exists across the core evidence tracks.'],
    missingEvidence,
    conflictingEvidence,
  };
}
