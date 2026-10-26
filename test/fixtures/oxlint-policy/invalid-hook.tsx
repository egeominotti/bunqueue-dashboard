import { useRef } from 'react';

export function InvalidHook({ enabled }: { enabled: boolean }) {
  if (enabled) useRef(0);
  return null;
}
