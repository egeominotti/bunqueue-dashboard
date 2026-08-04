import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  CONNECTION_STORAGE_KEY,
  getAgentAuthHeaders,
  getAuthHeaders,
  getBaseUrl,
  isValidBaseUrl,
  normalizeBaseUrl,
  persistedConnectionState,
  resolveDefaultBaseUrl,
  sanitizedPersistedConnectionState,
  useConnectionStore,
} from '../src/components/dashboard/stores/connectionStore';

import { api } from '../src/lib/api';

import { bq } from '../src/lib/bq';

const realFetch = globalThis.fetch;

const STORAGE_KEY = CONNECTION_STORAGE_KEY;

export {
  afterEach,
  api,
  beforeEach,
  bq,
  CONNECTION_STORAGE_KEY,
  describe,
  expect,
  getAgentAuthHeaders,
  getAuthHeaders,
  getBaseUrl,
  isValidBaseUrl,
  normalizeBaseUrl,
  persistedConnectionState,
  realFetch,
  resolveDefaultBaseUrl,
  STORAGE_KEY,
  sanitizedPersistedConnectionState,
  test,
  useConnectionStore,
};
