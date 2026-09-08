export type Tranche3MutationKind =
  | 'remove-jsx-use'
  | 'make-hook-unused'
  | 'compute-expo-destination'
  | 'duplicate-expo-public-route'
  | 'compute-react-navigation-screen'
  | 'remove-interface-implementation'
  | 'retarget-same-named-interface'
  | 'remove-view-model-construction'
  | 'compute-event-key'
  | 'change-bus-identity'
  | 'break-tsconfig-alias'
  | 'break-workspace-export'
  | 'delete-edge-target'
  | 'disable-framework-producer';
export interface Tranche3MutationV1 {
  id: string;
  corpus: 'auctic-mobile' | 'example-workspace' | 'example-dashboard' | 'synthetic';
  kind: Tranche3MutationKind;
  files: string[];
  expectedFailedChecks: string[];
  expectedDiagnostics?: string[];
}
export interface MutationRunV1 {
  mutation: Tranche3MutationV1;
  baselinePassed: boolean;
  mutationFailedAsExpected: boolean;
  restoredPassed: boolean;
  failedChecks: string[];
  observedDiagnostics: string[];
}
export function mutationAccepted(run: MutationRunV1) {
  return (
    run.baselinePassed &&
    run.mutationFailedAsExpected &&
    run.restoredPassed &&
    run.failedChecks.length > 0
  );
}
