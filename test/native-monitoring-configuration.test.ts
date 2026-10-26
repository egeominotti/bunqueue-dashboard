import { describe, expect, test } from 'bun:test';
import {
  prometheusAlertRules,
  prometheusScrapeConfig,
} from '../src/features/monitoring/configuration';

interface ScrapeJob {
  job_name: string;
  scheme: string;
  metrics_path: string;
  static_configs: { targets: string[] }[];
  bearer_token_file?: string;
}
interface AlertRule {
  alert: string;
  expr: string;
  for: string;
  labels: { severity: string };
}
const scrape = (yaml: string) =>
  (Bun.YAML.parse(yaml) as { scrape_configs: ScrapeJob[] })?.scrape_configs?.[0];
const rules = (yaml: string) =>
  (Bun.YAML.parse(yaml) as { groups: { rules: AlertRule[] }[] })?.groups?.[0]?.rules;

describe('native monitoring configuration exports', () => {
  test('emits exact HTTPS scheme, IPv6 authority and proxy-prefixed metrics path', () => {
    expect(
      scrape(
        prometheusScrapeConfig({
          url: 'https://[2001:db8::1]:8443/tenant/api/prometheus',
        })
      )
    ).toEqual({
      job_name: 'bunqueue',
      scheme: 'https',
      metrics_path: '/tenant/api/prometheus',
      static_configs: [{ targets: ['[2001:db8::1]:8443'] }],
    });
  });

  test('emits HTTP and the actual requested path without assuming a default port', () => {
    expect(scrape(prometheusScrapeConfig({ url: 'http://queue.test:6790/prometheus' }))).toEqual({
      job_name: 'bunqueue',
      scheme: 'http',
      metrics_path: '/prometheus',
      static_configs: [{ targets: ['queue.test:6790'] }],
    });
  });

  test('exports decoded spaces and Unicode for Prometheus Go URL.Path construction', () => {
    for (const url of [
      'https://queue.test/team%20one/%E6%9D%B1%E4%BA%AC/prometheus',
      'https://queue.test/team one/東京/prometheus',
    ]) {
      expect(scrape(prometheusScrapeConfig({ url }))?.metrics_path).toBe(
        '/team one/東京/prometheus'
      );
    }
  });

  test('decodes exactly once while preserving literal percent and escaped query delimiters', () => {
    expect(
      scrape(prometheusScrapeConfig({ url: 'https://queue.test/team%2520one/%25/prometheus' }))
        ?.metrics_path
    ).toBe('/team%20one/%/prometheus');
    expect(
      scrape(prometheusScrapeConfig({ url: 'https://queue.test/team%3Fone/%23/prometheus' }))
        ?.metrics_path
    ).toBe('/team?one/#/prometheus');
  });

  test.each(['24', '26', '2B', '2C', '2F', '3A', '3B', '3D', '40'])(
    'rejects escaped reserved byte %s that Go serializes as a raw path character',
    (hex) => {
      for (const escaped of [hex.toUpperCase(), hex.toLowerCase()]) {
        const input = { url: `https://queue.test/team%${escaped}admin/prometheus` };
        expect(() => prometheusScrapeConfig(input)).toThrow();
        expect(() => prometheusAlertRules(input)).toThrow();
      }
    }
  );

  test('preserves reserved escapes that Go re-escapes without changing their path meaning', () => {
    const url = 'https://queue.test/team%21one/%27%28%29%2A/%3F%23%5B%5D/prometheus';
    expect(scrape(prometheusScrapeConfig({ url }))?.metrics_path).toBe(
      "/team!one/'()*/?#[]/prometheus"
    );
  });

  test('rejects encoded separators and malformed or control-character escapes in both exports', () => {
    for (const path of [
      'team%2fone',
      'team%2Fone',
      'team%5cone',
      'team%5Cone',
      'team%',
      'team%2',
      'team%GG',
      'team%C3%28',
      'team%00',
      'team%09',
      'team%0A',
      'team%7F',
      'team%C2%85',
    ]) {
      const input = { url: `https://queue.test/${path}/prometheus` };
      expect(() => prometheusScrapeConfig(input)).toThrow();
      expect(() => prometheusAlertRules(input)).toThrow();
    }
  });

  test('uses only a non-secret token-file placeholder when explicitly enabled', () => {
    const plain = scrape(prometheusScrapeConfig({ url: 'https://queue.test/prometheus' }));
    const authenticated = scrape(
      prometheusScrapeConfig({ url: 'https://queue.test/prometheus', bearerTokenFile: true })
    );
    expect(plain?.bearer_token_file).toBeUndefined();
    expect(authenticated?.bearer_token_file).toBe('/etc/prometheus/secrets/bunqueue-token');
    expect(authenticated).not.toHaveProperty('bearer_token');
  });

  test('quotes YAML and independently escapes the PromQL job selector', () => {
    const jobName = 'prod: "edge"\\west # {job="other"}';
    const input = { url: 'https://queue.test/prometheus', jobName };
    expect(scrape(prometheusScrapeConfig(input))?.job_name).toBe(jobName);
    expect(rules(prometheusAlertRules(input))?.[0]?.expr).toBe(
      'bunqueue_jobs_waiting{job="prod: \\"edge\\"\\\\west # {job=\\"other\\"}"} > 1000'
    );
    expect(rules(prometheusAlertRules(input))).toHaveLength(5);
  });

  test('uses installed native gauges and counter semantics for external example rules', () => {
    const generated = rules(prometheusAlertRules({ url: 'https://queue.test/prometheus' }));
    expect(generated?.map((rule) => rule.expr)).toEqual([
      'bunqueue_jobs_waiting{job="bunqueue"} > 1000',
      'bunqueue_jobs_dlq{job="bunqueue"} > 0',
      'increase(bunqueue_jobs_failed_total{job="bunqueue"}[5m]) > 0',
      'bunqueue_storage_degraded{job="bunqueue"} == 1',
      'bunqueue_storage_disk_full{job="bunqueue"} == 1',
    ]);
    expect(generated?.map((rule) => rule.for)).toEqual(['5m', '5m', '5m', '1m', '1m']);
    expect(generated?.[4]?.labels.severity).toBe('critical');
  });

  test('rejects unsafe URLs and newline injection in both exports', () => {
    const invalid = [
      '',
      '/api/prometheus',
      'ftp://queue.test/prometheus',
      'https://user:secret@queue.test/prometheus',
      'https://user@queue.test/prometheus',
      'https://queue.test/prometheus?token=secret',
      'https://queue.test/prometheus?',
      'https://queue.test/prometheus#secret',
      'https://queue.test/prometheus#',
      'https://queue.test/\nprometheus',
      'https://queue.test/\tprometheus',
      'https://queue.test/\rprometheus',
      'https://queue.test/\u0000prometheus',
    ];
    for (const url of invalid) {
      expect(() => prometheusScrapeConfig({ url })).toThrow();
      expect(() => prometheusAlertRules({ url })).toThrow();
    }
    for (const jobName of ['', 'a\n  bearer_token: injected', 'a\u007fb']) {
      expect(() => prometheusScrapeConfig({ url: 'https://queue.test', jobName })).toThrow();
      expect(() => prometheusAlertRules({ url: 'https://queue.test', jobName })).toThrow();
    }
  });
});
