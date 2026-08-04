import { useEffect, useRef, useState } from 'react';

export function useClampedPage(pageCount: number): [number, (page: number) => void] {
  const [page, setPage] = useState(0);
  useEffect(() => {
    if (page > pageCount - 1) setPage(pageCount - 1);
  }, [page, pageCount]);
  return [Math.min(page, pageCount - 1), setPage];
}

export function useTransientFlag(ms: number): {
  on: boolean;
  fire: () => void;
  reset: () => void;
} {
  const [on, setOn] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );
  return {
    on,
    fire: () => {
      clear();
      setOn(true);
      timer.current = setTimeout(() => setOn(false), ms);
    },
    reset: () => {
      clear();
      setOn(false);
    },
  };
}
