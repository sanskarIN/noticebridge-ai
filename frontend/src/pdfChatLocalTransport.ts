/** Fixed same-origin loopback transport. No arbitrary service URLs or redirects. */
const ORIGINS = new Set([
  'http://localhost:5173', 'http://127.0.0.1:5173',
  'http://localhost:8000', 'http://127.0.0.1:8000',
]);
export function isLocalChatOrigin(origin: string): boolean { return ORIGINS.has(origin); }
const ENDPOINTS = {
  pipeline: { path: '/api/chat/pipeline', header: 'X-NoticeBridge-Local-AI', maxBytes: 100 * 1024 },
  ocr: { path: '/api/chat/ocr', header: 'X-NoticeBridge-Local-OCR', maxBytes: 2 * 1024 * 1024 },
} as const;
export type LocalChatService = keyof typeof ENDPOINTS;

// Do not wait for an untrusted stream's underlying cancellation promise.
// Cancellation is best effort; the caller must still receive its error.
function discardBody(response: Response): void {
  if (response.body && !response.body.locked) {
    void response.body.cancel().catch(() => undefined);
  }
}

export async function readBoundedJson(response: Response, maximum: number,
  signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) {
    discardBody(response);
    signal.throwIfAborted();
  }
  if (!Number.isSafeInteger(maximum) || maximum <= 0 || !response.ok || !response.body ||
      !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
    discardBody(response);
    throw new Error('Local service did not return a bounded JSON result.');
  }
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d{1,10}$/.test(declared) || Number(declared) > maximum)) {
    discardBody(response);
    throw new Error('Local service result exceeds its size limit.');
  }
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  const chunks: Uint8Array[] = [];
  let total = 0;
  // Fetch normally aborts its body itself. Explicitly cancel the reader as
  // well, so a stalled or injected transport cannot keep this operation alive.
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    signal?.throwIfAborted();
    while (true) {
      const { value, done } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      if (!value || (total += value.byteLength) > maximum) {
        throw new Error('Local service result exceeds its size limit.');
      }
      // A chunk must represent progress: reject a pathological stream that
      // emits unlimited empty buffers without consuming the byte budget.
      if (!value.byteLength) throw new Error('Local service returned an empty chunk.');
      chunks.push(value);
    }
    if (!total) throw new Error('Empty local service result.');
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    signal?.throwIfAborted();
    return text;
  } catch (error) {
    cancel();
    throw error;
  } finally {
    signal?.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

/** Apply the same stale-response and destination checks to every local
 * service, including read-only discovery. Cancel rejected bodies. */
export function validateLocalResponse(response: Response, expectedUrl: string, signal: AbortSignal): void {
  if (signal.aborted) {
    discardBody(response);
    signal.throwIfAborted();
  }
  if (response.redirected || (response.url && response.url !== expectedUrl)) {
    discardBody(response);
    throw new Error('Unexpected local service destination.');
  }
}

export async function localChatRequest(service: LocalChatService, body: FormData,
  signal: AbortSignal, origin = globalThis.location?.origin, fetcher: typeof fetch = fetch): Promise<string> {
  if (!isLocalChatOrigin(origin ?? '') || !Object.prototype.hasOwnProperty.call(ENDPOINTS, service)) {
    throw new Error('Local service is restricted to supported loopback origins.');
  }
  const endpoint = ENDPOINTS[service];
  signal.throwIfAborted();
  const response = await fetcher(endpoint.path, {
    method: 'POST', body, signal, credentials: 'omit', redirect: 'error', cache: 'no-store',
    headers: { [endpoint.header]: '1' },
  });
  validateLocalResponse(response, origin + endpoint.path, signal);
  return readBoundedJson(response, endpoint.maxBytes, signal);
}
