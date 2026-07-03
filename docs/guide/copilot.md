---
title: Copilot (experimental)
description: An in-dashboard AI copilot for bunqueue. Bring your own model (Claude, ChatGPT, Gemini, GLM, or any OpenAI-compatible endpoint) and inspect or operate your queues by chat.
---

# Copilot (experimental)

The Copilot is a chat assistant built into the dashboard. It reads your live
queue state and can propose actions (retry, pause, purge) that you confirm
before they run. It is experimental, and stays off until you add a model.

## Bring your own model

Open the Copilot (the button in the bottom right), then the settings gear, and
pick a provider:

- Claude (Anthropic)
- ChatGPT (OpenAI)
- Gemini (Google)
- GLM (Z.ai)
- OpenRouter (one key, every model)
- Custom (any OpenAI-compatible endpoint: Groq, Together, Mistral, a local
  Ollama or LM Studio)

It is built on the Vercel AI SDK, so all of these work. Paste your own API key
and set the model id. The key is kept in memory for the session only and is
never written to disk; the provider and model are remembered.

## Browser (CORS) note

The dashboard is a browser app, so the model call goes straight from your
browser to the provider. Some providers allow that and some do not:

- Work browser-direct: Claude (with the safe browser header, added
  automatically), OpenRouter, Z.ai, and most OpenAI-compatible endpoints.
- Blocked by the provider: OpenAI and native Google Gemini block direct browser
  calls. Reach those through OpenRouter, or run behind a proxy.

## What it can do

Read (runs immediately): list queues and counts, list and inspect jobs, DLQ
stats and entries, server health and stats, workers, and crons.

Change (asks first): retry a job, promote a delayed job, remove a job, pause or
resume a queue, retry or purge a DLQ. Every mutating action shows a confirmation
in the chat and only runs after you click Confirm.

## Try it

In the [live demo](https://egeominotti.github.io/bunqueue-dashboard/) the Copilot
answers against the demo fixtures, so with your own key you can watch it hold a
real conversation and drive tools with no backend.
