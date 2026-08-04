import type { WorkflowExecutionsPage, WorkflowStats, WorkflowStoreKind } from '@/lib/bqTypes';
import type { WorkflowControlRepository } from '../application/WorkflowControlRepository';
import type { WorkflowRepository } from '../application/WorkflowRepository';
import type { WorkflowSection, WorkflowSelection } from '../domain/workflowSections';
import { ArchiveDetail } from './ArchiveDetail';
import { CompensationDetail } from './CompensationDetail';
import { ExecutionDetail } from './ExecutionDetail';
import { ExecutionList } from './ExecutionList';
import { OperationalExecutionList } from './OperationalExecutionList';
import { OverviewWorkspace } from './OverviewWorkspace';
import { WaitingDetail } from './WaitingDetail';

export interface WorkspaceProps {
  section: WorkflowSection;
  repository: WorkflowRepository;
  controlRepository: WorkflowControlRepository;
  kind: WorkflowStoreKind;
  stats: WorkflowStats;
  page: WorkflowExecutionsPage;
  selected: WorkflowSelection | null;
  offset: number;
  pageSize: number;
  onSelect: (selection: WorkflowSelection) => void;
  onPage: (offset: number) => void;
  onRefresh: () => Promise<void>;
}

export function WorkflowWorkspace(props: WorkspaceProps) {
  if (props.section.id === 'overview') return <OverviewWorkspace {...props} />;
  if (props.section.id === 'executions') return <ExecutionExplorer {...props} />;
  return <OperationalWorkspace {...props} />;
}

function ExecutionExplorer({
  repository,
  kind,
  page,
  selected,
  offset,
  pageSize,
  onSelect,
  onPage,
}: WorkspaceProps) {
  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(390px,0.8fr)_minmax(0,1.4fr)]">
      <ExecutionList
        executions={page.executions}
        total={page.total}
        offset={offset}
        pageSize={pageSize}
        selected={selected}
        onSelect={onSelect}
        onPage={onPage}
      />
      {selected && (
        <ExecutionDetail
          repository={repository}
          id={selected.id}
          kind={kind}
          onSelect={(id) => onSelect({ id, source: 'link' })}
        />
      )}
    </div>
  );
}

function OperationalWorkspace(props: WorkspaceProps) {
  const mode = props.section.id as 'waiting' | 'compensation' | 'archive';
  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(420px,0.95fr)_minmax(0,1.05fr)]">
      <OperationalExecutionList
        mode={mode}
        rows={props.page.executions}
        selected={props.selected}
        onSelect={props.onSelect}
        total={props.page.total}
        offset={props.offset}
        pageSize={props.pageSize}
        onPage={props.onPage}
      />
      {props.selected && <OperationalDetail {...props} id={props.selected.id} />}
    </div>
  );
}

function OperationalDetail({
  section,
  repository,
  controlRepository,
  onRefresh,
  id,
}: WorkspaceProps & { id: string }) {
  if (section.id === 'waiting')
    return (
      <WaitingDetail
        repository={repository}
        controlRepository={controlRepository}
        id={id}
        onApplied={onRefresh}
      />
    );
  if (section.id === 'compensation')
    return (
      <CompensationDetail
        repository={repository}
        controlRepository={controlRepository}
        id={id}
        onApplied={onRefresh}
      />
    );
  return <ArchiveDetail repository={repository} id={id} />;
}
