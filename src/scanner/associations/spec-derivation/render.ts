import type { SpecDerivationEvidenceClaim, SpecDerivationEvidencePacketV1 } from './contract.js';

export function renderSpecDerivationEvidenceJson(packet: SpecDerivationEvidencePacketV1): string {
  return JSON.stringify(packet, null, 2);
}

function renderClaims(title: string, claims: SpecDerivationEvidenceClaim[]): string[] {
  const lines = [`\n${title}`];
  if (claims.length === 0) {
    lines.push('- No source evidence found for this track.');
    return lines;
  }
  for (const claim of claims) {
    lines.push(`- [${claim.support}] ${claim.sourceFact}`);
    if (claim.possibleInterpretation) {
      lines.push(`  possible interpretation: ${claim.possibleInterpretation}`);
    }
    for (const ref of claim.evidence.slice(0, 3)) {
      lines.push(`  evidence: ${ref.kind} ${ref.summary}`);
    }
  }
  return lines;
}

export function renderSpecDerivationEvidenceText(packet: SpecDerivationEvidencePacketV1): string {
  const lines: string[] = [];
  lines.push('Spec-Derivation Evidence');
  lines.push(`Target: ${packet.target.kind} ${packet.target.identifier}`);
  lines.push(`Resolution: ${packet.target.resolutionState}`);
  lines.push(`Trust: ${packet.sourceScope.trustState}`);
  lines.push(`Sufficiency: ${packet.sufficiency.overall}`);
  lines.push(
    `Can support downstream draft: ${packet.sufficiency.canSupportSpecDraft ? 'yes' : 'no'}`
  );
  lines.push(...renderClaims('Entry Surfaces', packet.candidateOperation.entrySurfaces));
  lines.push(...renderClaims('State Changes', packet.stateChanges));
  lines.push(...renderClaims('Decision Logic', packet.decisionLogic));
  lines.push(...renderClaims('Data Flow', packet.dataFlow));
  lines.push(...renderClaims('Operational Effects', packet.operationalEffects));
  lines.push(...renderClaims('Supporting Context', packet.supportingContext));
  if (packet.sufficiency.missingEvidence.length > 0) {
    lines.push('\nMissing Evidence');
    for (const missing of packet.sufficiency.missingEvidence) lines.push(`- ${missing}`);
  }
  if (packet.reviewPrompts.length > 0) {
    lines.push('\nReview Prompts');
    for (const prompt of packet.reviewPrompts) {
      lines.push(`- ${prompt.topic}: ${prompt.questionForSpecSystem}`);
    }
  }
  return lines.join('\n');
}

export function renderSpecDerivationEvidenceMarkdown(
  packet: SpecDerivationEvidencePacketV1
): string {
  const lines: string[] = [];
  lines.push('# Spec-Derivation Evidence');
  lines.push('');
  lines.push(`- Target: \`${packet.target.kind} ${packet.target.identifier}\``);
  lines.push(`- Resolution: \`${packet.target.resolutionState}\``);
  lines.push(`- Trust: \`${packet.sourceScope.trustState}\``);
  lines.push(`- Sufficiency: \`${packet.sufficiency.overall}\``);
  lines.push('');
  for (const section of [
    ['Entry Surfaces', packet.candidateOperation.entrySurfaces],
    ['State Changes', packet.stateChanges],
    ['Decision Logic', packet.decisionLogic],
    ['Data Flow', packet.dataFlow],
    ['Operational Effects', packet.operationalEffects],
    ['Supporting Context', packet.supportingContext],
  ] as const) {
    lines.push(`## ${section[0]}`);
    if (section[1].length === 0) {
      lines.push('- No source evidence found for this track.');
    } else {
      for (const claim of section[1]) {
        lines.push(`- **${claim.support}**: ${claim.sourceFact}`);
      }
    }
    lines.push('');
  }
  lines.push('## Review Prompts');
  for (const prompt of packet.reviewPrompts) {
    lines.push(`- ${prompt.questionForSpecSystem}`);
  }
  lines.push('');
  return lines.join('\n');
}
