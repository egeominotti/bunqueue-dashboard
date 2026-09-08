/** Bound both pipe buffering and the final allocation before decoding a child response. */
export async function readBoundedBytes(stream: ReadableStream<Uint8Array>, limit: number): Promise<Buffer> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > limit) throw new Error('Database process output exceeded its byte limit');
      chunks.push(next.value);
    }
    return Buffer.concat(chunks, bytes);
  } finally {
    reader.releaseLock();
  }
}
