import type { WorkflowExecutionDetail } from '@/lib/bqTypes';
import { JsonBlock } from './WorkflowValue';

export function ExecutionPayloads({ execution }: { execution: WorkflowExecutionDetail }) {
  return (
    <div className="space-y-5">
      <Payload title="Input" value={execution.input} />
      <Payload title="Signals" value={execution.signals} />
      <Payload title="Resolved steps" value={execution.resolvedSteps} />
      <Payload title="Decisions" value={execution.decisions} />
    </div>
  );
}

function Payload({ title, value }: { title: string; value: unknown }) {
  return (
    <section>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-faint">{title}</h3>
      <JsonBlock value={value} />
    </section>
  );
}
