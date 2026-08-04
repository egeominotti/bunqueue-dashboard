/** Coordinates exclusive process transitions with concurrent SDK leases. */
export interface AgentLifecyclePort {
  assertOpen(): void;
  lease<T>(operation: () => Promise<T>): Promise<T>;
  run<T>(operation: () => Promise<T>): Promise<T>;
  close(operation: () => Promise<void>): Promise<void>;
}

export class AgentLifecycleClosedError extends Error {
  constructor() {
    super('The Bunqueue control agent is closing');
    this.name = 'AgentLifecycleClosedError';
  }
}

export class AgentLifecycleGate implements AgentLifecyclePort {
  private barrier: Promise<void> = Promise.resolve();
  private leases = new Set<Promise<void>>();
  private closed = false;
  private closing: Promise<void> | null = null;

  assertOpen(): void {
    if (this.closed) throw new AgentLifecycleClosedError();
  }

  lease<T>(operation: () => Promise<T>): Promise<T> {
    try {
      this.assertOpen();
    } catch (error) {
      return Promise.reject(error);
    }
    const result = this.barrier.then(operation);
    const batch = this.leases;
    const completion = result.then(
      () => undefined,
      () => undefined
    );
    batch.add(completion);
    void completion.then(() => batch.delete(completion));
    return result;
  }

  run<T>(operation: () => Promise<T>): Promise<T> {
    try {
      this.assertOpen();
    } catch (error) {
      return Promise.reject(error);
    }
    return this.enqueueTransition(operation);
  }

  close(operation: () => Promise<void>): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = this.enqueueTransition(operation);
    return this.closing;
  }

  private enqueueTransition<T>(operation: () => Promise<T>): Promise<T> {
    const precedingBarrier = this.barrier;
    const precedingLeases = this.leases;
    this.leases = new Set();
    const result = precedingBarrier
      .then(() => Promise.all(precedingLeases))
      .then(operation);
    this.barrier = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}
