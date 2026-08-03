import { type RefObject, useLayoutEffect } from 'react';

/** Reset the app's inner scroll container after every router navigation. */
export function useRouteScrollReset(
  scrollRef: RefObject<HTMLElement | null>,
  navigationKey: string
): void {
  useLayoutEffect(() => {
    // Reading the key ties this layout effect to the completed navigation even
    // though only the scroll element itself needs to be mutated.
    void navigationKey;
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTop = 0;
    element.scrollLeft = 0;
  }, [navigationKey, scrollRef]);
}
