import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { act, createElement } from 'react';

import { createRoot } from 'react-dom/client';

import { CopilotBoundary } from '../src/components/copilot/Copilot';

import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';

import { useCopilotStore } from '../src/components/dashboard/stores/copilotStore';

import {
  createModel,
  normalizeCustomProviderBaseURL,
  providerById,
  resolveCompatibleProviderBaseURL,
} from '../src/lib/copilot/providers';

import { abortActive, clearChat, sendMessage } from '../src/lib/copilot/runtime';

import { buildTools } from '../src/lib/copilot/tools';

import { ensureDom } from './domSetup';

/**
 * Regressions for the copilot audit pass.
 *
 * The central one is the id generator: crypto.randomUUID is gated on a SECURE
 * context, so on a plain-http origin (the documented LAN/Docker deployment) the
 * fallback branch is the ONLY branch that ever runs. `withoutRandomUUID` puts the
 * tests in exactly that world, with Date.now frozen so any ms-resolution id
 * generator is guaranteed to collide.
 */
const realCrypto = globalThis.crypto;

const realNow = Date.now;

function withoutRandomUUID(): void {
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    writable: true,
    value: { getRandomValues: realCrypto.getRandomValues.bind(realCrypto) },
  });
  Date.now = () => 1784764361322;
}

function restoreCrypto(): void {
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    writable: true,
    value: realCrypto,
  });
  Date.now = realNow;
}

export {
  abortActive,
  act,
  afterEach,
  beforeEach,
  buildTools,
  CopilotBoundary,
  clearChat,
  createElement,
  createModel,
  createRoot,
  describe,
  ensureDom,
  expect,
  normalizeCustomProviderBaseURL,
  providerById,
  realCrypto,
  realNow,
  resolveCompatibleProviderBaseURL,
  restoreCrypto,
  sendMessage,
  test,
  useConnectionStore,
  useCopilotStore,
  withoutRandomUUID,
};
