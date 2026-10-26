import { useEffect, useMemo, useReducer, useState } from 'react';
import {
  captureConnectionProfileTarget,
  useConnectionStore,
} from '@/components/dashboard/stores/connectionStore';
import type { ConnectionProfileTarget } from '@/components/dashboard/stores/connectionStore';
import type { DiscoveryQuery, ScanReport } from './model';
import { queryFromSearch, queryToSearch } from './savedViews';
import { scanJobs } from './scanner';

export function useDiscovery(query: DiscoveryQuery) {
  const connection = useConnectionStore();
  const [result, setResult] = useState<{ owner: object; report: ScanReport } | null>(null);
  const [refresh, reload] = useReducer((value: number) => value + 1, 0);
  const key = queryToSearch(query);
  const { profiles, activeProfileId, baseUrl, token, agentBaseUrl, agentToken } = connection;
  const owner = useMemo(
    () => ({ key, profiles, activeProfileId, baseUrl, token, agentBaseUrl, agentToken, refresh }),
    [key, profiles, activeProfileId, baseUrl, token, agentBaseUrl, agentToken, refresh]
  );
  useEffect(() => {
    const controller = new AbortController();
    const sources = profiles
      .map((profile) => captureConnectionProfileTarget(profile.id))
      .filter((target): target is Readonly<ConnectionProfileTarget> => target !== null);
    void scanJobs(sources, queryFromSearch(key), controller.signal).then((result) => {
      if (!controller.signal.aborted) {
        setResult({ owner, report: result });
      }
    });
    return () => controller.abort();
  }, [key, profiles, owner]);
  const report = result?.owner === owner ? result.report : null;
  return { report, loading: report === null, reload };
}
