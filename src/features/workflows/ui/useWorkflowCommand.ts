import { useEffect, useMemo, useRef, useState } from 'react';
import {
  currentControlConnectionEpoch,
  useControlConnectionEpoch,
} from '@/lib/controlConnectionEpoch';

export interface WorkflowCommandOptions {
  scopeKey: unknown;
  onApplied?: () => void | Promise<void>;
  onSucceeded?: (label: string, value: unknown) => void;
}

interface WorkflowCommandReceipt {
  label: string;
  value: unknown;
}

interface WorkflowCommandState {
  scope: unknown;
  busy: string;
  error: string;
  receipt: WorkflowCommandReceipt | null;
}

export function useWorkflowCommand(options: WorkflowCommandOptions) {
  const connectionEpoch = useControlConnectionEpoch();
  const scopeKey = useMemo(
    () => ({ local: options.scopeKey, connectionEpoch }),
    [connectionEpoch, options.scopeKey]
  );
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const locked = useRef(false);
  const mounted = useRef(true);
  const renderedScope = useRef(scopeKey);
  const version = useRef(0);
  if (!Object.is(renderedScope.current, scopeKey)) {
    renderedScope.current = scopeKey;
    version.current += 1;
    locked.current = false;
  }

  const [state, setState] = useState<WorkflowCommandState>(() => idleState(scopeKey));

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      version.current += 1;
      locked.current = false;
    };
  }, []);

  const current = (runVersion: number, runConnectionEpoch: number) =>
    mounted.current &&
    runVersion === version.current &&
    runConnectionEpoch === currentControlConnectionEpoch();
  const run = async (label: string, command: () => Promise<unknown>) => {
    if (locked.current || connectionEpoch !== currentControlConnectionEpoch()) return;
    locked.current = true;
    const runVersion = version.current;
    const runConnectionEpoch = connectionEpoch;
    const { onApplied, onSucceeded } = optionsRef.current;
    setState({ scope: scopeKey, busy: label, error: '', receipt: null });
    try {
      const value = await command();
      if (!current(runVersion, runConnectionEpoch)) return;
      setState({ scope: scopeKey, busy: label, error: '', receipt: { label, value } });
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
        setState({ scope: scopeKey, busy: label, error: message(caught), receipt: null });
      }
    } finally {
      if (current(runVersion, runConnectionEpoch)) {
        locked.current = false;
        setState((currentState) => ({ ...currentState, busy: '' }));
      }
    }
  };

  const visible = Object.is(state.scope, scopeKey) ? state : idleState(scopeKey);

  return {
    busy: visible.busy,
    error: visible.error,
    result: visible.receipt?.value,
    succeeded: visible.receipt?.label ?? '',
    run,
    clearResult: () => setState((currentState) => ({ ...currentState, receipt: null })),
  };
}

function idleState(scope: unknown): WorkflowCommandState {
  return { scope, busy: '', error: '', receipt: null };
}

function message(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
