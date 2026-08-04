import { agentSubUrl, describe, expect, handler, it } from './scripts-fixes.helpers';

describe('serve.ts /agent path parsing', () => {
  it('does not throw on a path that looks like an authority', () => {
    expect(agentSubUrl('/agent//x:y/z', '').href).toBe('http://agent.internal//x:y/z');
    expect(agentSubUrl('/agent', '').href).toBe('http://agent.internal/');
    expect(agentSubUrl('/agent/db/tables', '?limit=5').href).toBe(
      'http://agent.internal/db/tables?limit=5'
    );
  });

  it('answers GET /agent//x:y/z instead of crashing the handler', async () => {
    const res = await handler()(new Request('http://localhost:8080/agent//x:y/z'));
    expect(res.status).toBe(200);
    expect((await res.json()).url).toBe('http://agent.internal//x:y/z');
  });
});
