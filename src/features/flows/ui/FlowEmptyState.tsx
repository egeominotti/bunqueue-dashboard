import { Card } from '@/components/ui/Card';
import { shortFlowId } from '../domain/flowConstants';
import type { RecentFlow } from '../domain/recentFlows';

export function FlowEmptyState({
  recent,
  onOpen,
}: {
  recent: RecentFlow[];
  onOpen: (root: string) => void;
}) {
  return (
    <Card>
      <div className="py-16 text-center">
        <p className="text-sm text-muted">No flow loaded.</p>
        <p className="mt-1 text-xs text-faint">
          Enter a job ID, or choose “View flow” from Job Inspector.
        </p>
        {recent.length > 0 && (
          <div className="mt-6">
            <p className="mb-2 text-[11px] font-medium uppercase tracking-wider text-faint">
              Recently viewed
            </p>
            <div className="flex flex-wrap justify-center gap-2">
              {recent.map((item) => (
                <button
                  key={item.root}
                  type="button"
                  title={item.root}
                  onClick={() => onOpen(item.root)}
                  className="min-h-10 rounded-lg border border-line bg-surface-2 px-3 py-1.5 font-mono text-xs text-muted hover:text-fg"
                >
                  <span translate="no">{shortFlowId(item.root)}</span>
                  <span className="ml-2 text-faint">{item.nodes} nodes</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}
