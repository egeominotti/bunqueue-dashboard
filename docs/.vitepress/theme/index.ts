import type { EnhanceAppContext } from 'vitepress';
import DefaultTheme from 'vitepress/theme';
import TwoslashFloatingVue from '@shikijs/vitepress-twoslash/client';
// vitepress-plugin-mermaid registers <Mermaid> via a fragile string-match Vite
// transform that doesn't take effect in the production client bundle (works in
// dev, renders an empty <div class="mermaid"> in `vitepress build`). Register the
// component explicitly here so it hydrates and runs its onMounted render in prod.
import Mermaid from 'vitepress-plugin-mermaid/Mermaid.vue';
import '@shikijs/vitepress-twoslash/style.css';
import './custom.css';

export default {
  extends: DefaultTheme,
  enhanceApp({ app, router }: EnhanceAppContext) {
    // Twoslash hover popovers for ```ts twoslash code blocks.
    app.use(TwoslashFloatingVue);
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
      router.go = (href?: string) => {
        if (transitioning || reduceMotion?.matches) return original(href);
        transitioning = true;
        return new Promise<void>((resolve) => {
          const done = () => {
            transitioning = false;
            resolve();
          };
          try {
            // biome-ignore lint: startViewTransition is feature-detected above
            const t = (document as any).startViewTransition(() => original(href));
            // Resolve navigation as soon as the DOM has updated; let the visual
            // transition finish on its own. Swallow abort rejections.
            t.updateCallbackDone.then(done, done);
            t.finished?.catch?.(() => {});
          } catch {
            // startViewTransition can throw synchronously in an invalid state.
            void original(href).finally(done);
          }
        });
      };
    }
  },
};
