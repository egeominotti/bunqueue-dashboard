export interface WorkflowRuntimeStatus {
  configured: boolean;
  ready: boolean;
  moduleName?: string;
  workflowNames: string[];
  queueName?: string;
  concurrency?: number;
  error?: string;
}

export type WorkflowTerminalState = 'completed' | 'failed';

export interface WorkflowControlRepository {
  status(): Promise<WorkflowRuntimeStatus>;
  reload(): Promise<WorkflowRuntimeStatus>;
  start(workflowName: string, input?: unknown): Promise<{ id: string; workflowName: string }>;
  signal(executionId: string, event: string, payload?: unknown): Promise<void>;
  recover(): Promise<{ running: number; waiting: number; compensating: number; total: number }>;
  resumeCompensation(executionId: string): Promise<void>;
  abandonCompensation(executionId: string): Promise<void>;
  archive(maxAgeMs: number, states: WorkflowTerminalState[]): Promise<number>;
  cleanup(maxAgeMs: number, states: WorkflowTerminalState[]): Promise<number>;
}
