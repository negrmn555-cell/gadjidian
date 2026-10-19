/** Incremental UTF-8 SSE decoder. Never accepts an unbounded frame. */
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader(), decoder = new TextDecoder();
  let buffer = '', ended = false;
  try {
    while (!ended) {
      const chunk = await reader.read();
      ended = chunk.done;
      buffer += decoder.decode(chunk.value, { stream: !ended });
      buffer = buffer.replace(/\r\n/g, '\n');
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        if (frame.length > 256_000) throw new Error('SSE frame too large');
        const data = frame.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).replace(/^ /, '')).join('\n');
        if (data) yield data;
      }
      if (buffer.length > 256_000) throw new Error('SSE frame too large');
    }
    if (buffer.trim()) throw new Error('Incomplete SSE frame');
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
