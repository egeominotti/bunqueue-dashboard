import { Card } from '@/components/ui/Card';
import { MAX_FLOW_NODES } from '../domain/flowConstants';

export function FlowSearch({
  input,
  loading,
  onInput,
  onSubmit,
}: {
  input: string;
  loading: boolean;
  onInput: (value: string) => void;
  onSubmit: (event: React.FormEvent) => void;
}) {
  return (
    <Card className="mb-6">
      <form onSubmit={onSubmit} className="flex flex-wrap items-center gap-3">
        <input
          name="flow-job-id"
          autoComplete="off"
          spellCheck={false}
          maxLength={1024}
          value={input}
          onChange={(event) => onInput(event.target.value)}
          placeholder="Flow job ID"
          aria-label="Root job ID"
          aria-describedby="flow-input-help"
          className="min-w-0 flex-1 rounded-lg border border-line bg-surface-2 px-3 py-2 font-mono text-sm text-fg outline-none placeholder:text-faint focus-visible:ring-2 focus-visible:ring-accent/50"
        />
        <button
          type="submit"
          disabled={loading || !input.trim()}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-fg disabled:opacity-50"
        >
          {loading ? 'Loading…' : 'Load Flow'}
        </button>
      </form>
      <p id="flow-input-help" className="mt-2 text-xs text-faint">
        Start from any surviving structural node. Bunqueue 2.8.59 flow topology is resolved from
        durable parent, children, and dependency contracts. Up to {MAX_FLOW_NODES} nodes are
        rendered.
      </p>
    </Card>
  );
}
