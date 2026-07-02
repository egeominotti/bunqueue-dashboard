/// <reference types="vite/client" />

// Fontsource variable packages ship CSS side-effect entry points with no types.
declare module '@fontsource-variable/inter';
declare module '@fontsource-variable/jetbrains-mono';

interface ImportMetaEnv {
  /** Origin of the bunqueue HTTP server, e.g. https://queue.example.com. Empty → use the dev proxy at /api. */
  readonly VITE_BUNQUEUE_URL?: string;
  /** Optional bearer token if the server has AUTH_TOKENS set. */
  readonly VITE_BUNQUEUE_TOKEN?: string;
  /** Origin of the control agent (start/stop/restart). Defaults to http://localhost:6800. */
  readonly VITE_BUNQUEUE_AGENT_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
