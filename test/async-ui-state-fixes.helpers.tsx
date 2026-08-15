import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { useAlertsStore } from '../src/components/dashboard/stores/alertsStore';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import { ConnectionBadge } from '../src/components/layout/ConnectionBadge';
import { useActivityStream } from '../src/lib/useActivityStream';
import { alertConnectionIdentity, useAlertRuntimeStore } from '../src/lib/useAlertEngine';
import { Alerts } from '../src/pages/Alerts';
import { DlqControl } from '../src/pages/control/DlqControl';
import { JobsPro } from '../src/pages/control/JobsPro';
import { ProcessLogs } from '../src/pages/control/server/ProcessLogs';
import { UsagePro } from '../src/pages/control/UsagePro';
import { Cron } from '../src/pages/Cron';
import { Dlq } from '../src/pages/Dlq';
import { Overview } from '../src/pages/Overview';
import { S3Backup } from '../src/pages/S3Backup';
import { ensureDom, renderHook, settle } from './domSetup';

const realFetch = globalThis.fetch;

function render(element: ReactElement) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(element));
  return {
    host,
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

export type { ReactElement };
export {
  Alerts,
  act,
  afterEach,
  alertConnectionIdentity,
  beforeEach,
  ConnectionBadge,
  Cron,
  createElement,
  createRoot,
  Dlq,
  DlqControl,
  describe,
  ensureDom,
  expect,
  JobsPro,
  MemoryRouter,
  Overview,
  ProcessLogs,
  realFetch,
  render,
  renderHook,
  S3Backup,
  settle,
  test,
  UsagePro,
  useActivityStream,
  useAlertRuntimeStore,
  useAlertsStore,
  useConnectionStore,
};

export function installTestHooks() {
  beforeEach(() => {
    ensureDom();
    useConnectionStore.setState({
      baseUrl: 'http://server.test',
      token: '',
      agentToken: '',
      refreshMs: 3000,
    });
    useAlertsStore.setState({ rules: [] });
    useAlertRuntimeStore.setState({
      breaching: [],
      status: 'idle',
      error: null,
      connectionIdentity: null,
    });
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    useConnectionStore.setState({ baseUrl: '/api', token: '', agentToken: '', refreshMs: 3000 });
    useAlertsStore.setState({ rules: [] });
  });
}
