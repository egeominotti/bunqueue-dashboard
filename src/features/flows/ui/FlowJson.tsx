export function FlowJson({ value }: { value: unknown }) {
  return (
    <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md border border-line bg-bg p-3 font-mono text-xs text-muted">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}
