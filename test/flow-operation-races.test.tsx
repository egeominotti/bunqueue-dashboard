import { afterEach, describe, expect, test } from 'bun:test';
import { act, StrictMode } from 'react';
import { useConnectionStore } from '../src/components/dashboard/stores/connectionStore';
import { FlowCreator } from '../src/features/flows/ui/FlowCreator';
import { FlowDependencyConsole } from '../src/features/flows/ui/FlowDependencyConsole';
import { FlowJobToolkit } from '../src/features/flows/ui/FlowJobToolkit';
import { FlowParentResults } from '../src/features/flows/ui/FlowParentResults';
import { ensureDom, settle } from './domSetup';
import {
  button,
  changeControl,
  click,
  createElement,
  deferred,
  fakeRepository,
  field,
  marker,
  renderFlowUi,
  submit,
} from './flow-operation-races.helpers';

ensureDom();
const cleanups = new Set<() => void>();

afterEach(() => {
  for (const cleanup of cleanups) cleanup();
  cleanups.clear();
  useConnectionStore.setState({ baseUrl: '/api', token: '', agentToken: '', refreshMs: 3000 });
});

describe('Flow operation request identity', () => {
  test('FlowCreator keeps a durable create locked across draft changes', async () => {
    const heldAdd = deferred<unknown>();
    const calls: string[] = [];
    let bulkCalls = 0;
    const repository = fakeRepository({
      create: (operation) => {
        calls.push(operation);
        if (operation === 'add') return heldAdd.promise;
        bulkCalls += 1;
        return bulkCalls === 1
          ? Promise.resolve(marker('fresh-create'))
          : Promise.reject(new Error('create rejected'));
      },
    });
    const view = renderFlowUi(createElement(FlowCreator, { repository, onOpen: () => undefined }));
    cleanups.add(view.unmount);

    submit(view.host);
    changeControl(field<HTMLSelectElement>(view.host, 'FlowProducer method'), 'addBulk');
    submit(view.host);
    await settle(2);
    expect(calls).toEqual(['add']);
    expect(view.host.textContent).not.toContain('fresh-create');

    heldAdd.resolve(marker('stale-create'));
    await settle(2);
    expect(view.host.textContent).not.toContain('stale-create');

    submit(view.host);
    await settle(2);
    expect(calls).toEqual(['add', 'addBulk']);
    expect(view.host.textContent).toContain('fresh-create');

    changeControl(field<HTMLTextAreaElement>(view.host, 'Flow definition JSON'), '{"flows":[]}');
    expect(view.host.textContent).not.toContain('fresh-create');
    submit(view.host);
    await settle(2);
    expect(view.host.querySelector('[role="alert"]')?.textContent).toContain('create rejected');
    expect(view.host.textContent).not.toContain('fresh-create');
  });

  test('an exclusive Flow create stays locked across StrictMode remount until settlement', async () => {
    act(() => {
      useConnectionStore.setState({
        baseUrl: 'http://server-a.test',
        token: 'server-a-token',
        agentToken: 'agent-a-token',
      });
    });
    for (const outcome of ['resolve', 'reject'] as const) {
      const held = deferred<unknown>();
      let calls = 0;
      const repository = fakeRepository({
        create: async () => {
          calls += 1;
          if (calls === 1) return held.promise;
          return marker(`fresh-after-${outcome}`);
        },
      });
      const element = createElement(
        StrictMode,
        null,
        createElement(FlowCreator, { repository, onOpen: () => undefined })
      );
      const first = renderFlowUi(element);
      cleanups.add(first.unmount);
      submit(first.host);
      expect(calls).toBe(1);
      first.unmount();
      cleanups.delete(first.unmount);

      const remounted = renderFlowUi(element);
      cleanups.add(remounted.unmount);
      submit(remounted.host);
      await settle(2);
      const callsBeforeSettlement = calls;
      if (outcome === 'resolve') held.resolve(marker('old-result'));
      else held.reject(new Error('old request timed out'));
      await settle(2);

      expect(callsBeforeSettlement).toBe(1);
      submit(remounted.host);
      await settle(2);
      expect(calls).toBe(2);
      expect(remounted.host.textContent).toContain(`fresh-after-${outcome}`);
      remounted.unmount();
      cleanups.delete(remounted.unmount);
    }
  });

  test('an in-flight Flow create on A does not block the retargeted backend B', async () => {
    act(() => {
      useConnectionStore.setState({
        baseUrl: 'http://server-a.test',
        token: 'server-a-token',
        agentToken: 'agent-a-token',
      });
    });
    const heldA = deferred<unknown>();
    let calls = 0;
    const repository = fakeRepository({
      create: async () => {
        calls += 1;
        return calls === 1 ? heldA.promise : marker('server-b-create');
      },
    });
    const view = renderFlowUi(createElement(FlowCreator, { repository, onOpen: () => undefined }));
    cleanups.add(view.unmount);
    submit(view.host);
    act(() => {
      useConnectionStore.setState({
        baseUrl: 'http://server-b.test',
        token: 'server-b-token',
        agentToken: 'agent-b-token',
      });
    });
    submit(view.host);
    await settle(2);
    heldA.resolve(marker('server-a-stale'));
    await settle(2);

    expect(calls).toBe(2);
    expect(view.host.textContent).toContain('server-b-create');
    expect(view.host.textContent).not.toContain('server-a-stale');
  });

  test('a durable dependency mutation cannot be duplicated by remounting its panel', async () => {
    const originalConfirm = window.confirm;
    const held = deferred<unknown>();
    let calls = 0;
    const repository = fakeRepository({
      mutate: async () => {
        calls += 1;
        return calls === 1 ? held.promise : marker('fresh-retry');
      },
    });
    const element = createElement(FlowDependencyConsole, {
      repository,
      initialTarget: { id: 'job-a', queueName: 'queue' },
    });
    window.confirm = () => true;
    try {
      const first = renderFlowUi(element);
      click(button(first.host, 'Retry job'));
      expect(calls).toBe(1);
      first.unmount();

      const remounted = renderFlowUi(element);
      cleanups.add(remounted.unmount);
      click(button(remounted.host, 'Retry job'));
      await settle(2);
      expect(calls).toBe(1);

      held.resolve(marker('old-retry'));
      await settle(2);
      click(button(remounted.host, 'Retry job'));
      await settle(2);
      expect(calls).toBe(2);
      expect(remounted.host.textContent).toContain('fresh-retry');
    } finally {
      held.resolve(marker('cleanup'));
      window.confirm = originalConfirm;
    }
  });

  test('FlowJobToolkit retargets without publishing the old job receipt', async () => {
    const heldJobA = deferred<unknown>();
    const calls: string[] = [];
    const repository = fakeRepository({
      inspect: (target, operation) => {
        calls.push(`${operation}:${target.queueName}/${target.id}`);
        return target.id === 'job-a' ? heldJobA.promise : Promise.resolve(marker('fresh-job-b'));
      },
    });
    const view = renderFlowUi(
      createElement(FlowJobToolkit, {
        repository,
        initialTarget: { id: 'job-a', queueName: 'queue' },
      })
    );
    cleanups.add(view.unmount);

    click(button(view.host, 'getState'));
    changeControl(field<HTMLInputElement>(view.host, 'Flow job ID'), 'job-b');
    click(button(view.host, 'getState'));
    await settle(2);
    expect(calls).toEqual(['getState:queue/job-a', 'getState:queue/job-b']);
    expect(view.host.textContent).toContain('fresh-job-b');

    heldJobA.reject(new Error('stale job error'));
    await settle(2);
    expect(view.host.textContent).toContain('fresh-job-b');
    expect(view.host.textContent).not.toContain('stale job error');
  });

  test('FlowDependencyConsole ignores old targets and clears success on async error', async () => {
    const heldJobA = deferred<unknown>();
    const repository = fakeRepository({
      inspect: (target, operation) => {
        if (target.id === 'job-a') return heldJobA.promise;
        if (operation === 'getDependencies') return Promise.reject(new Error('read rejected'));
        return Promise.resolve(marker('fresh-dependency-b'));
      },
    });
    const view = renderFlowUi(
      createElement(FlowDependencyConsole, {
        repository,
        initialTarget: { id: 'job-a', queueName: 'queue' },
      })
    );
    cleanups.add(view.unmount);

    click(button(view.host, 'getChildrenValues'));
    changeControl(field<HTMLInputElement>(view.host, 'Flow job ID'), 'job-b');
    click(button(view.host, 'getChildrenValues'));
    await settle(2);
    expect(view.host.textContent).toContain('fresh-dependency-b');

    heldJobA.resolve(marker('stale-dependency-a'));
    await settle(2);
    expect(view.host.textContent).not.toContain('stale-dependency-a');
    click(button(view.host, 'getDependencies'));
    expect(view.host.textContent).not.toContain('fresh-dependency-b');
    await settle(2);
    expect(view.host.querySelector('[role="alert"]')?.textContent).toContain('read rejected');
    expect(view.host.textContent).not.toContain('fresh-dependency-b');
  });

  test('FlowParentResults binds each receipt to the current input IDs', async () => {
    const heldParentsA = deferred<unknown>();
    const calls: string[] = [];
    const repository = fakeRepository({
      getParentResults: (ids) => {
        calls.push(ids.join('|'));
        return ids[0] === 'parent-a'
          ? heldParentsA.promise
          : Promise.resolve(marker('fresh-parents-b'));
      },
    });
    const view = renderFlowUi(
      createElement(FlowParentResults, { repository, initialIds: 'parent-a' })
    );
    cleanups.add(view.unmount);

    click(button(view.host, 'getParentResults (1)'));
    changeControl(field<HTMLTextAreaElement>(view.host, 'Flow parent IDs'), 'parent-b\nparent-c');
    click(button(view.host, 'getParentResults (2)'));
    await settle(2);
    expect(calls).toEqual(['parent-a', 'parent-b|parent-c']);
    expect(view.host.textContent).toContain('fresh-parents-b');

    heldParentsA.resolve(marker('stale-parents-a'));
    await settle(2);
    expect(view.host.textContent).toContain('fresh-parents-b');
    expect(view.host.textContent).not.toContain('stale-parents-a');
  });
});
