export const E2E_BASE_PATH = '/e2e/dashboard';
export const E2E_LOOPBACK_HOST = '127.0.0.1';
export const E2E_DASHBOARD_PORT = 49380;
export const E2E_CONTROL_PORT = 49381;
export const E2E_HTTP_PORT = 49382;
export const E2E_TCP_PORT = 49383;
export const E2E_AGENT_PORT = 49384;

export const E2E_ORIGIN = `http://${E2E_LOOPBACK_HOST}:${E2E_DASHBOARD_PORT}`;
export const E2E_APP_URL = `${E2E_ORIGIN}${E2E_BASE_PATH}`;
export const E2E_CONTROL_URL = `http://${E2E_LOOPBACK_HOST}:${E2E_CONTROL_PORT}`;

// Test-only values bound exclusively to disposable loopback listeners.
export const E2E_SERVER_TOKEN = 'browser-e2e-server-token';
export const E2E_CONTROL_TOKEN = 'browser-e2e-control-token';
export const E2E_SEED_QUEUE = 'browser-e2e-seed';

export function createE2EUpstreamEnvironment(
  database: string,
  inherited: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  return {
    ...inherited,
    AUTH_TOKENS: E2E_SERVER_TOKEN,
    BUNQUEUE_DATA_PATH: database,
    HOST: E2E_LOOPBACK_HOST,
    HTTP_PORT: String(E2E_HTTP_PORT),
    TCP_PORT: String(E2E_TCP_PORT),
  };
}
