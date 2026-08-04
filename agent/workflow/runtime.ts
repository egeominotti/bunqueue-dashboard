import { realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  Engine,
  type EngineOptions,
  type ExecutionState,
  type Workflow,
} from 'bunqueue/workflow';
import { managedAuthToken } from '../managedTarget';
import type { ServerConfig } from '../manager';
import {
  configuredWorkflowModule,
  messageOf,
  readyRuntimeStatus,
  stoppedRuntimeStatus,
  WorkflowRuntimeUnavailableError,
  workflowRuntimeOptions,
  workflowRuntimeSignature,
} from './runtimeConfig';

export { WorkflowRuntimeUnavailableError } from './runtimeConfig';

export interface WorkflowRuntimeStatus {
  configured: boolean;
  ready: boolean;
  moduleName?: string;
  workflowNames: string[];
  queueName?: string;
  concurrency?: number;
  error?: string;
}

export interface WorkflowRuntimePort {
  status(config: ServerConfig, activate?: boolean): Promise<WorkflowRuntimeStatus>;
  reload(config: ServerConfig): Promise<WorkflowRuntimeStatus>;
  start(config: ServerConfig, workflowName: string, input?: unknown): Promise<unknown>;
  signal(config: ServerConfig, id: string, event: string, payload?: unknown): Promise<void>;
  recover(config: ServerConfig): Promise<unknown>;
  resumeCompensation(config: ServerConfig, id: string): Promise<void>;
  abandonCompensation(config: ServerConfig, id: string): Promise<void>;
  archive(config: ServerConfig, maxAgeMs: number, states: ExecutionState[]): Promise<number>;
  cleanup(config: ServerConfig, maxAgeMs: number, states: ExecutionState[]): Promise<number>;
  close(): Promise<void>;
}

interface ActiveRuntime {
  engine: Engine;
  signature: string;
  moduleName: string;
  workflowNames: string[];
  queueName: string;
  concurrency: number;
  initializationFailure?: string;
  closeFailure?: string;
}

interface RuntimeModule {
  workflows?: Workflow[];
  workflowNames?: string[];
  registerWorkflowRuntime?: (engine: Engine) => unknown | Promise<unknown>;
  default?: (engine: Engine) => unknown | Promise<unknown>;
}

export type WorkflowEngineFactory = (options: EngineOptions) => Engine;

export class WorkflowRuntime implements WorkflowRuntimePort {
  private active: ActiveRuntime | null = null;
  private gate: Promise<void> = Promise.resolve();

  constructor(
    private readonly createEngine: WorkflowEngineFactory = (options) => new Engine(options)
  ) {}

  status(config: ServerConfig, activate = true): Promise<WorkflowRuntimeStatus> {
    return this.serial(async () => {
      const modulePath = configuredWorkflowModule(config);
      try {
        if (!modulePath) {
          await this.closeActive();
          return { configured: false, ready: false, workflowNames: [] };
        }
        if (!activate) {
          await this.closeActive();
          return stoppedRuntimeStatus(config, modulePath);
        }
        const active = await this.ensure(config);
        return readyRuntimeStatus(active);
      } catch (error) {
        const active = this.active;
        return {
          configured: Boolean(modulePath),
          ready: false,
          moduleName: modulePath ? basename(modulePath) : active?.moduleName,
          workflowNames: [],
          queueName: active?.queueName,
          concurrency: active?.concurrency,
          error: messageOf(error),
        };
      }
    });
  }

  reload(config: ServerConfig): Promise<WorkflowRuntimeStatus> {
    return this.serial(async () => {
      await this.closeActive();
      return readyRuntimeStatus(await this.ensure(config));
    });
  }

  start(config: ServerConfig, workflowName: string, input?: unknown): Promise<unknown> {
    return this.run(config, (engine) => engine.start(workflowName, input));
  }

  signal(config: ServerConfig, id: string, event: string, payload?: unknown): Promise<void> {
    return this.run(config, (engine) => engine.signal(id, event, payload));
  }

  recover(config: ServerConfig): Promise<unknown> {
    return this.run(config, (engine) => engine.recover());
  }

  resumeCompensation(config: ServerConfig, id: string): Promise<void> {
    return this.run(config, (engine) => engine.resumeCompensation(id));
  }

  abandonCompensation(config: ServerConfig, id: string): Promise<void> {
    return this.run(config, (engine) => engine.abandonCompensation(id));
  }

  archive(
    config: ServerConfig,
    maxAgeMs: number,
    states: ExecutionState[]
  ): Promise<number> {
    return this.run(config, (engine) => engine.archive(maxAgeMs, states));
  }

  cleanup(
    config: ServerConfig,
    maxAgeMs: number,
    states: ExecutionState[]
  ): Promise<number> {
    return this.run(config, (engine) => engine.cleanup(maxAgeMs, states));
  }

  close(): Promise<void> {
    return this.serial(() => this.closeActive());
  }

  private run<T>(config: ServerConfig, operation: (engine: Engine) => Promise<T> | T): Promise<T> {
    return this.serial(async () => operation((await this.ensure(config)).engine));
  }

  private async ensure(config: ServerConfig): Promise<ActiveRuntime> {
    if (this.active?.closeFailure !== undefined) {
      throw quarantinedRuntimeError(this.active);
    }
    const requested = configuredWorkflowModule(config);
    if (!requested) {
      throw new WorkflowRuntimeUnavailableError(
        'Set BUNQUEUE_WORKFLOW_MODULE in Server extraEnv to an absolute runtime module path.'
      );
    }
    if (!isAbsolute(requested)) {
      throw new WorkflowRuntimeUnavailableError('BUNQUEUE_WORKFLOW_MODULE must be absolute.');
    }
    const path = await realpath(requested).catch(() => {
      throw new WorkflowRuntimeUnavailableError(
        'The configured workflow runtime module was not found.'
      );
    });
    const modified = (await stat(path)).mtimeMs;
    const options = workflowRuntimeOptions(config);
    const signature = workflowRuntimeSignature(config, path, modified, options);
    if (this.active?.signature === signature) return this.active;

    await this.closeActive();
    const imported = (await import(`${pathToFileURL(path).href}?v=${modified}`)) as RuntimeModule;
    const definitions = Array.isArray(imported.workflows) ? imported.workflows : [];
    const register = imported.registerWorkflowRuntime ?? imported.default;
    if (!register && definitions.length === 0) {
      throw new WorkflowRuntimeUnavailableError(
        'Workflow module must export workflows[] or registerWorkflowRuntime(engine).'
      );
    }
    const engine = this.createEngine({
      dataPath: config.dataPath,
      queueName: options.queueName,
      concurrency: options.concurrency,
      connection: {
        host: '127.0.0.1',
        port: config.tcpPort,
        token: managedAuthToken(config),
      },
    });
    const active: ActiveRuntime = {
      engine,
      signature,
      moduleName: basename(path),
      workflowNames: [],
      ...options,
    };
    this.active = active;
    try {
      const names = new Set<string>();
      const originalRegister = engine.register.bind(engine);
      engine.register = ((workflow: Workflow) => {
        const registered = originalRegister(workflow);
        names.add(workflowName(workflow.name));
        return registered;
      }) as Engine['register'];
      try {
        for (const workflow of definitions) engine.register(workflow);
        if (register) await register(engine);
      } finally {
        engine.register = originalRegister as Engine['register'];
      }
      if (imported.workflowNames !== undefined && !Array.isArray(imported.workflowNames)) {
        throw new WorkflowRuntimeUnavailableError('workflowNames must be an array of strings.');
      }
      for (const name of imported.workflowNames ?? []) names.add(workflowName(name));
      active.workflowNames = Array.from(names).sort();
      return active;
    } catch (error) {
      try {
        active.initializationFailure ??= messageOf(error);
      } finally {
        await this.closeActive();
      }
      throw error;
    }
  }

  private async closeActive(): Promise<void> {
    const previous = this.active;
    if (!previous) return;
    try {
      await previous.engine.close(true);
    } catch (error) {
      previous.closeFailure ??= messageOf(error);
      throw quarantinedRuntimeError(previous);
    }
    if (this.active === previous) this.active = null;
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.gate.then(operation, operation);
    this.gate = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}

function quarantinedRuntimeError(active: ActiveRuntime): WorkflowRuntimeUnavailableError {
  const initialization = active.initializationFailure !== undefined
    ? ` Initialization failed: ${active.initializationFailure}.`
    : '';
  return new WorkflowRuntimeUnavailableError(
    `Workflow Engine is quarantined.${initialization} Shutdown failed: ${active.closeFailure}. ` +
      'Restart the control agent before running or reloading workflows.'
  );
}

function workflowName(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 256) {
    throw new WorkflowRuntimeUnavailableError(
      'workflowNames must contain strings between 1 and 256 characters.'
    );
  }
  return value;
}
