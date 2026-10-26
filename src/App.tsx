import { Navigate, Route, Routes } from 'react-router-dom';
import { AppLayout } from './components/layout/AppLayout';
import { retryableLazy } from './lib/retryableLazy';
import { OverviewPro } from './pages/control/OverviewPro';
// Eager: the layout shell, the landing route ('/'), and the trivial 404 — so the
// most common first paint has no lazy-chunk flash. Every other route is split
// into its own chunk (loaded on demand) to keep the initial bundle small.
import { NotFound } from './pages/NotFound';

// Route-level code splitting. Each page becomes its own chunk fetched only when
// its route is first visited; the named-export remap adapts to React.lazy's
// default-export contract. The <Suspense> boundary lives in AppLayout (around
// <Outlet/>) so the sidebar/topbar shell never blanks during a chunk load.
const AddJob = retryableLazy(() =>
  import('./pages/control/AddJob').then((m) => ({ default: m.AddJob }))
);
const Benchmark = retryableLazy(() =>
  import('./pages/control/Benchmark').then((m) => ({ default: m.Benchmark }))
);
const BulkAddJobs = retryableLazy(() =>
  import('./pages/control/BulkAddJobs').then((m) => ({ default: m.BulkAddJobs }))
);
const CronManager = retryableLazy(() =>
  import('./pages/control/CronManager').then((m) => ({ default: m.CronManager }))
);
const Database = retryableLazy(() =>
  import('./pages/control/Database').then((m) => ({ default: m.Database }))
);
const Diagnostics = retryableLazy(() =>
  import('./pages/control/Diagnostics').then((m) => ({ default: m.Diagnostics }))
);
const DlqControl = retryableLazy(() =>
  import('./pages/control/DlqControl').then((m) => ({ default: m.DlqControl }))
);
const DlqPro = retryableLazy(() =>
  import('./pages/control/DlqPro').then((m) => ({ default: m.DlqPro }))
);
const Flows = retryableLazy(() =>
  import('./pages/control/Flows').then((m) => ({ default: m.Flows }))
);
const JobInspector = retryableLazy(() =>
  import('./pages/control/JobInspector').then((m) => ({ default: m.JobInspector }))
);
const JobsPro = retryableLazy(() =>
  import('./pages/control/JobsPro').then((m) => ({ default: m.JobsPro }))
);
const LogsPro = retryableLazy(() =>
  import('./pages/control/LogsPro').then((m) => ({ default: m.LogsPro }))
);
const McpServer = retryableLazy(() =>
  import('./pages/control/McpServer').then((m) => ({ default: m.McpServer }))
);
const MetricsPro = retryableLazy(() =>
  import('./pages/control/MetricsPro').then((m) => ({ default: m.MetricsPro }))
);
const QueueControl = retryableLazy(() =>
  import('./pages/control/QueueControl').then((m) => ({ default: m.QueueControl }))
);
const QueueDetailPro = retryableLazy(() =>
  import('./pages/control/QueueDetailPro').then((m) => ({ default: m.QueueDetailPro }))
);
const QueuesOverview = retryableLazy(() =>
  import('./pages/control/QueuesOverview').then((m) => ({ default: m.QueuesOverview }))
);
const S3BackupPro = retryableLazy(() =>
  import('./pages/control/S3BackupPro').then((m) => ({ default: m.S3BackupPro }))
);
const ServerControl = retryableLazy(() =>
  import('./pages/control/ServerControl').then((m) => ({ default: m.ServerControl }))
);
const UsagePro = retryableLazy(() =>
  import('./pages/control/UsagePro').then((m) => ({ default: m.UsagePro }))
);
const Webhooks = retryableLazy(() =>
  import('./pages/control/Webhooks').then((m) => ({ default: m.Webhooks }))
);
const WorkersPro = retryableLazy(() =>
  import('./pages/control/WorkersPro').then((m) => ({ default: m.WorkersPro }))
);
const Workflows = retryableLazy(() =>
  import('./pages/control/Workflows').then((m) => ({ default: m.Workflows }))
);
const Alerts = retryableLazy(() => import('./pages/Alerts').then((m) => ({ default: m.Alerts })));
const Fleet = retryableLazy(() => import('./pages/Fleet').then((m) => ({ default: m.Fleet })));
const GlobalSearch = retryableLazy(() =>
  import('./features/discovery/GlobalSearch').then((m) => ({ default: m.GlobalSearch }))
);
const FailureDiagnostics = retryableLazy(() =>
  import('./features/discovery/FailureDiagnostics').then((m) => ({ default: m.FailureDiagnostics }))
);
const MetricHistory = retryableLazy(() =>
  import('./features/metric-history/MetricHistory').then((m) => ({ default: m.MetricHistory }))
);
const MonitoringSetup = retryableLazy(() =>
  import('./features/monitoring/MonitoringSetup').then((m) => ({ default: m.MonitoringSetup }))
);
const Cron = retryableLazy(() => import('./pages/Cron').then((m) => ({ default: m.Cron })));
const Dlq = retryableLazy(() => import('./pages/Dlq').then((m) => ({ default: m.Dlq })));
const Jobs = retryableLazy(() => import('./pages/Jobs').then((m) => ({ default: m.Jobs })));
const Logs = retryableLazy(() => import('./pages/Logs').then((m) => ({ default: m.Logs })));
const Metrics = retryableLazy(() =>
  import('./pages/Metrics').then((m) => ({ default: m.Metrics }))
);
const Overview = retryableLazy(() =>
  import('./pages/Overview').then((m) => ({ default: m.Overview }))
);
const QueueDetail = retryableLazy(() =>
  import('./pages/QueueDetail').then((m) => ({ default: m.QueueDetail }))
);
const Queues = retryableLazy(() => import('./pages/Queues').then((m) => ({ default: m.Queues })));
const S3Backup = retryableLazy(() =>
  import('./pages/S3Backup').then((m) => ({ default: m.S3Backup }))
);
const Settings = retryableLazy(() =>
  import('./pages/Settings').then((m) => ({ default: m.Settings }))
);
const Usage = retryableLazy(() => import('./pages/Usage').then((m) => ({ default: m.Usage })));
const Workers = retryableLazy(() =>
  import('./pages/Workers').then((m) => ({ default: m.Workers }))
);

export function App() {
  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route path="/" element={<OverviewPro />} />
        <Route path="/fleet" element={<Fleet />} />
        <Route path="/overview-classic" element={<Overview />} />
        <Route path="/queues" element={<QueuesOverview />} />
        <Route path="/queues-classic" element={<Queues />} />
        <Route path="/queues/:name" element={<QueueDetailPro />} />
        <Route path="/queues-classic/:name" element={<QueueDetail />} />
        <Route path="/jobs" element={<JobsPro />} />
        <Route path="/search" element={<GlobalSearch />} />
        <Route path="/failures" element={<FailureDiagnostics />} />
        <Route path="/jobs-classic" element={<Jobs />} />
        <Route path="/dlq" element={<DlqPro />} />
        <Route path="/dlq-classic" element={<Dlq />} />
        <Route path="/cron" element={<CronManager />} />
        <Route path="/cron-classic" element={<Cron />} />
        <Route path="/flows" element={<Flows />} />
        <Route path="/workflows" element={<Workflows />} />
        <Route path="/workflows/executions" element={<Workflows />} />
        <Route path="/workflows/waiting" element={<Workflows />} />
        <Route path="/workflows/compensation" element={<Workflows />} />
        <Route path="/workflows/archive" element={<Workflows />} />
        <Route path="/metrics" element={<MetricsPro />} />
        <Route path="/metrics/history" element={<MetricHistory />} />
        <Route path="/monitoring" element={<MonitoringSetup />} />
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
