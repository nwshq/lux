export function staticActionScalar(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.includes('${{') || /[$`]\(|\$[A-Za-z_{]/u.test(value))
    return undefined;
  return value;
}
