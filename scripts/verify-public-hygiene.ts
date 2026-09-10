import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const forbidden = [
  /\bauctic\b/iu,
  /Example Maintainer/iu,
  /example-maintainer/iu,
  /\bchirocat\b/iu,
  /\bpulse\b/iu,
  /\brecon\b/iu,
  /example-sourcing/iu,
  /example-infrastructure/iu,
  /example-rds-clusters/iu,
  /iac-service-(?:vapor|mobileapi)/iu,
  /\/Users\/[A-Za-z0-9._-]+\//u,
  /[A-Za-z]:\\Users\\/u,
  /\b(?:McGrew|Pirtek|Sinai|Viridian|CoinBid|Toptal)\b/iu,
];
const files = execFileSync('git', ['ls-files', '-z'])
  .toString('utf8')
  .split('\0')
  .filter((file) => Boolean(file) && file !== 'scripts/verify-public-hygiene.ts');
const violations: string[] = [];
for (const file of files) {
  let content: string;
  try {
    content = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  for (const pattern of forbidden)
    if (pattern.test(content)) violations.push(`${file}: ${pattern.source}`);
}
if (violations.length) {
  console.error(`Public-hygiene violations:\n${violations.join('\n')}`);
  process.exit(1);
}
console.log(`Public-hygiene check passed: ${files.length} tracked paths inspected.`);
