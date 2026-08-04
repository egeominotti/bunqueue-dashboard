import { afterEach, describe, expect, test } from 'bun:test';
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
});

describe('Flow operation request identity', () => {
  test('FlowCreator drops an old operation and clears success before a later error', async () => {
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
    expect(calls).toEqual(['add', 'addBulk']);
    expect(view.host.textContent).toContain('fresh-create');

    heldAdd.resolve(marker('stale-create'));
    await settle(2);
    expect(view.host.textContent).toContain('fresh-create');
    expect(view.host.textContent).not.toContain('stale-create');

    changeControl(field<HTMLTextAreaElement>(view.host, 'Flow definition JSON'), '{"flows":[]}');
    expect(view.host.textContent).not.toContain('fresh-create');
    submit(view.host);
    await settle(2);
    expect(view.host.querySelector('[role="alert"]')?.textContent).toContain('create rejected');
    expect(view.host.textContent).not.toContain('fresh-create');
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
