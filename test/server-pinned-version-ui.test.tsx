import { expect, test } from 'bun:test';
import { createElement } from 'react';
import manifest from '../package.json';
import type { ServerStatus } from '../src/lib/bqTypes';
import { demoStatus } from '../src/lib/demo/control';
import { AgentInfoCard } from '../src/pages/control/server/AgentInfoCard';
import { ConfigCard } from '../src/pages/control/server/ConfigCard';
import { render, installStableFixHooks } from './control-pages-stable-fixes.helpers';

installStableFixHooks();
test('server instructions and configuration placeholder use the pinned managed release', () => {
  const command = `bunx bunqueue@${manifest.dependencies.bunqueue} start`;
  const info = render(createElement(AgentInfoCard, { agentBase: 'http://127.0.0.1:6800' }));
  expect(info.host.textContent).toContain(command);
  const config = render(
    createElement(ConfigCard, {
      status: demoStatus() as unknown as ServerStatus,
      onSaved: () => undefined,
      running: false,
      transitioning: false,
    })
  );
  expect(config.host.querySelector<HTMLInputElement>('[name="server-command"]')?.placeholder).toBe(
    command
  );
  expect(config.host.textContent).toContain(`Bunqueue ${manifest.dependencies.bunqueue} with bunx`);
});
