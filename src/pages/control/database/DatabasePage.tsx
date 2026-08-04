import { createPortal } from 'react-dom';
import { DatabaseShell } from './DatabaseShell';
import { RowDetailDrawer } from './RowDetailDrawer';
import { useDatabaseController } from './useDatabaseController';

/**
 * Enterprise SQLite inspector. Browsing, schema, filtering and queries run on
 * the control agent over a `readonly` connection — writes are rejected by the
 * engine itself (and by a statement allowlist), so nothing here can mutate the
 * store. Arbitrary queries are time-boxed off-thread so a runaway scan can't
 * freeze the agent.
 */
export function Database() {
  const db = useDatabaseController();
  const { activeModal, detail, setDetailSelection } = db;

  return (
    <div>
      <DatabaseShell db={db} />
      {detail &&
        activeModal === 'database-row' &&
        createPortal(
          <RowDetailDrawer
            table={detail.table}
            columns={detail.columns}
            row={detail.row}
            rowid={detail.rowid}
            truncated={detail.truncated}
            onClose={() => setDetailSelection(null)}
          />,
          document.body
        )}
    </div>
  );
}
