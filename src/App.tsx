import { lazy } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { AppLayout } from './components/layout/AppLayout';
import { OverviewPro } from './pages/control/OverviewPro';
// Eager: the layout shell, the landing route ('/'), and the trivial 404 — so the
// most common first paint has no lazy-chunk flash. Every other route is split
// into its own chunk (loaded on demand) to keep the initial bundle small.
import { NotFound } from './pages/NotFound';

// Route-level code splitting. Each page becomes its own chunk fetched only when
// its route is first visited; the named-export remap adapts to React.lazy's
// default-export contract. The <Suspense> boundary lives in AppLayout (around
// <Outlet/>) so the sidebar/topbar shell never blanks during a chunk load.
const AddJob = lazy(() => import('./pages/control/AddJob').then((m) => ({ default: m.AddJob })));
const Benchmark = lazy(() =>
  import('./pages/control/Benchmark').then((m) => ({ default: m.Benchmark }))
);
const BulkAddJobs = lazy(() =>
  import('./pages/control/BulkAddJobs').then((m) => ({ default: m.BulkAddJobs }))
);
const CronManager = lazy(() =>
  import('./pages/control/CronManager').then((m) => ({ default: m.CronManager }))
);
const Database = lazy(() =>
  import('./pages/control/Database').then((m) => ({ default: m.Database }))
);
const Diagnostics = lazy(() =>
  import('./pages/control/Diagnostics').then((m) => ({ default: m.Diagnostics }))
);
const DlqControl = lazy(() =>
  import('./pages/control/DlqControl').then((m) => ({ default: m.DlqControl }))
);
const DlqPro = lazy(() => import('./pages/control/DlqPro').then((m) => ({ default: m.DlqPro })));
const Flows = lazy(() => import('./pages/control/Flows').then((m) => ({ default: m.Flows })));
const JobInspector = lazy(() =>
  import('./pages/control/JobInspector').then((m) => ({ default: m.JobInspector }))
);
const JobsPro = lazy(() => import('./pages/control/JobsPro').then((m) => ({ default: m.JobsPro })));
const LogsPro = lazy(() => import('./pages/control/LogsPro').then((m) => ({ default: m.LogsPro })));
const McpServer = lazy(() =>
  import('./pages/control/McpServer').then((m) => ({ default: m.McpServer }))
);
const MetricsPro = lazy(() =>
  import('./pages/control/MetricsPro').then((m) => ({ default: m.MetricsPro }))
);
const QueueControl = lazy(() =>
  import('./pages/control/QueueControl').then((m) => ({ default: m.QueueControl }))
);
const QueueDetailPro = lazy(() =>
  import('./pages/control/QueueDetailPro').then((m) => ({ default: m.QueueDetailPro }))
);
const QueuesOverview = lazy(() =>
  import('./pages/control/QueuesOverview').then((m) => ({ default: m.QueuesOverview }))
);
const S3BackupPro = lazy(() =>
  import('./pages/control/S3BackupPro').then((m) => ({ default: m.S3BackupPro }))
);
const ServerControl = lazy(() =>
  import('./pages/control/ServerControl').then((m) => ({ default: m.ServerControl }))
);
const UsagePro = lazy(() =>
  import('./pages/control/UsagePro').then((m) => ({ default: m.UsagePro }))
);
const Webhooks = lazy(() =>
  import('./pages/control/Webhooks').then((m) => ({ default: m.Webhooks }))
);
const WorkersPro = lazy(() =>
  import('./pages/control/WorkersPro').then((m) => ({ default: m.WorkersPro }))
);
const Alerts = lazy(() => import('./pages/Alerts').then((m) => ({ default: m.Alerts })));
const Cron = lazy(() => import('./pages/Cron').then((m) => ({ default: m.Cron })));
const Dlq = lazy(() => import('./pages/Dlq').then((m) => ({ default: m.Dlq })));
const Jobs = lazy(() => import('./pages/Jobs').then((m) => ({ default: m.Jobs })));
const Logs = lazy(() => import('./pages/Logs').then((m) => ({ default: m.Logs })));
const Metrics = lazy(() => import('./pages/Metrics').then((m) => ({ default: m.Metrics })));
const Overview = lazy(() => import('./pages/Overview').then((m) => ({ default: m.Overview })));
const QueueDetail = lazy(() =>
  import('./pages/QueueDetail').then((m) => ({ default: m.QueueDetail }))
);
const Queues = lazy(() => import('./pages/Queues').then((m) => ({ default: m.Queues })));
const S3Backup = lazy(() => import('./pages/S3Backup').then((m) => ({ default: m.S3Backup })));
const Settings = lazy(() => import('./pages/Settings').then((m) => ({ default: m.Settings })));
const Usage = lazy(() => import('./pages/Usage').then((m) => ({ default: m.Usage })));
const Workers = lazy(() => import('./pages/Workers').then((m) => ({ default: m.Workers })));

export function App() {
  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route path="/" element={<OverviewPro />} />
        <Route path="/overview-classic" element={<Overview />} />
        <Route path="/queues" element={<QueuesOverview />} />
        <Route path="/queues-classic" element={<Queues />} />
        <Route path="/queues/:name" element={<QueueDetailPro />} />
        <Route path="/queues-classic/:name" element={<QueueDetail />} />
        <Route path="/jobs" element={<JobsPro />} />
        <Route path="/jobs-classic" element={<Jobs />} />
        <Route path="/dlq" element={<DlqPro />} />
        <Route path="/dlq-classic" element={<Dlq />} />
        <Route path="/cron" element={<CronManager />} />
        <Route path="/cron-classic" element={<Cron />} />
        <Route path="/flows" element={<Flows />} />
        <Route path="/metrics" element={<MetricsPro />} />
        <Route path="/metrics-classic" element={<Metrics />} />
        <Route path="/workers" element={<WorkersPro />} />
        <Route path="/workers-classic" element={<Workers />} />
        <Route path="/logs" element={<LogsPro />} />
        <Route path="/logs-classic" element={<Logs />} />
        <Route path="/server" element={<ServerControl />} />
        <Route path="/add-job" element={<AddJob />} />
        <Route path="/jobs/bulk-add" element={<BulkAddJobs />} />
        <Route path="/job" element={<JobInspector />} />
        <Route path="/queue-control" element={<QueueControl />} />
        {/* Legacy alias: CronManager graduated to /cron; redirect keeps old bookmarks alive. */}
        <Route path="/cron-manager" element={<Navigate to="/cron" replace />} />
        <Route path="/dlq-control" element={<DlqControl />} />
        <Route path="/webhooks" element={<Webhooks />} />
        <Route path="/diagnostics" element={<Diagnostics />} />
        <Route path="/alerts" element={<Alerts />} />
        <Route path="/benchmark" element={<Benchmark />} />
        <Route path="/database" element={<Database />} />
        <Route path="/mcp" element={<McpServer />} />
        <Route path="/usage" element={<UsagePro />} />
        <Route path="/usage-classic" element={<Usage />} />
        <Route path="/s3" element={<S3BackupPro />} />
        <Route path="/s3-classic" element={<S3Backup />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
