import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { act, createElement, type ReactElement } from 'react';

import { createRoot } from 'react-dom/client';

import { MemoryRouter, NavLink, Route, Routes } from 'react-router-dom';

import { CommandPalette } from '../src/components/CommandPalette';

import { Copilot } from '../src/components/copilot/Copilot';

import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';

import { useCopilotStore } from '../src/components/dashboard/stores/copilotStore';

import { titleFor, useDocumentTitle } from '../src/components/layout/pageTitle';

import { NAV } from '../src/components/layout/Sidebar';

import { CardHeader } from '../src/components/ui/Card';

import { Field, Input } from '../src/components/ui/form';

import { Database } from '../src/pages/control/Database';

import { DlqPro } from '../src/pages/control/DlqPro';

import { LogsPro } from '../src/pages/control/LogsPro';

import { QueueDetailPro } from '../src/pages/control/QueueDetailPro';

import { NotFound } from '../src/pages/NotFound';

import { fetchHealthWithTimeout, Settings } from '../src/pages/Settings';

import { ensureDom, settle } from './domSetup';

const realFetch = globalThis.fetch;

const realConfirm = window.confirm;

const mounted = new Set<() => void>();

const animationFrameState: {
  installed: boolean;
  previousRequest?: PropertyDescriptor;
  previousCancel?: PropertyDescriptor;
} = { installed: false };

function render(element: ReactElement) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  let active = true;
  const unmount = () => {
    if (!active) return;
    active = false;
    act(() => root.unmount());
    host.remove();
    mounted.delete(unmount);
  };
  mounted.add(unmount);
  act(() => root.render(element));
  return { host, unmount };
}

async function waitForElement<T extends Element>(
  host: ParentNode,
  selector: string,
  timeoutMs = 1000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const element = host.querySelector<T>(selector);
    if (element) return element;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${selector}`);
    // Lazy module completion must settle inside React act(), especially when
    // the full coverage suite makes the chunk import slower than an isolated run.
    await settle(10);
  }
}

export type { ReactElement };
export {
  act,
  afterEach,
  animationFrameState,
  beforeEach,
  CardHeader,
  CommandPalette,
  Copilot,
  createElement,
  createRoot,
  Database,
  DlqPro,
  describe,
  ensureDom,
  expect,
  Field,
  fetchHealthWithTimeout,
  Input,
  LogsPro,
  MemoryRouter,
  mounted,
  NAV,
  NavLink,
  NotFound,
  QueueDetailPro,
  Route,
  Routes,
  realConfirm,
  realFetch,
  render,
  Settings,
  settle,
  test,
  titleFor,
  useConnectionStore,
  useCopilotStore,
  useDocumentTitle,
  waitForElement,
};

export function installTestHooks() {
  beforeEach(() => {
    ensureDom();
    useConnectionStore.setState({ baseUrl: '/api', token: '', agentToken: '' });
    useCopilotStore.getState().clear();
    useCopilotStore.getState().setOpen(false);
    animationFrameState.installed = false;
    if (!globalThis.requestAnimationFrame) {
      animationFrameState.previousRequest = Object.getOwnPropertyDescriptor(
        globalThis,
        'requestAnimationFrame'
      );
      animationFrameState.previousCancel = Object.getOwnPropertyDescriptor(
        globalThis,
        'cancelAnimationFrame'
      );
      animationFrameState.installed = true;
      globalThis.requestAnimationFrame = (callback: FrameRequestCallback) =>
        setTimeout(() => callback(performance.now()), 0) as unknown as number;
      globalThis.cancelAnimationFrame = (id: number) => clearTimeout(id);
    }
  });

  afterEach(() => {
    try {
      for (const unmount of [...mounted]) unmount();
      globalThis.fetch = realFetch;
      window.confirm = realConfirm;
      useCopilotStore.getState().clear();
      useCopilotStore.getState().setOpen(false);
    } finally {
      if (animationFrameState.installed) {
        if (animationFrameState.previousRequest) {
          Object.defineProperty(
            globalThis,
            'requestAnimationFrame',
            animationFrameState.previousRequest
          );
        } else {
          Reflect.deleteProperty(globalThis, 'requestAnimationFrame');
        }
        if (animationFrameState.previousCancel) {
          Object.defineProperty(
            globalThis,
            'cancelAnimationFrame',
            animationFrameState.previousCancel
          );
        } else {
          Reflect.deleteProperty(globalThis, 'cancelAnimationFrame');
        }
        animationFrameState.installed = false;
      }
    }
  });
}
