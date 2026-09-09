import { z } from 'zod';
const EvidenceFile = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (v) =>
      !v.startsWith('/') &&
      !/^[a-z][a-z0-9+.-]*:/iu.test(v) &&
      !v.split(/[\\/]+/u).includes('..') &&
      ![...v].some((c) => c.charCodeAt(0) <= 31 || c.charCodeAt(0) === 127),
    'confined relative path'
  );
export const InfrastructureConfigSchema = z.strictObject({
  enabled: z.boolean().default(true),
  terraform: z.boolean().default(true),
  githubActions: z.boolean().default(true),
  docker: z.boolean().default(true),
  compose: z.boolean().default(true),
  composeFiles: z.array(EvidenceFile).max(100).default([]),
});
export type InfrastructureConfig = z.infer<typeof InfrastructureConfigSchema>;
