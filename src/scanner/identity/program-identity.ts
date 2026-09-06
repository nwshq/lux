import { createHash } from 'node:crypto';
import type { EdgeType } from '../../db/types.js';
import { posix } from 'node:path';

function encodeSegment(value: string): string {
  return encodeURIComponent(value);
}

function pathIdentity(prefix: string, path: string): string {
  const normalized = posix.normalize(path.replaceAll('\\', '/')).replace(/^\.\//u, '');
  return `${prefix}:${encodeSegment(normalized)}`;
}

export const vueComponentId = (path: string): string => pathIdentity('component:vue', path);
export const vueComposableId = (path: string, name: string): string =>
  `${pathIdentity('composable:vue', path)}#${encodeSegment(name)}`;
export const vueStoreId = (path: string, name: string): string =>
  `${pathIdentity('store:vue', path)}#${encodeSegment(name)}`;
export const vueComponentEventId = (componentId: string, event: string): string =>
  `${componentId}:event:${encodeSegment(event)}`;
export const bladeTemplateId = (path: string): string => pathIdentity('template:blade', path);
export const novaArtifactId = (path: string, name: string): string =>
  `${pathIdentity('artifact:nova', path)}#${encodeSegment(name)}`;

export function programEdgeId(
  edgeType: EdgeType,
  sourceId: string,
  targetId: string,
  producer: string
): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([edgeType, sourceId, targetId, producer]))
    .digest('hex')
    .slice(0, 32);
  return `edge:${edgeType}:${digest}`;
}
