import type { LanguageModel } from 'ai';

/**
 * Copilot providers. The dashboard is a browser SPA, so the LLM call goes
 * DIRECT from the page to the provider with the user's own key. Providers that
 * serve permissive CORS to browsers work as-is; OpenAI does not (it blocks
 * browser-origin calls) so we flag it and steer users to OpenRouter for GPT.
 * The model id is a free-text field (with these as suggestions) so any current
 * or future model works without a code change.
 */
export type ProviderKind = 'anthropic' | 'openai' | 'google' | 'compatible';

export interface ProviderDef {
  id: string;
  label: string;
  kind: ProviderKind;
  /** Fixed base URL for openai-compatible providers ('' = user supplies it). */
  baseURL?: string;
  models: string[];
  keyUrl: string;
  /** Does a direct browser fetch to this provider pass CORS? */
  browserDirect: boolean;
  note?: string;
}

export const PROVIDERS: ProviderDef[] = [
  {
    id: 'anthropic',
    label: 'Claude — Anthropic',
    kind: 'anthropic',
    models: ['claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'],
    keyUrl: 'https://console.anthropic.com/settings/keys',
    browserDirect: true,
  },
  {
    id: 'openai',
    label: 'ChatGPT — OpenAI',
    kind: 'openai',
    models: ['gpt-5.1', 'gpt-5', 'gpt-4.1', 'o4-mini'],
    keyUrl: 'https://platform.openai.com/api-keys',
    browserDirect: false,
    note: 'OpenAI blocks direct browser calls (CORS). Use OpenRouter for GPT models, or run behind a proxy.',
  },
  {
    id: 'google',
    label: 'Gemini — Google',
    kind: 'google',
    models: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash'],
    keyUrl: 'https://aistudio.google.com/app/apikey',
    browserDirect: true,
  },
  {
    id: 'zai',
    label: 'GLM — Z.ai',
    kind: 'compatible',
    baseURL: 'https://api.z.ai/api/paas/v4',
    models: ['glm-4.6', 'glm-4.5', 'glm-4.5-air'],
    keyUrl: 'https://z.ai/manage-apikey/apikey-list',
    browserDirect: true,
  },
  {
    id: 'openrouter',
    label: 'OpenRouter — any model',
    kind: 'compatible',
    baseURL: 'https://openrouter.ai/api/v1',
    models: [
      'anthropic/claude-opus-4.8',
      'openai/gpt-5.1',
      'google/gemini-2.5-pro',
      'z-ai/glm-4.6',
      'meta-llama/llama-3.3-70b-instruct',
    ],
    keyUrl: 'https://openrouter.ai/keys',
    browserDirect: true,
  },
  {
    id: 'custom',
    label: 'Custom — OpenAI-compatible',
    kind: 'compatible',
    baseURL: '',
    models: [],
    keyUrl: '',
    browserDirect: true,
    note: 'Any OpenAI-compatible endpoint (Groq, Together, Mistral, a local Ollama / LM Studio, …). Set the base URL and model.',
  },
];

export const providerById = (id: string): ProviderDef | undefined =>
  PROVIDERS.find((p) => p.id === id);

export interface ModelConfig {
  provider: string;
  baseURL: string;
  apiKey: string;
  model: string;
}

/**
 * Build a v7 LanguageModel for the chosen provider, keyed with the user's key.
 * Each provider SDK is loaded only when selected, keeping the Copilot panel and
 * unused providers out of the same oversized lazy chunk.
 */
export async function createModel(cfg: ModelConfig): Promise<LanguageModel> {
  const def = providerById(cfg.provider);
  const apiKey = cfg.apiKey.trim();
  switch (def?.kind) {
    case 'anthropic': {
      const { createAnthropic } = await import('@ai-sdk/anthropic');
      return createAnthropic({
        apiKey,
        // Required for Anthropic to accept a browser-origin request.
        headers: { 'anthropic-dangerous-direct-browser-access': 'true' },
      })(cfg.model);
    }
    case 'openai': {
      const { createOpenAI } = await import('@ai-sdk/openai');
      return createOpenAI({ apiKey })(cfg.model);
    }
    case 'google': {
      const { createGoogleGenerativeAI } = await import('@ai-sdk/google');
      return createGoogleGenerativeAI({ apiKey })(cfg.model);
    }
    default: {
      const { createOpenAICompatible } = await import('@ai-sdk/openai-compatible');
      return createOpenAICompatible({
        name: cfg.provider || 'custom',
        baseURL: (cfg.baseURL || def?.baseURL || '').replace(/\/+$/, ''),
        apiKey,
      })(cfg.model);
    }
  }
}
