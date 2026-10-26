import { useState } from 'react';
import { Link } from 'react-router-dom';
import { getBaseUrl, useConnectionStore } from '@/components/dashboard/stores/connectionStore';
import { Button } from '@/components/ui/Button';
import { CopyButton } from '@/components/ui/CopyButton';
import { Field, Input } from '@/components/ui/form';
import { PageHeader } from '@/components/ui/PageHeader';
import { downloadFile } from '@/lib/exportFile';
import { prometheusAlertRules, prometheusScrapeConfig } from './configuration';

export function MonitoringSetup() {
  const baseUrl = useConnectionStore((state) => state.baseUrl);
  let endpoint = '';
  try {
    const base = new URL(`${getBaseUrl().replace(/\/+$/, '')}/`, window.location.origin);
    endpoint = new URL('prometheus', base).href;
    prometheusScrapeConfig({ url: endpoint });
  } catch {
    endpoint = '';
  }
  return (
    <div className="space-y-6">
      <PageHeader
        title="Monitoring setup"
        description="Connect native Bunqueue telemetry to your monitoring infrastructure."
      />
      <section className="space-y-3 rounded-xl border border-line bg-surface p-4 text-sm text-muted">
        <h2 className="font-semibold text-fg">Native server integrations</h2>
        <p>
          <Link className="text-accent underline" to="/webhooks">
            Native job events → Webhooks
          </Link>{' '}
          configure Bunqueue server event delivery, independent of the dashboard tab. These are job
          events, not metric threshold rules.
        </p>
        <p>
          <Link className="text-accent underline" to="/alerts">
            Browser rules → Alerts
          </Link>{' '}
          evaluate only while this dashboard has an open tab; they are browser-local rules.
        </p>
        <p>
          Native Prometheus endpoint:{' '}
          {endpoint ? (
            <a className="break-all text-accent underline" href={endpoint} data-native-prometheus>
              {endpoint}
            </a>
          ) : (
            'Unavailable; check the configured server URL.'
          )}{' '}
          This link does not attach dashboard credentials.
        </p>
      </section>
      <ExportEditor key={baseUrl} endpoint={endpoint} />
    </div>
  );
}

function ExportEditor({ endpoint }: { endpoint: string }) {
  const [url, setUrl] = useState(endpoint);
  const [jobName, setJobName] = useState('bunqueue');
  const [bearerTokenFile, setBearerTokenFile] = useState(false);
  let scrape = '';
  let alerts = '';
  let error = '';
  try {
    const input = { url, jobName, bearerTokenFile };
    scrape = prometheusScrapeConfig(input);
    alerts = prometheusAlertRules(input);
  } catch (cause) {
    error = cause instanceof Error ? cause.message : 'Invalid monitoring configuration.';
  }
  return (
    <section className="space-y-4 rounded-xl border border-line bg-surface p-4 text-sm text-muted">
      <h2 className="font-semibold text-fg">External metric alerting</h2>
      <p>
        Threshold evaluation and notification delivery require external Prometheus + Alertmanager.
        The dashboard exports configuration; it does not run a monitoring service.
      </p>
      <Field
        label="Prometheus scrape URL"
        hint="Use an HTTP(S) URL reachable from the Prometheus server. The browser proxy or localhost may not be reachable externally; edit this URL for your deployment."
      >
        <Input name="scrape-url" value={url} onChange={(event) => setUrl(event.target.value)} />
      </Field>
      <Field label="Scrape job name" hint="Prometheus adds this job label to the scraped metrics.">
        <Input
          name="scrape-job-name"
          value={jobName}
          onChange={(event) => setJobName(event.target.value)}
        />
      </Field>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={bearerTokenFile}
          onChange={(event) => setBearerTokenFile(event.target.checked)}
        />
        Use bearer token file
      </label>
      <p>
        Native METRICS_AUTH requires a valid AUTH_TOKENS token. If enabled, replace the exported
        bearer_token_file placeholder with a file on the Prometheus host containing that token.
        Server and agent tokens are never included in exports. Configure proxy authentication and
        access roles outside the dashboard; Bunqueue uses bearer tokens, not dashboard roles.
      </p>
      {error ? (
        <p role="alert" className="text-danger">
          {error}
        </p>
      ) : (
        <>
          <Export
            title="Prometheus scrape configuration"
            filename="bunqueue-prometheus.yml"
            action="Download scrape config"
            content={scrape}
          />
          <p>
            Merge scrape_configs into Prometheus configuration. Save the rules file and load it
            through Prometheus rule_files; configure Alertmanager routing and receivers separately.
            These server-wide examples need thresholds and durations tuned to your workload.
            Waiting, DLQ and storage metrics are gauges; recent failures use a counter increase.
          </p>
          <Export
            title="Example alert rules"
            filename="bunqueue-alerts.yml"
            action="Download alert rules"
            content={alerts}
          />
        </>
      )}
    </section>
  );
}

function Export({
  title,
  filename,
  action,
  content,
}: {
  title: string;
  filename: string;
  action: string;
  content: string;
}) {
  return (
    <section aria-label={title} className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-medium text-fg">{title}</h3>
        <div className="flex items-center gap-2">
          <CopyButton value={content} />
          <Button
            size="sm"
            onClick={() => downloadFile(filename, content, 'application/yaml;charset=utf-8')}
          >
            {action}
          </Button>
        </div>
      </div>
      <pre className="overflow-x-auto rounded-lg bg-surface-2 p-3 text-xs text-fg">
        <code>{content}</code>
      </pre>
    </section>
  );
}
