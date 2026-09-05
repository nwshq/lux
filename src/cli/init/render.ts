import type { InitPlanV1 } from './plan.js';

/** Stable human preview; intentionally prints only root-relative target paths. */
export function renderInitPlan(plan: InitPlanV1): string {
  const lines = ['Lux init preview'];
  if (plan.detected.length === 0) lines.push('  Detected: none');
  else {
    lines.push('  Detected:');
    for (const item of plan.detected) lines.push(`    - ${item}`);
  }
  lines.push('  Changes:');
  for (const change of plan.changes) lines.push(`    ${change.action.padEnd(9)} ${change.path}`);
  if (plan.diagnostics.length > 0) {
    lines.push('  Diagnostics:');
    for (const diagnostic of plan.diagnostics) lines.push(`    - ${diagnostic}`);
  }
  lines.push('Preview only. Re-run with --yes to apply these exact changes.');
  return lines.join('\n');
}
