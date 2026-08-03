import { isStepCount, streamText } from 'ai';
import { useCopilotStore } from '@/components/dashboard/stores/copilotStore';
import { captureServerRequestTarget } from '@/lib/bq';
import { createModel, providerById } from './providers';
import { buildTools } from './tools';

const SYSTEM = `You are the bunqueue Copilot, an AI assistant embedded in a dashboard that operates a bunqueue job-queue server.

You help the operator understand and control their queues, jobs, dead-letter queue (DLQ), workers, and crons. Use the provided tools to read LIVE state instead of guessing — never invent queue names, job ids, counts, or states; look them up. Prefer the smallest set of tool calls that answers the question.

The only mutating tools are: promote one delayed job, pause one queue, and resume one queue. Each is confirmation-gated and the confirmation names the immutable target server. Generic retry, completed-job requeue, every DLQ retry, cancel/remove, and DLQ purge are unavailable: never claim you can perform them. If the user's request is ambiguous about which queue or job, ask a brief clarifying question or look it up first.

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

interface ActiveTurn {
  readonly id: number;
  readonly controller: AbortController;
}

// The lease lives at module scope (not in the panel component), so acquisition
// is synchronous even when two submit events happen before React re-renders.
// It also makes Stop work after the panel is closed and reopened.
let turnSequence = 0;
let activeTurn: ActiveTurn | null = null;

function acquireTurn(): ActiveTurn | null {
  if (activeTurn) return null;
  const turn = { id: ++turnSequence, controller: new AbortController() };
  activeTurn = turn;
  return turn;
}

function ownsTurn(turn: ActiveTurn): boolean {
  return activeTurn === turn && !turn.controller.signal.aborted;
}

function releaseTurn(turn: ActiveTurn): void {
  if (activeTurn !== turn) return;
  activeTurn = null;
  useCopilotStore.getState().setBusy(false);
}

/**
 * Abort the current turn and deterministically unwind. In the AI SDK, a Stop
 * while a mutating tool is suspended on its confirmation does NOT reject the
 * text stream — it would hang — so the cleanup must happen here, not in a catch
 * branch: resolve every pending confirmation as declined (so the suspended tool
 * returns without calling bq, and its card is cleared), clear busy, then abort
 * the stream. Resolving the confirmation also lets the aborted stream settle.
 */
export function abortActive(): void {
  const turn = activeTurn;
  activeTurn = null;
  const store = useCopilotStore.getState();
  store.cancelPending();
  store.setBusy(false);
  turn?.controller.abort();
}

/**
 * Clear the conversation. Wiping the messages is not enough on its own: the turn
 * would keep streaming into a message that no longer exists, so a later tool call
 * would pin a confirm card ("Purge DLQ: prod") onto an empty panel with no
 * ToolEvent trail, and busy would stay latched for the rest of the turn. Abort
 * first, then clear.
 */
export function clearChat(): void {
  abortActive();
  useCopilotStore.getState().clear();
}

/** Run one user turn: stream the assistant reply, executing tools as it goes. */
export async function sendMessage(text: string): Promise<void> {
  // This is the authoritative mutex. `busy` is presentation state and may be
  // stale in a click handler until React commits the next render.
  const turn = acquireTurn();
  if (!turn) return;

  const store = useCopilotStore.getState();
  const config = { ...store.config };

  try {
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
    // Publish busy before adding either message. A render can now disable the
    // form, while the module lease already protects this same tick.
    store.setBusy(true);
    store.addUser(text);
    const assistantId = store.startAssistant();

    let failed: string | null = null;
    try {
      // One assistant turn owns one immutable server URL + bearer pair. Every
      // tool closure receives this snapshot and the same cancellation signal.
      const serverTarget = captureServerRequestTarget();
      const model = await createModel(config);
      if (!ownsTurn(turn)) {
        store.finishAssistant(assistantId);
        return;
      }

      const result = streamText({
        model,
        system: SYSTEM,
        messages: [...history, { role: 'user' as const, content: text }],
        tools: buildTools(assistantId, serverTarget, turn.controller.signal),
        stopWhen: isStepCount(8),
        abortSignal: turn.controller.signal,
        onError: ({ error }) => {
          failed = error instanceof Error ? error.message : String(error);
        },
      });
      for await (const delta of result.textStream) {
        // Some providers/test transports can ignore AbortSignal. Ownership is
        // therefore checked independently before any late text is published.
        if (!ownsTurn(turn)) {
          store.finishAssistant(assistantId);
          return;
        }
        store.appendAssistant(assistantId, delta);
      }
    } catch (e) {
      if (
        turn.controller.signal.aborted ||
        activeTurn !== turn ||
        (e as Error).name === 'AbortError'
      ) {
        // abortActive() already cleared pending + busy. Only close this turn's
        // own bubble; a newer turn may already own both shared resources.
        store.finishAssistant(assistantId);
        return;
      }
      failed = failed || (e as Error).message;
    }

    if (!ownsTurn(turn)) {
      store.finishAssistant(assistantId);
      return;
    }
    store.finishAssistant(
      assistantId,
      failed ? { error: friendly(failed, config.provider) } : undefined
    );
  } finally {
    releaseTurn(turn);
  }
}
