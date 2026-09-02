import { ErrorState, LoadingState, OfflineBanner } from '@/components/ui/feedback';
import { PageHeader } from '@/components/ui/PageHeader';
import { isDemo } from '@/lib/demo/isDemo';
import { isFlowConnectionFailure, useFlowExplorer } from '../application/useFlowExplorer';
import { DEMO_FLOW_ROOT } from '../domain/flowConstants';
import { FlowCreator } from './FlowCreator';
import { FlowEmptyState } from './FlowEmptyState';
import { FlowJobToolkit } from './FlowJobToolkit';
import { FlowSearch } from './FlowSearch';
import { FlowWorkspace } from './FlowWorkspace';

export function FlowPage() {
  const explorer = useFlowExplorer();
  return (
    <div>
      <PageHeader
        title="Job Flows"
        description="Inspect Bunqueue 2.9.3 parent, child, and dependency topology as an operational DAG."
        actions={
          explorer.graph && (
            <button
              type="button"
              disabled={explorer.loading}
              onClick={() => void explorer.load(explorer.rootParam)}
              className="rounded-lg border border-line px-3 py-1.5 text-sm text-muted hover:bg-surface-2 hover:text-fg disabled:opacity-50"
            >
              Refresh
            </button>
          )
        }
      />
      <nav aria-label="Job Flow tools" className="mb-5 flex border-b border-line">
        {(['explore', 'create', 'operations'] as const).map((item) => (
          <button
            key={item}
            type="button"
            aria-pressed={explorer.mode === item}
            onClick={() => explorer.setMode(item)}
            className={
              explorer.mode === item
                ? 'border-b-2 border-accent px-4 py-2 text-sm capitalize text-fg'
                : 'border-b-2 border-transparent px-4 py-2 text-sm capitalize text-faint hover:text-fg'
            }
          >
            {item === 'operations' ? 'Job methods' : item}
          </button>
        ))}
      </nav>
      {explorer.mode === 'create' && <FlowCreator onOpen={explorer.openRecent} />}
      {explorer.mode === 'operations' && (
        <FlowJobToolkit
          initialTarget={isDemo() ? { id: DEMO_FLOW_ROOT, queueName: 'orders' } : undefined}
        />
      )}
      {explorer.mode === 'explore' && (
        <>
          <FlowSearch
            input={explorer.input}
            loading={explorer.loading}
            onInput={explorer.setInput}
            onSubmit={explorer.submit}
          />
          <div aria-live="polite">
            {explorer.error &&
              (isFlowConnectionFailure(explorer.error) ? (
                <OfflineBanner
                  message={`Could not load the flow — ${explorer.error.message}`}
                  onRetry={() => void explorer.load(explorer.rootParam)}
                />
              ) : (
                <ErrorState
                  error={explorer.error}
                  onRetry={() => void explorer.load(explorer.rootParam)}
                />
              ))}
            {explorer.loading && <LoadingState label="Loading flow…" />}
          </div>
          {!explorer.loading && !explorer.graph && !explorer.error && (
            <FlowEmptyState recent={explorer.recent} onOpen={explorer.openRecent} />
          )}
          {explorer.graph && (
            <FlowWorkspace
              graph={explorer.graph}
              selected={explorer.selected}
              onSelect={explorer.setSelected}
            />
          )}
        </>
      )}
    </div>
  );
}
