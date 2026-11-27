import { expect, test } from '@playwright/test';
import { emptyLocalPipelineConfig } from '../src/pdfChatLocalPipeline';
import { parseLocalModelInventory, requestLocalModelInventory, inventoryChoice, selectedInventoryTag,
  MAX_LOCAL_MODELS, MAX_MODEL_INVENTORY_BYTES } from '../src/pdfChatModelInventory';

const origin = 'http://127.0.0.1:5173';
const signal = () => new AbortController().signal;
const value = {
  format: 'noticebridge-local-model-inventory', version: 1,
  runtime_reported_only: true, authority_verified: false,
  reported_count: 3, excluded_count: 1,
  models: [{ name: 'answer:latest', digest: 'a'.repeat(64) },
    { name: 'embedding:latest', digest: 'b'.repeat(64) }],
};
const encode = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
const response = (text = encode(value)) => new Response(text, { headers: { 'Content-Type': 'application/json' } });

test('inventory parser accepts only bounded canonical local pin metadata', () => {
  expect(parseLocalModelInventory(encode(value))).toEqual(value);
  expect(parseLocalModelInventory(encode({ ...value, reported_count: 0, excluded_count: 0, models: [] })))
    .toMatchObject({ models: [], authority_verified: false, runtime_reported_only: true });
});
const edits: [string, (v: any) => void][] = [
  ['authority claim', v => v.authority_verified = true],
  ['offline guarantee', v => v.runtime_reported_only = false],
  ['format', v => v.format = 'other'],
  ['version', v => v.version = 2],
  ['extra metadata', v => v.runtime = 'example'],
  ['count mismatch', v => v.reported_count = 2],
  ['negative count', v => v.excluded_count = -1],
  ['fractional count', v => v.excluded_count = 0.5],
  ['non-numeric count', v => v.reported_count = '3'],
  ['too many entries', v => v.reported_count = MAX_LOCAL_MODELS + 1],
  ['invalid digest', v => v.models[0].digest = 'bad'],
  ['uppercase digest', v => v.models[0].digest = 'A'.repeat(64)],
  ['remote tag', v => v.models[0].name = 'cloud:latest'],
  ['URL tag', v => v.models[0].name = 'https://example.invalid'],
  ['missing tag', v => v.models[0].name = 'answer'],
  ['unknown model key', v => v.models[0].remote_host = 'example.invalid'],
  ['duplicate name', v => v.models[1].name = v.models[0].name],
  ['reversed order', v => v.models.reverse()],
];
for (const [name, mutate] of edits) {
  test('inventory rejects ' + name, () => {
    const raw = structuredClone(value);
    mutate(raw);
    expect(() => parseLocalModelInventory(encode(raw))).toThrow();
  });
}
test('duplicate JSON members, whitespace and byte limit fail closed', () => {
  const text = encode(value);
  expect(() => parseLocalModelInventory(text.replace('"version": 1', '"version": 1, "version": 1'))).toThrow();
  expect(() => parseLocalModelInventory(text.trim())).toThrow();
  expect(() => parseLocalModelInventory(JSON.stringify(value))).toThrow();
  expect(() => parseLocalModelInventory('x'.repeat(MAX_MODEL_INVENTORY_BYTES + 1))).toThrow();
});
test('selection explicitly copies both tag and digest and never changes the other purpose', () => {
  const inventory = parseLocalModelInventory(encode(value)), empty = emptyLocalPipelineConfig();
  expect(selectedInventoryTag(inventory, empty, 'embedding')).toBe('');
  const embedding = inventoryChoice(inventory, empty, 'embedding', 'embedding:latest');
  expect(embedding).toEqual({ embeddingModel: 'embedding:latest', embeddingDigest: 'b'.repeat(64),
    answerModel: '', answerDigest: '' });
  const both = inventoryChoice(inventory, embedding, 'answer', 'answer:latest');
  expect(both.answerModel).toBe('answer:latest');
  expect(both.answerDigest).toBe('a'.repeat(64));
  expect(both.embeddingDigest).toBe('b'.repeat(64));
  expect(selectedInventoryTag(inventory, both, 'answer')).toBe('answer:latest');
  expect(selectedInventoryTag(inventory, { ...both, answerDigest: 'c'.repeat(64) }, 'answer')).toBe('');
  expect(() => inventoryChoice(inventory, empty, 'embedding', 'unknown:latest')).toThrow();
  expect(empty).toEqual(emptyLocalPipelineConfig());
});
test('read-only inventory sends no PDF, question, credentials, query parameters or request body', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async (url, options) => {
    calls++;
    expect(url).toBe('/api/chat/models');
    expect(options?.method).toBe('GET');
    expect(options?.body).toBeUndefined();
    expect(options?.credentials).toBe('omit');
    expect(options?.redirect).toBe('error');
    expect(options?.cache).toBe('no-store');
    expect([...new Headers(options?.headers)]).toEqual([['x-noticebridge-local-ai', '1']]);
    return response();
  };
  expect(await requestLocalModelInventory(signal(), true, origin, fetcher)).toEqual(value);
  expect(calls).toBe(1);
});
test('nonlocal origins and unapproved or aborted requests cannot invoke transport', async () => {
  const never: typeof fetch = async () => { throw new Error('unexpected fetch'); };
  await expect(requestLocalModelInventory(signal(), false, origin, never)).rejects.toThrow('approved loopback');
  await expect(requestLocalModelInventory(signal(), true, 'https://example.invalid', never)).rejects.toThrow('approved loopback');
  const controller = new AbortController();
  controller.abort();
  await expect(requestLocalModelInventory(controller.signal, true, origin, never)).rejects.toThrow();
});
test('redirect and mismatched response destinations fail before decoding', async () => {
  for (const options of [{ redirected: true }, { url: 'https://example.invalid/api/chat/models' },
    { url: origin + '/api/other' }]) {
    const redirected = response();
    for (const [key, value] of Object.entries(options)) Object.defineProperty(redirected, key, { value });
    await expect(requestLocalModelInventory(signal(), true, origin, async () => redirected)).rejects.toThrow();
  }
});
test('bounded reader and parser reject malformed remote responses', async () => {
  const bad = [
    new Response('bad', { status: 503 }),
    new Response('bad', { headers: { 'Content-Type': 'text/html' } }),
    response('x'.repeat(MAX_MODEL_INVENTORY_BYTES + 1)),
    response('{}'),
    new Response(new Uint8Array([0xff]), { headers: { 'Content-Type': 'application/json' } }),
  ];
  for (const result of bad) {
    await expect(requestLocalModelInventory(signal(), true, origin, async () => result)).rejects.toThrow();
  }
});
