/**
 * Request handling and origin/auth policy for the control agent.
 *
 * The agent can spawn configurable commands, so callers must retain both the
 * Origin and Host gates when binding it. Implementations are split under
 * agent/server/; this file preserves the existing public import path.
 */
export { createFetchHandler } from './server/handler';
export { AgentLifecycleGate } from './server/lifecycle';
export type { AgentLifecyclePort } from './server/lifecycle';
export {
  corsHeaders,
  hostnameOf,
  isHostAllowed,
  isOriginAllowed,
  resolveAllowedHosts,
  resolveAllowedOrigins,
} from './server/policy';
export type { AgentFetchHandler, AgentOptions } from './server/types';
