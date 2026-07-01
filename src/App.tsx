import { Route, Routes } from 'react-router-dom';
import { AppLayout } from './components/layout/AppLayout';
import { Cron } from './pages/Cron';
import { AddJob } from './pages/control/AddJob';
import { CronManager } from './pages/control/CronManager';
import { Diagnostics } from './pages/control/Diagnostics';
import { DlqControl } from './pages/control/DlqControl';
import { DlqPro } from './pages/control/DlqPro';
import { JobInspector } from './pages/control/JobInspector';
import { JobsPro } from './pages/control/JobsPro';
import { LogsPro } from './pages/control/LogsPro';
import { MetricsPro } from './pages/control/MetricsPro';
import { OverviewPro } from './pages/control/OverviewPro';
import { QueueControl } from './pages/control/QueueControl';
import { QueuesOverview } from './pages/control/QueuesOverview';
import { S3BackupPro } from './pages/control/S3BackupPro';
import { ServerControl } from './pages/control/ServerControl';
import { Webhooks } from './pages/control/Webhooks';
import { Dlq } from './pages/Dlq';
import { Jobs } from './pages/Jobs';
import { Logs } from './pages/Logs';
import { Metrics } from './pages/Metrics';
import { NotFound } from './pages/NotFound';
import { Overview } from './pages/Overview';
import { QueueDetail } from './pages/QueueDetail';
import { Queues } from './pages/Queues';
import { S3Backup } from './pages/S3Backup';
import { Settings } from './pages/Settings';
import { Usage } from './pages/Usage';
import { Workers } from './pages/Workers';

export function App() {
  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route path="/" element={<OverviewPro />} />
        <Route path="/overview-classic" element={<Overview />} />
        <Route path="/queues" element={<QueuesOverview />} />
        <Route path="/queues-classic" element={<Queues />} />
        <Route path="/queues/:name" element={<QueueDetail />} />
        <Route path="/jobs" element={<JobsPro />} />
        <Route path="/jobs-classic" element={<Jobs />} />
        <Route path="/dlq" element={<DlqPro />} />
        <Route path="/dlq-classic" element={<Dlq />} />
        <Route path="/cron" element={<Cron />} />
        <Route path="/metrics" element={<MetricsPro />} />
        <Route path="/metrics-classic" element={<Metrics />} />
        <Route path="/workers" element={<Workers />} />
        <Route path="/logs" element={<LogsPro />} />
        <Route path="/logs-classic" element={<Logs />} />
        <Route path="/server" element={<ServerControl />} />
        <Route path="/add-job" element={<AddJob />} />
        <Route path="/job" element={<JobInspector />} />
        <Route path="/queue-control" element={<QueueControl />} />
        <Route path="/cron-manager" element={<CronManager />} />
        <Route path="/dlq-control" element={<DlqControl />} />
        <Route path="/webhooks" element={<Webhooks />} />
        <Route path="/diagnostics" element={<Diagnostics />} />
        <Route path="/usage" element={<Usage />} />
        <Route path="/s3" element={<S3BackupPro />} />
        <Route path="/s3-classic" element={<S3Backup />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
