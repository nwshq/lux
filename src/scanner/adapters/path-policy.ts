import { constants, openSync, closeSync, fstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { AdapterInputV1 } from './types.js';
export class AdapterRefusal extends Error {
  constructor(
    readonly code: 'path-escape' | 'limit',
    message: string
  ) {
    super(message);
  }
}
const within = (root: string, c: string) => {
  const r = relative(root, c);
  return r === '' || (!r.startsWith(`..${sep}`) && r !== '..' && !isAbsolute(r));
};
export function confinedRead(input: AdapterInputV1): { canonicalPath: string; bytes: Uint8Array } {
  if (
    [...input.filePath].some((c) => c.charCodeAt(0) <= 31 || c.charCodeAt(0) === 127) ||
    /^[a-z][a-z0-9+.-]*:/iu.test(input.filePath) ||
    input.filePath.split(/[\\/]+/u).includes('..')
  )
    throw new AdapterRefusal('path-escape', 'unsafe path');
  const roots = input.allowedRoots.map((root) => realpathSync(root)),
    candidate = realpathSync(
      isAbsolute(input.filePath) ? input.filePath : resolve(input.corpusRoot, input.filePath)
    );
  if (!roots.some((r) => within(r, candidate)))
    throw new AdapterRefusal('path-escape', 'outside allowed roots');
  let fd: number | undefined;
  try {
    fd = openSync(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
    const s = fstatSync(fd);
    if (!s.isFile()) throw new AdapterRefusal('path-escape', 'not regular file');
    if (s.size > input.limits.maxBytes) throw new AdapterRefusal('limit', 'file too large');
    return { canonicalPath: candidate, bytes: readFileSync(fd) };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
