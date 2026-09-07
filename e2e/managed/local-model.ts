import { createServer } from 'node:http';
import { z } from 'zod';
import { E2E_APP_URL } from '../config';

const completionRequest = z.object({
  messages: z.array(z.object({ role: z.string(), content: z.unknown() })).min(1),
});

/** Scripted local provider: verifies transport/tool safety, not model quality. */
export async function localModel() {
  let requests = 0;
  const server = createServer(async (request, response) => {
    try {
      response.setHeader('Access-Control-Allow-Origin', new URL(E2E_APP_URL).origin);
      response.setHeader('Access-Control-Allow-Headers', 'authorization,content-type');
      if (request.method === 'OPTIONS') {
        response.writeHead(204);
        response.end();
        return;
      }
      if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
        response.writeHead(404);
        response.end();
        return;
      }
      requests++;
      let body = '';
      for await (const chunk of request) {
        body += chunk.toString();
        if (body.length > 256_000) throw new Error('Local provider request exceeds fixture limit');
      }
      const parsed = completionRequest.parse(JSON.parse(body));
      const last = parsed.messages.at(-1)!;
      const tool =
        last.role === 'tool'
          ? null
          : String(last.content).includes('resume')
            ? 'resume_queue'
            : 'pause_queue';
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const base = {
        id: `local-${requests}`,
        object: 'chat.completion.chunk',
        created: 1,
        model: 'scripted-local',
      };
      const delta = tool
        ? {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: `call-${requests}`,
                type: 'function',
                function: { name: tool, arguments: JSON.stringify({ queue: 'managed-copilot' }) },
              },
            ],
          }
        : { role: 'assistant', content: 'Local tool verification completed.' };
      response.write(
        `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`
      );
      response.write(
        `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }] })}\n\n`
      );
      response.end('data: [DONE]\n\n');
    } catch (error) {
      if (!response.headersSent) response.writeHead(400, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({ error: error instanceof Error ? error.message : String(error) })
      );
    }
  });
  await new Promise<void>((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', done);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing local model listener');
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    requests: () => requests,
    close: () =>
      new Promise<void>((done, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : done()));
      }),
  };
}
