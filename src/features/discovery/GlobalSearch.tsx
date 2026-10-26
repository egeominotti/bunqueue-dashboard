import { useSearchParams } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { LoadingState } from '@/components/ui/feedback';
import { PageHeader } from '@/components/ui/PageHeader';
import { DiscoveryFilters } from './DiscoveryFilters';
import { DiscoveryResults } from './DiscoveryResults';
import { SavedViews } from './SavedViewControls';
import { queryFromSearch, queryToSearch } from './savedViews';
import { useDiscovery } from './useDiscovery';

export function GlobalSearch() {
  const [params, setParams] = useSearchParams();
  const query = queryFromSearch(params.toString());
  const { report, loading, reload } = useDiscovery(query);
  const change = (next: typeof query) => setParams(queryToSearch(next));
  return (
    <div className="space-y-4">
      <PageHeader
        title="Global search"
        description="Discover jobs across configured Bunqueue profiles. Scans are bounded live reads."
        actions={<Button onClick={reload}>Scan again</Button>}
      />
      <DiscoveryFilters query={query} onChange={change} />
      <SavedViews query={query} onLoad={change} />
      {loading && <LoadingState label="Scanning configured profiles…" />}
      {report && <DiscoveryResults report={report} />}
    </div>
  );
}
