import { OperationalExecutionList } from '../src/features/workflows/ui/OperationalExecutionList';
import {
  act,
  createElement,
  describe,
  expect,
  installTestHooks,
  render,
  summary,
  test,
} from './workflows-ui.helpers';

installTestHooks();

describe('Workflow waiting clock', () => {
  test('advances every waiting cell with one shared ticker and no data refresh', () => {
    let now = 4_000;
    let subscriptions = 0;
    let unsubscriptions = 0;
    let tick = () => {};
    const clock = {
      now: () => now,
      subscribe: (update: () => void) => {
        subscriptions += 1;
        tick = update;
        return () => {
          unsubscriptions += 1;
        };
      },
    };
    const view = render(
      createElement(OperationalExecutionList, {
        mode: 'waiting',
        rows: [
          { ...summary('wait-1', 'waiting'), updatedAt: 1_000 },
          { ...summary('wait-2', 'waiting'), updatedAt: 2_000 },
        ],
        selected: null,
        onSelect: () => {},
        total: 2,
        offset: 0,
        pageSize: 25,
        onPage: () => {},
        clock,
      })
    );

    expect(view.host.textContent).toContain('3.0s');
    expect(view.host.textContent).toContain('2.0s');
    expect(subscriptions).toBe(1);
    now = 65_000;
    act(() => tick());
    expect(view.host.textContent).toContain('1m 4s');
    expect(view.host.textContent).toContain('1m 3s');
    expect(subscriptions).toBe(1);
    view.unmount();
    expect(unsubscriptions).toBe(1);
  });
});
