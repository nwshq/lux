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
export const reactComponentId = (path: string, exported: string): string =>
  `${pathIdentity('component:react', path)}#${encodeSegment(exported)}`;
export const busEventId = (bus: string, event: string): string =>
  `artifact:event-bus:${encodeSegment(bus)}#${encodeSegment(event)}`;
export const expoRouteId = (route: string): string => `surface:route:expo:${encodeSegment(route)}`;
export const reactContextId = (path: string, exported: string): string =>
  `${pathIdentity('context:react', path)}#${encodeSegment(exported)}`;
export const reactHookId = (path: string, exported: string): string =>
  `${pathIdentity('hook:react', path)}#${encodeSegment(exported)}`;
export const reactNavigatorId = (path: string, localName: string): string =>
  `${pathIdentity('navigator:react-navigation', path)}#${encodeSegment(localName)}`;
export const reactNavigationScreenId = (navigatorId: string, name: string): string =>
  `surface:route:react-navigation:${encodeSegment(navigatorId)}#${encodeSegment(name)}`;
export const terraformModuleId = (modulePath: string): string =>
  pathIdentity('artifact:terraform-module', modulePath === '' ? '.' : modulePath);
export const terraformResourceId = (modulePath: string, address: string): string =>
  `resource:terraform:${encodeSegment(modulePath === '' ? '.' : modulePath)}#${encodeSegment(address)}`;
export const terraformProviderId = (source: string, alias = 'default'): string =>
  `artifact:terraform-provider:${encodeSegment(source)}#${encodeSegment(alias)}`;
export const terraformRemoteStateId = (backend: string, key: string): string =>
  `artifact:terraform-state:${encodeSegment(backend)}#${encodeSegment(key)}`;
export const lambdaHandlerId = (runtime: string, handler: string): string =>
  `artifact:lambda-handler:${encodeSegment(runtime)}#${encodeSegment(handler)}`;
export const workflowId = (path: string): string => pathIdentity('artifact:workflow', path);
export const workflowJobId = (path: string, job: string): string =>
  `${workflowId(path)}#job:${encodeSegment(job)}`;
export const workflowStepId = (path: string, job: string, step: string): string =>
  `${workflowJobId(path, job)}#step:${encodeSegment(step)}`;
export const workflowArtifactId = (path: string, name: string): string =>
  `${workflowId(path)}#artifact:${encodeSegment(name)}`;
export const actionId = (uses: string): string => `artifact:action:${encodeSegment(uses)}`;
export const repositoryPathArtifactId = (path: string): string =>
  pathIdentity('artifact:repository-path', path);
export const containerImageId = (reference: string): string =>
  `artifact:container-image:${encodeSegment(reference)}`;
export const containerStageId = (dockerfile: string, stage: string): string =>
  `${pathIdentity('artifact:container-stage', dockerfile)}#${encodeSegment(stage)}`;
export const containerContextId = (context: string): string =>
  pathIdentity('artifact:container-context', context);
export const composeServiceId = (composeFile: string, service: string): string =>
  `${pathIdentity('artifact:compose-service', composeFile)}#${encodeSegment(service)}`;

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
