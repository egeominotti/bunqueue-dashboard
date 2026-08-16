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
  private pendingTransitions = 0;

  assertOpen(): void {
    if (this.closed) throw new AgentLifecycleClosedError();
  }

  lease<T>(operation: () => Promise<T>): Promise<T> {
    try {
      this.assertOpen();
    } catch (error) {
      return Promise.reject(error);
    }
    const batch = this.leases;
    let complete!: () => void;
    const completion = new Promise<void>((resolve) => {
      complete = resolve;
    });
    // Publish the lease before invoking user code. Its synchronous prefix may
    // re-enter run()/close(), which must observe this lease and wait for it.
    batch.add(completion);
    let result: Promise<T>;
    if (this.pendingTransitions === 0) {
      try {
        result = Promise.resolve(operation());
      } catch (error) {
        result = Promise.reject(error);
      }
    } else {
      result = this.barrier.then(operation);
    }
    void result.then(complete, complete).then(() => batch.delete(completion));
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
    this.pendingTransitions += 1;
    const result = precedingBarrier
      .then(() => Promise.all(precedingLeases))
      .then(operation);
    this.barrier = result.then(
      () => {
        this.pendingTransitions -= 1;
      },
      () => {
        this.pendingTransitions -= 1;
      }
    );
    return result;
  }
}
