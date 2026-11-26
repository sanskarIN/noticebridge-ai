/** Fixed same-origin loopback transport. No arbitrary service URLs or redirects. */
const ORIGINS = new Set([
  'http://localhost:5173', 'http://127.0.0.1:5173',
  'http://localhost:8000', 'http://127.0.0.1:8000',
]);
export function isLocalChatOrigin(origin: string): boolean { return ORIGINS.has(origin); }
const ENDPOINTS = {
  ocr: { path: '/api/chat/ocr', header: 'X-NoticeBridge-Local-OCR', maxBytes: 2 * 1024 * 1024 },
} as const;
export type LocalChatService = keyof typeof ENDPOINTS;

export async function readBoundedJson(response: Response, maximum: number): Promise<string> {
  if (!response.ok || !response.body ||
      !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
    throw new Error('Local service did not return a JSON result.');
  }
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d{1,10}$/.test(declared) || Number(declared) > maximum)) {
    throw new Error('Local service result exceeds its size limit.');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value || (total += value.byteLength) > maximum) {
        throw new Error('Local service result exceeds its size limit.');
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally { reader.releaseLock(); }
  if (!total) throw new Error('Empty local service result.');
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
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
  if (response.redirected || (response.url && response.url !== origin + endpoint.path)) {
    throw new Error('Unexpected local service destination.');
  }
  return readBoundedJson(response, endpoint.maxBytes);
}
