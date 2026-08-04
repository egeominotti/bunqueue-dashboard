/** Convert any thrown JavaScript value without invoking a failure-prone boundary. */
export function safeErrorMessage(error: unknown): string {
  try {
    const message = error instanceof Error ? error.message : String(error);
    return typeof message === 'string' && message.length > 0 ? message : 'Unknown error';
  } catch {
    return 'Unprintable error';
  }
}
