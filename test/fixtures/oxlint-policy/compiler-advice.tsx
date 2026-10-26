import { useEffect, useRef, useState } from 'react';

export function CompilerAdvice({ version }: { version: number }) {
  const last = useRef(version);
  if (last.current !== version) last.current = version;
  const [seen, setSeen] = useState(version);
  useEffect(() => setSeen(version), [version]);
  return <span>{last.current}:{seen}</span>;
}
