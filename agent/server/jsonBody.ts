export interface LimitedJsonBodyOptions {
  scope: string;
  maxBytes: number;
  limitLabel: string;
  invalidContentLengthMessage?: string;
  exceedsMessage?: string;
  missingMessage?: string;
  invalidUtf8Message?: string;
  invalidJsonMessage?: string;
}

/** Read and parse a JSON body without ever buffering more than maxBytes. */
export async function readLimitedJsonBody(
  request: Request,
  options: LimitedJsonBodyOptions
): Promise<unknown> {
  validateContentLength(request.headers.get('content-length'), options);
  if (!request.body) throw new Error(message(options, 'missing'));

  const reader = request.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const textChunks: string[] = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      totalBytes += next.value.byteLength;
      if (totalBytes > options.maxBytes) {
        throw new Error(message(options, 'exceeds'));
      }
      textChunks.push(decode(decoder, next.value, true, options));
    }
    textChunks.push(decode(decoder, undefined, false, options));
  } catch (error) {
    await cancelQuietly(reader);
    throw error;
  } finally {
    reader.releaseLock();
  }

  if (totalBytes === 0) throw new Error(message(options, 'missing'));
  try {
    return JSON.parse(textChunks.join(''));
  } catch {
    throw new Error(message(options, 'invalidJson'));
  }
}

function validateContentLength(
  declared: string | null,
  options: LimitedJsonBodyOptions
): void {
  if (declared === null) return;
  if (!/^\d+$/.test(declared)) {
    throw new Error(message(options, 'invalidContentLength'));
  }
  const normalized = declared.replace(/^0+/, '') || '0';
  const maximum = String(options.maxBytes);
  if (
    normalized.length > maximum.length ||
    (normalized.length === maximum.length && normalized > maximum)
  ) {
    throw new Error(message(options, 'exceeds'));
  }
}

function decode(
  decoder: TextDecoder,
  value: Uint8Array | undefined,
  stream: boolean,
  options: LimitedJsonBodyOptions
): string {
  try {
    return decoder.decode(value, { stream });
  } catch {
    throw new Error(message(options, 'invalidUtf8'));
  }
}

async function cancelQuietly(reader: { cancel(reason?: unknown): Promise<void> }): Promise<void> {
  await reader.cancel().catch(() => undefined);
}

type MessageKind =
  | 'invalidContentLength'
  | 'exceeds'
  | 'missing'
  | 'invalidUtf8'
  | 'invalidJson';

function message(options: LimitedJsonBodyOptions, kind: MessageKind): string {
  if (kind === 'invalidContentLength') {
    return (
      options.invalidContentLengthMessage ??
      `${options.scope} Content-Length must be a non-negative integer`
    );
  }
  if (kind === 'exceeds') {
    return options.exceedsMessage ?? `${options.scope} request exceeds ${options.limitLabel}`;
  }
  if (kind === 'missing') {
    return options.missingMessage ?? `${options.scope} request body is required`;
  }
  if (kind === 'invalidUtf8') {
    return options.invalidUtf8Message ?? `${options.scope} request body must use valid UTF-8`;
  }
  return options.invalidJsonMessage ?? `${options.scope} request body must contain valid JSON`;
}
