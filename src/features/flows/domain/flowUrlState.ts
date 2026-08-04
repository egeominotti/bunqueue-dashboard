import { flowJobIdError } from './flowSnapshot';

export type FlowToolMode = 'explore' | 'create' | 'operations';

export interface FlowUrlState {
  root: string;
  mode: FlowToolMode;
  node: string | null;
}

export type FlowUrlPatch = Partial<FlowUrlState>;

const FLOW_MODES = new Set<FlowToolMode>(['explore', 'create', 'operations']);

export function readFlowUrlState(params: URLSearchParams, fallbackRoot = ''): FlowUrlState {
  const rawRoot = params.get('root');
  const root = validJobId(rawRoot) ? (rawRoot as string) : fallbackRoot;
  const rawMode = params.get('mode');
  const mode = FLOW_MODES.has(rawMode as FlowToolMode) ? (rawMode as FlowToolMode) : 'explore';
  const rawNode = params.get('node');
  const node = root && validJobId(rawNode) ? rawNode : null;
  return { root, mode, node };
}

export function flowSearchParams(value: FlowUrlState): URLSearchParams {
  const params = new URLSearchParams();
  if (value.root) params.set('root', value.root);
  if (value.mode !== 'explore') params.set('mode', value.mode);
  if (value.root && value.node) params.set('node', value.node);
  return params;
}

export function patchFlowSearchParams(
  params: URLSearchParams,
  patch: FlowUrlPatch,
  fallbackRoot = ''
): URLSearchParams {
  return flowSearchParams({ ...readFlowUrlState(params, fallbackRoot), ...patch });
}

function validJobId(value: string | null): value is string {
  return Boolean(value && flowJobIdError(value) === null);
}
