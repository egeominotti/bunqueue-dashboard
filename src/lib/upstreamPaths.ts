/** Queue grammar accepted by Bunqueue v2.8.57. */
const QUEUE_NAME_RE = /^[a-zA-Z0-9_\-.:]+$/;

/**
 * Validate a queue before it is interpolated into an upstream HTTP route.
 *
 * Bunqueue accepts dots in ordinary queue names, but the exact path segments
 * `.` and `..` are not transportable: WHATWG URL parsing removes them before
 * `fetch` sends the request. Treating either as manageable would therefore
 * target a different endpoint from the queue the operator entered.
 */
export function queueHttpPathError(queue: string): string | null {
  if (typeof queue !== 'string' || !queue) return 'Queue name must not be empty';
  if (queue.length > 256) return 'Queue name must be 256 characters or fewer';
  if (!QUEUE_NAME_RE.test(queue)) {
    return 'Queue names may contain only letters, numbers, underscore, hyphen, dot, and colon';
  }
  if (queue === '.' || queue === '..') {
    return 'Queue name must not be "." or ".." because URL parsers treat it as a path traversal segment';
  }
  return null;
}

/** A validated, encoded segment for Bunqueue routes that decode queue params. */
export function queueHttpPathSegment(queue: string): string {
  const error = queueHttpPathError(queue);
  if (error) throw new TypeError(error);
  return encodeURIComponent(queue);
}

/**
 * Validate a value used by an upstream route which decodes its captured path
 * parameter. Encoded slashes and punctuation round-trip through those routes,
 * but WHATWG URL parsing removes exact `.` / `..` segments before the request
 * reaches Bunqueue. Lone UTF-16 surrogates are also not encodable.
 */
export function decodedHttpPathError(
  value: string,
  label = 'Resource ID',
  maxLength = 1024
): string | null {
  if (typeof value !== 'string' || !value) return `${label} must not be empty`;
  if (value.length > maxLength) return `${label} must be ${maxLength} characters or fewer`;
  if (value === '.' || value === '..') {
    return `${label} must not be "." or ".." because URL parsers treat it as a path traversal segment`;
  }
  try {
    encodeURIComponent(value);
  } catch {
    return `${label} must contain valid Unicode text`;
  }
  return null;
}

/** A validated, encoded segment for routes that call decodeURIComponent. */
export function decodedHttpPathSegment(
  value: string,
  label = 'Resource ID',
  maxLength = 1024
): string {
  const error = decodedHttpPathError(value, label, maxLength);
  if (error) throw new TypeError(error);
  return encodeURIComponent(value);
}

/**
 * v2.8.57 reads several resource ids from `URL.pathname` without decoding the
 * captured segment. Only characters that survive WHATWG URL parsing verbatim
 * and do not introduce a slash can therefore round-trip. Percent, square
 * brackets, and pipe are deliberately included: Bun's URL implementation
 * preserves them byte-for-byte in pathname and the v2.8.57 router treats them
 * as ordinary opaque id bytes.
 */
const OPAQUE_HTTP_ID_RE = /^[A-Za-z0-9._~!$&'()*+,;=:@%[\]|-]+$/;
const WHATWG_DOT_SEGMENT_RE = /^(?:\.|%2e){1,2}$/i;

export function opaqueHttpIdError(id: string): string | null {
  if (typeof id !== 'string' || !id) return 'ID must not be empty';
  if (id.length > 1024) return 'ID must be 1024 characters or fewer';
  if (!OPAQUE_HTTP_ID_RE.test(id)) {
    return "Bunqueue v2.8.57 HTTP can address only opaque path-safe IDs (letters, numbers, and . _ ~ ! $ & ' ( ) * + , ; = : @ % [ ] | -); spaces, slash, backslash, ? and # are unsupported";
  }
  if (WHATWG_DOT_SEGMENT_RE.test(id)) {
    return 'ID must not resolve to "." or ".." because URL parsers treat it as a path traversal segment';
  }
  return null;
}

export function opaqueHttpPathSegment(id: string): string {
  const error = opaqueHttpIdError(id);
  if (error) throw new TypeError(error);
  return id;
}

/**
 * The queue-specific SSE router also fails to decode its suffix. Queue names
 * have a stricter grammar, so a validated name can safely be inserted verbatim
 * and `foo:bar` will still match the emitted event queue.
 */
export function eventQueuePathSegment(queue: string): string {
  const error = queueHttpPathError(queue);
  if (error) throw new TypeError(`Invalid Bunqueue queue name for the event stream: ${error}`);
  return queue;
}
