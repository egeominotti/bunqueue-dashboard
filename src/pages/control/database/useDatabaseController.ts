import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useGlobalModalStore } from '@/components/dashboard/stores/globalModalStore';
import { BqError, bq, type DbFilter } from '@/lib/bq';
import { usePolledData } from '@/lib/usePolledData';
import {
  type DbDetailSelection,
  type DbRowsIdentity,
  dbDetailMatchesPage,
  dbRowsMatchIdentity,
  parseDbRowsResponse,
} from './rowModel';
import type { ColMeta, Sort, Tab } from './types';
import { useDatabaseExport } from './useDatabaseExport';

const PAGE_SIZE = 50;

export function useDatabaseController() {
  const [table, setTable] = useState('');
  const [page, setPage] = useState(0);
  const [sort, setSort] = useState<Sort>(null);
  const [tab, setTab] = useState<Tab>('data');
  const [filter, setFilter] = useState<DbFilter | null>(null);
  const [detailSelection, setDetailSelection] = useState<DbDetailSelection | null>(null);
  const activeModal = useGlobalModalStore((state) => state.active);
  const requestModal = useGlobalModalStore((state) => state.request);
  const releaseModal = useGlobalModalStore((state) => state.release);
  const [sql, setSql] = useState("SELECT name FROM sqlite_master WHERE type = 'table'");
  const editorRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (detailSelection === null) {
      releaseModal('database-row');
    } else if (activeModal !== 'database-row') {
      // A higher-priority modal replaced the drawer. Forget the row so closing
      // that modal cannot resurrect a stale detail panel.
      setDetailSelection(null);
    }
  }, [detailSelection, activeModal, releaseModal]);

  useEffect(
    () => () => {
      useGlobalModalStore.getState().release('database-row');
    },
    []
  );

  const {
    data: tablesRes,
    error: tablesError,
    loading: tablesLoading,
    refetch: refetchTables,
  } = usePolledData(() => bq.db.tables(), [], { intervalMs: 10000 });
  const tables = useMemo(() => tablesRes?.tables ?? [], [tablesRes]);

  // Missing file (404) is the expected pre-first-start state; any other error
  // is a real read failure and must not be shown as "no database yet".
  const dbMissing = tablesError instanceof BqError && tablesError.status === 404;

  // Store metadata — stop polling (and stop erroring) once the db is known missing.
  const {
    data: info,
    error: infoError,
    refetch: refetchInfo,
  } = usePolledData(() => (dbMissing ? Promise.resolve(null) : bq.db.info()), [dbMissing], {
    intervalMs: 15000,
  });

  // Auto-select the first table via a fallback (no first-load flash) AND commit
  // it once so the browsed view doesn't jump if the list later reorders.
  const selected = table || tables[0]?.name || '';
  useEffect(() => {
    if (!table && tables[0]) setTable(tables[0].name);
  }, [table, tables]);

  // Schema is needed for the Schema tab AND for the data-grid header badges, so
  // fetch it whenever a table is selected.
  const {
    data: schema,
    error: schemaError,
    refetch: refetchSchema,
  } = usePolledData(() => (selected ? bq.db.schema(selected) : Promise.resolve(null)), [selected], {
    intervalMs: 30000,
  });
  const colMeta: ColMeta = useMemo(() => {
    const m: ColMeta = {};
    if (schema?.table === selected) {
      for (const c of schema.columns) m[c.name] = { type: c.type, primaryKey: c.primaryKey };
    }
    return m;
  }, [schema, selected]);

  // Rows, tagged with the full view identity so a stale round-trip never renders
  // under a new table/page/sort/filter.
  const filterKey = filter ? JSON.stringify([filter.column, filter.op, filter.value]) : '';
  const fetcher = useCallback(async () => {
    if (!selected) return null;
    const expected: DbRowsIdentity = {
      table: selected,
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
      orderBy: sort?.col,
      dir: sort?.dir ?? 'asc',
      filter: filter ?? undefined,
    };
    const response: unknown = await bq.db.rows(
      selected,
      PAGE_SIZE,
      expected.offset,
      sort?.col,
      sort?.dir,
      filter ?? undefined
    );
    return parseDbRowsResponse(response, expected);
  }, [selected, page, sort, filter]);
  const {
    data: validatedRows,
    error: rowsError,
    loading: rowsLoading,
    refetch: refetchRows,
  } = usePolledData(fetcher, [selected, page, sort, filterKey], { intervalMs: 6000 });
  const currentRowsIdentity: DbRowsIdentity = {
    table: selected,
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
    orderBy: sort?.col,
    dir: sort?.dir ?? 'asc',
    filter: filter ?? undefined,
  };
  const viewMatches = !!validatedRows && dbRowsMatchIdentity(validatedRows, currentRowsIdentity);
  const identityError =
    validatedRows && !viewMatches
      ? new Error('Database rows identity no longer matches the selected table and page.')
      : null;
  const visibleRowsError = rowsError ?? identityError;
  const data = !visibleRowsError && viewMatches ? validatedRows : null;
  const detailMatches =
    detailSelection !== null && data !== null && dbDetailMatchesPage(detailSelection, data);
  // Render fail-closed in the SAME render that publishes a changed page; the
  // cleanup effect below then releases the modal reservation.
  const detail = detailMatches ? detailSelection : null;

  useEffect(() => {
    if (detailSelection && !detailMatches) setDetailSelection(null);
  }, [detailSelection, detailMatches]);

  // Out-of-range page (rows deleted under us / stale deep link): snap to the
  // last valid page instead of showing a false "empty".
  useEffect(() => {
    if (data && data.total > 0 && data.rows.length === 0 && page > 0) {
      setPage(Math.max(0, Math.ceil(data.total / PAGE_SIZE) - 1));
    }
  }, [data, page]);

  const resetView = () => {
    setPage(0);
    setSort(null);
    setFilter(null);
    setDetailSelection(null);
  };
  const selectTable = (name: string) => {
    setTable(name);
    setTab('data');
    resetView();
  };
  const cycleSort = (col: string) => {
    setPage(0);
    setDetailSelection(null);
    setSort((s) =>
      s?.col !== col ? { col, dir: 'asc' } : s.dir === 'asc' ? { col, dir: 'desc' } : null
    );
  };

  const queryThisTable = () => {
    const q = `SELECT * FROM "${selected.replaceAll('"', '""')}" LIMIT 100`;
    setSql(q);
    // Focus + scroll the editor into view on the next paint.
    requestAnimationFrame(() => {
      editorRef.current?.focus();
      editorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  };

  const anyTruncated = !!data?.truncatedCells.some((row) => row.some(Boolean));

  const { exportBusy, exportPage, exportTable, msg } = useDatabaseExport({
    data,
    filter,
    page,
    selected,
    sort,
  });

  return {
    activeModal,
    anyTruncated,
    colMeta,
    cycleSort,
    data,
    dbMissing,
    detail,
    editorRef,
    exportBusy,
    exportPage,
    exportTable,
    filter,
    info,
    infoError,
    msg,
    page,
    pageSize: PAGE_SIZE,
    queryThisTable,
    refetchInfo,
    refetchRows,
    refetchSchema,
    refetchTables,
    requestModal,
    rowsLoading,
    schema,
    schemaError,
    selectTable,
    selected,
    setDetailSelection,
    setFilter,
    setPage,
    setSql,
    setTab,
    sort,
    sql,
    tab,
    tables,
    tablesError,
    tablesLoading,
    visibleRowsError,
  };
}

export type DatabaseController = ReturnType<typeof useDatabaseController>;
