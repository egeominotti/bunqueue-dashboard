import type { EnhanceAppContext } from 'vitepress';
import DefaultTheme from 'vitepress/theme';
import Mermaid from './Mermaid.vue';
// Self-host the same variable fonts the app uses (Inter for text, JetBrains Mono
// for code) so the docs match the product, render identically offline, and never
// depend on a font CDN. custom.css wires them into VitePress's font tokens.
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import './custom.css';

export default {
  extends: DefaultTheme,
  enhanceApp({ app, router }: EnhanceAppContext) {
    app.component('Mermaid', Mermaid);

    // View Transitions API: wrap every in-app navigation so page swaps
    // cross-fade instead of hard-cutting. Progressive enhancement — browsers
    // without startViewTransition (or users who prefer reduced motion) just
    // navigate normally. Defensive: guard against overlapping transitions and
    // swallow the browser's abort rejections (`.finished`/`.ready` reject with
    // InvalidStateError when a transition is skipped) so nothing hits the console.
    if (typeof window !== 'undefined' && 'startViewTransition' in document) {
      const original = router.go.bind(router);
      const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
      let transitioning = false;
      router.go = (...args: Parameters<typeof original>) => {
        if (args[1]?.initialLoad || transitioning || reduceMotion?.matches) return original(...args);
        transitioning = true;
        return new Promise<void>((resolve) => {
          const done = () => {
            transitioning = false;
            resolve();
          };
          try {
            // startViewTransition is feature-detected above.
            const t = document.startViewTransition(() => original(...args));
            // Resolve navigation as soon as the DOM has updated; let the visual
            // transition finish on its own. Swallow abort rejections.
            t.updateCallbackDone.then(done, done);
            t.finished.catch(() => {});
            t.ready.catch(() => {});
          } catch {
            // startViewTransition can throw synchronously in an invalid state.
            void original(...args).then(done, done);
          }
        });
      };
    }
  },
};
