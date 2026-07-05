import { isStepCount, streamText } from 'ai';
import { useCopilotStore } from '@/components/dashboard/stores/copilotStore';
import { createModel, providerById } from './providers';
import { buildTools } from './tools';

const SYSTEM = `You are the bunqueue Copilot, an AI assistant embedded in a dashboard that operates a bunqueue job-queue server.

You help the operator understand and control their queues, jobs, dead-letter queue (DLQ), workers, and crons. Use the provided tools to read LIVE state instead of guessing — never invent queue names, job ids, counts, or states; look them up. Prefer the smallest set of tool calls that answers the question.

Mutating tools (retry, promote, remove, pause/resume, retry/purge DLQ) are gated: when you call one, the user is shown a confirmation and must approve it before it runs, so it is safe to propose a concrete action. If the user's request is ambiguous about which queue or job, ask a brief clarifying question or look it up first.

Be concise and practical. When you report data, summarize the important numbers rather than dumping raw JSON. Format with short markdown (bold, lists) when helpful.`;

/** Turn a raw provider/network error into an operator-friendly message. */
function friendly(msg: string, providerId: string): string {
  const m = msg.toLowerCase();
  if (m.includes('failed to fetch') || m.includes('networkerror') || m.includes('load failed')) {
    const def = providerById(providerId);
    const hint = def && !def.browserDirect ? ` ${def.note ?? ''}` : '';
    return `Could not reach the model. This is usually the provider blocking browser (CORS) requests, a wrong base URL, or no network.${hint}`.trim();
  }
  if (
    m.includes('401') ||
    m.includes('403') ||
    m.includes('unauthorized') ||
    m.includes('api key') ||
    m.includes('x-api-key') ||
    m.includes('invalid_api_key') ||
    m.includes('authentication')
  ) {
    return 'The provider rejected the API key. Check the key is valid and matches the selected provider.';
  }
  // Rate-limit / overload errors often name the model too, so classify them
  // BEFORE the bad-model check — otherwise a 429 mentioning the model id is
  // misreported as an invalid model id.
  if (
    m.includes('rate limit') ||
    m.includes('rate_limit') ||
    m.includes('429') ||
    m.includes('overloaded') ||
    m.includes('quota') ||
    m.includes('too many requests')
  ) {
    return `The provider is rate-limiting or overloaded: ${msg}. Wait a moment and retry.`;
  }
  // Only a genuine not-found / invalid-model signal — not any message that
  // merely contains the word "model".
  if (
    m.includes('404') ||
    m.includes('not found') ||
    m.includes('model_not_found') ||
    m.includes('no such model') ||
    m.includes('does not exist') ||
    m.includes('unknown model') ||
    m.includes('invalid model')
  ) {
    return `Model request failed: ${msg}. Check the model id is valid for this provider.`;
  }
  return msg;
}

// The in-flight turn's abort controller lives at module scope (not in the panel
// component) so Stop keeps working even if the panel is closed and reopened.
let activeAbort: AbortController | null = null;

/**
 * Abort the current turn and deterministically unwind. In the AI SDK, a Stop
 * while a mutating tool is suspended on its confirmation does NOT reject the
 * text stream — it would hang — so the cleanup must happen here, not in a catch
 * branch: resolve every pending confirmation as declined (so the suspended tool
 * returns without calling bq, and its card is cleared), clear busy, then abort
 * the stream. Resolving the confirmation also lets the aborted stream settle.
 */
export function abortActive(): void {
  const ac = activeAbort;
  activeAbort = null;
  const store = useCopilotStore.getState();
  store.cancelPending();
  store.setBusy(false);
  ac?.abort();
}

/** Run one user turn: stream the assistant reply, executing tools as it goes. */
export async function sendMessage(text: string): Promise<void> {
  const store = useCopilotStore.getState();
  const { config } = store;

  if (!config.apiKey.trim()) {
    store.addUser(text);
    const id = store.startAssistant();
    store.finishAssistant(id, {
      error: 'Add your API key in the Copilot settings (the gear) first.',
    });
    return;
  }

  // History = prior turns (captured before we add this one), then the new user turn.
  const history = store.messages
    .filter((m) => m.content.trim().length > 0)
    .map((m) => ({ role: m.role, content: m.content }));
  store.addUser(text);
  const assistantId = store.startAssistant();
  store.setBusy(true);
  const ac = new AbortController();
  activeAbort = ac;

  let failed: string | null = null;
  try {
    const model = createModel(config);
    const result = streamText({
      model,
      system: SYSTEM,
      messages: [...history, { role: 'user' as const, content: text }],
      tools: buildTools(assistantId),
      stopWhen: isStepCount(8),
      abortSignal: ac.signal,
      onError: ({ error }) => {
        failed = error instanceof Error ? error.message : String(error);
      },
    });
    for await (const delta of result.textStream) {
      store.appendAssistant(assistantId, delta);
    }
  } catch (e) {
    if ((e as Error).name === 'AbortError') {
      // abortActive() already cleared pending + busy for the turn it stopped
      // (and a suspended mutating tool was declined there, before ac.abort()).
      // Do NOT repeat cancelPending()/setBusy(false) here: a newer turn may have
      // started in between, and doing so would decline ITS confirmations and
      // release ITS busy lock. Only close this turn's own (by-id) bubble.
      store.finishAssistant(assistantId);
      if (activeAbort === ac) activeAbort = null;
      return;
    }
    failed = failed || (e as Error).message;
  }

  store.finishAssistant(
    assistantId,
    failed ? { error: friendly(failed, config.provider) } : undefined
  );
  // Only release the shared busy lock if this turn is still the active one — a
  // turn superseded via abortActive() must not flip a newer turn's busy.
  if (activeAbort === ac) {
    store.setBusy(false);
    activeAbort = null;
  }
}
