/** Frozen Phase 3 capability states. */
export type CapabilityState =
  | 'active'
  | 'partial'
  | 'unsupported'
  | 'failed'
  | 'not_applicable';

/** Frozen Phase 3 evidence reported for one language capability. */
export interface CapabilityEvidenceV1 {
  state: CapabilityState;
  producer: string;
  nodes: number;
  edges: number;
  failures: number;
  reason?: string;
}

export type CoverageCapability =
  | 'syntax'
  | 'symbols'
  | 'imports'
  | 'calls'
  | 'references'
  | 'framework';

/** Frozen Phase 3 language-level capability coverage contract. */
export interface LanguageCapabilityCoverageV1 {
  schemaVersion: 1;
  languageId: string;
  files: number;
  symbolizedFiles: number;
  symbols: number;
  relatedSymbols: number;
  capabilities: Record<CoverageCapability, CapabilityEvidenceV1>;
}
