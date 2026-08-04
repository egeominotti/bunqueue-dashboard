export const MAX_JOB_DATA_CHARS = 10 * 1024 * 1024;
export const MAX_JOB_DATA_BYTES = 10 * 1024 * 1024;

export function utf8ByteLength(text: string, stopAfter = Number.POSITIVE_INFINITY): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index);
    if (unit <= 0x7f) {
      bytes += 1;
    } else if (unit <= 0x7ff) {
      bytes += 2;
    } else if (
      unit >= 0xd800 &&
      unit <= 0xdbff &&
      index + 1 < text.length &&
      text.charCodeAt(index + 1) >= 0xdc00 &&
      text.charCodeAt(index + 1) <= 0xdfff
    ) {
      bytes += 4;
      index += 1;
    } else {
      bytes += 3;
    }
    if (bytes > stopAfter) return bytes;
  }
  return bytes;
}

function jobDataBudgetError(text: string): string | null {
  if (
    text.length > MAX_JOB_DATA_CHARS ||
    utf8ByteLength(text, MAX_JOB_DATA_BYTES) > MAX_JOB_DATA_BYTES
  ) {
    return 'Job data is too large (maximum 10 MiB UTF-8 / 10,485,760 characters)';
  }
  return null;
}

export function parseJobData(
  text: string
): { ok: true; data: unknown } | { ok: false; kind: 'json' | 'size'; msg: string } {
  const inputBudgetError = jobDataBudgetError(text);
  if (inputBudgetError) return { ok: false, kind: 'size', msg: inputBudgetError };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { ok: false, kind: 'json', msg: `Invalid JSON: ${(error as Error).message}` };
  }

  const encoded = JSON.stringify(parsed);
  if (
    encoded.length > MAX_JOB_DATA_CHARS ||
    utf8ByteLength(encoded, MAX_JOB_DATA_BYTES) > MAX_JOB_DATA_BYTES
  ) {
    return {
      ok: false,
      kind: 'size',
      msg: 'Job data is too large after JSON encoding (maximum 10 MiB UTF-8)',
    };
  }
  return { ok: true, data: parsed };
}
