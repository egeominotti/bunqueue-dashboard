import { useEffect, useRef, useState } from 'react';
import { useConnectionStore } from '@/components/dashboard/stores/connectionStore';
import { toast } from '@/components/dashboard/stores/toastStore';
import { bq, DB_EXPORT_MAX_BYTES, type DbFilter, type DbRowsPage } from '@/lib/bq';
import { formatBytes, formatNumber } from '@/lib/format';
import {
  collectTableExport,
  type DbExportSnapshot,
  dbConnectionIdentity,
  download,
  toCsv,
} from './dbUtils';
import type { Sort } from './types';

interface DatabaseExportOptions {
  data: DbRowsPage | null;
  filter: DbFilter | null;
  page: number;
  selected: string;
  sort: Sort;
}

export function useDatabaseExport({ data, filter, page, selected, sort }: DatabaseExportOptions) {
  const exportConnectionIdentity = useConnectionStore(dbConnectionIdentity);
  const [exportBusy, setExportBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const exportLockRef = useRef(false);
  const exportAbortRef = useRef<AbortController | null>(null);
  // A credential/backend switch invalidates the operation immediately. The
  // collector is target-pinned as a second line of defense, but downloading A's
  // result after the operator has switched to B would still leak stale context.
  useEffect(() => {
    void exportConnectionIdentity;
    exportAbortRef.current?.abort();
    exportAbortRef.current = null;
    exportLockRef.current = false;
    setExportBusy(false);
    setMsg(null);
    return () => {
      exportAbortRef.current?.abort();
      exportAbortRef.current = null;
      exportLockRef.current = false;
    };
  }, [exportConnectionIdentity]);

  const exportPage = () => {
    if (!data) return;
    download(`${data.table}-page${page + 1}.csv`, 'text/csv', toCsv(data.columns, data.rows));
  };

  // Full-table export: one agent-side SQLite snapshot produces one bounded CSV.
  const exportTable = async () => {
    if (!selected || exportLockRef.current) return;
    exportLockRef.current = true;
    const operationIdentity = dbConnectionIdentity(useConnectionStore.getState());
    const snapshot: DbExportSnapshot = {
      table: selected,
      orderBy: sort?.col,
      dir: sort?.dir ?? 'asc',
      filter: filter ? { ...filter } : undefined,
    };
    const target = bq.captureAgentRequestTarget();
    const controller = new AbortController();
    exportAbortRef.current = controller;
    setExportBusy(true);
    setMsg(null);
    try {
      const exported = await collectTableExport(snapshot, target, controller.signal);
      if (
        controller.signal.aborted ||
        dbConnectionIdentity(useConnectionStore.getState()) !== operationIdentity
      ) {
        return;
      }
      download(`${snapshot.table}.csv`, 'text/csv;charset=utf-8', exported.content);
      const done =
        exported.cap === 'rows'
          ? `Exported the first ${formatNumber(exported.rowCount)} rows (row cap reached)`
          : exported.cap === 'bytes'
            ? `Exported ${formatNumber(exported.rowCount)} rows (${formatBytes(DB_EXPORT_MAX_BYTES)} byte cap reached)`
            : `Exported ${formatNumber(exported.rowCount)} rows`;
      setMsg(done);
      toast.success(`Export of ${snapshot.table} complete`, done);
    } catch (e) {
      if (
        controller.signal.aborted ||
        dbConnectionIdentity(useConnectionStore.getState()) !== operationIdentity
      ) {
        return;
      }
      setMsg(`Export failed: ${(e as Error).message}`);
      toast.error(`Export of ${snapshot.table} failed`, (e as Error).message);
    } finally {
      if (exportAbortRef.current === controller) {
        exportAbortRef.current = null;
        exportLockRef.current = false;
        if (!controller.signal.aborted) setExportBusy(false);
      }
    }
  };

  return { exportBusy, exportPage, exportTable, msg };
}
