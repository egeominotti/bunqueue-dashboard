import type { WorkflowRuntimePort } from '../workflow/runtime';

export interface AgentOptions {
  allowedOrigins: string[];
  /** DNS-rebinding defense; compared by hostname only. */
  allowedHosts?: string[];
  /** On loopback, when set, changing requests must present this token. */
  token?: string;
  /** Network exposure: require token on every non-OPTIONS request. */
  requireTokenForAll?: boolean;
}

export interface AgentFetchHandler {
  (request: Request): Promise<Response>;
  /** Release the handler's persistent SDK resources. */
  close(): Promise<void>;
  /** Synchronously close admission and latch the process manager, then drain resources. */
  beginShutdown(): Promise<void>;
  /** Close resources through the lifecycle gate, then stop the managed process. */
  shutdown(): Promise<void>;
  /** Send SIGKILL to the managed process after terminal grace is exhausted. */
  forceShutdown(): void;
}

export interface RouteResponse {
  status: number;
  body: unknown;
}

export type JsonResponder = (
  data: unknown,
  status: number,
  origin: string | null
) => Response;

export interface HandlerResources {
  runtime: WorkflowRuntimePort;
  close(): Promise<void>;
}
