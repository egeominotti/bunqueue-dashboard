import { useEffect, useMemo, useRef, useState } from 'react';
import {
  currentControlConnectionEpoch,
  useControlConnectionEpoch,
} from '@/lib/controlConnectionEpoch';
import { useControlActionGuard } from '@/lib/useControlActionGuard';

export interface WorkflowCommandOptions {
  operationGroup: string;
  scopeKey: unknown;
  onApplied?: () => void | Promise<void>;
  onSucceeded?: (label: string, value: unknown) => void;
}

interface WorkflowCommandReceipt {
  label: string;
  value: unknown;
}

interface WorkflowCommandState {
  connectionEpoch: number;
  scope: unknown;
  busy: string;
  error: string;
  receipt: WorkflowCommandReceipt | null;
}

export function useWorkflowCommand(options: WorkflowCommandOptions) {
  const connectionEpoch = useControlConnectionEpoch();
  const persistentLockKey = `workflow-command:${options.operationGroup}`;
  const actionGuard = useControlActionGuard(persistentLockKey);
  const scopeKey = useMemo(
    () => ({ local: options.scopeKey, connectionEpoch }),
    [connectionEpoch, options.scopeKey]
  );
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const locked = useRef<symbol | null>(null);
  const mounted = useRef(true);
  const renderedScope = useRef(scopeKey);
  const version = useRef(0);
  if (!Object.is(renderedScope.current, scopeKey)) {
    const connectionChanged = renderedScope.current.connectionEpoch !== connectionEpoch;
    renderedScope.current = scopeKey;
    version.current += 1;
    if (connectionChanged) locked.current = null;
  }

  const [state, setState] = useState<WorkflowCommandState>(() =>
    idleState(scopeKey, connectionEpoch)
  );

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      version.current += 1;
      locked.current = null;
    };
  }, []);

  const current = (runVersion: number, runConnectionEpoch: number) =>
    mounted.current &&
    runVersion === version.current &&
    runConnectionEpoch === currentControlConnectionEpoch();
  const run = async (label: string, command: () => Promise<unknown>) => {
    if (locked.current || connectionEpoch !== currentControlConnectionEpoch()) return;
    const persistentLease = actionGuard.begin(persistentLockKey);
    if (!persistentLease) return;
    const lock = Symbol('workflow-command');
    locked.current = lock;
    const runVersion = version.current;
    const runConnectionEpoch = connectionEpoch;
    const { onApplied, onSucceeded } = optionsRef.current;
    try {
      setState({ connectionEpoch, scope: scopeKey, busy: label, error: '', receipt: null });
      const value = await command();
      if (!current(runVersion, runConnectionEpoch)) return;
      setState({
        connectionEpoch,
        scope: scopeKey,
        busy: label,
        error: '',
        receipt: { label, value },
      });
      try {
        onSucceeded?.(label, value);
      } catch {
        // Presentation feedback must never turn an applied engine command into a failure.
      }
      try {
        await onApplied?.();
      } catch (caught) {
        if (current(runVersion, runConnectionEpoch)) {
          setState((currentState) => ({
            ...currentState,
            error: `Command succeeded; refresh failed: ${message(caught)}`,
          }));
        }
      }
    } catch (caught) {
      if (current(runVersion, runConnectionEpoch)) {
        setState({
          connectionEpoch,
          scope: scopeKey,
          busy: label,
          error: message(caught),
          receipt: null,
        });
      }
    } finally {
      persistentLease.finish();
      if (locked.current === lock) {
        locked.current = null;
        if (mounted.current && runConnectionEpoch === currentControlConnectionEpoch()) {
          setState((currentState) => ({ ...currentState, busy: '' }));
        }
      }
    }
  };

  const visible = Object.is(state.scope, scopeKey) ? state : idleState(scopeKey, connectionEpoch);

  return {
    busy: state.connectionEpoch === connectionEpoch ? state.busy : '',
    error: visible.error,
    result: visible.receipt?.value,
    succeeded: visible.receipt?.label ?? '',
    run,
    clearResult: () => setState((currentState) => ({ ...currentState, receipt: null })),
  };
}

function idleState(scope: unknown, connectionEpoch: number): WorkflowCommandState {
  return { connectionEpoch, scope, busy: '', error: '', receipt: null };
}

function message(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
