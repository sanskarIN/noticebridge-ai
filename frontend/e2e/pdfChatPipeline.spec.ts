import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { answerQuestion, buildIndex, type Passage } from '../src/pdfChatCore';
import { preparePipeline, pipelineSelection, reviewPipeline, MAX_PIPELINE_RESULT_BYTES } from '../src/pdfChatPipeline';

const rows: Passage[] = [
  { role: 'original', page: 1, ordinal: 1, text: '😀 Application fee: INR 500 unless exempt.' },
  { role: 'original', page: 2, ordinal: 1, text: 'Eligibility: Class 12' },
  { role: 'revised', page: 1, ordinal: 1, text: 'Application fee: INR 350' },
];
const index = buildIndex(rows);
const answer = answerQuestion(index, 'Application fee?', 'both');
const request = preparePipeline(index, answer, 'full');
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const encode = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
const digest = sha(request.text);
const ranks = { original: ['original:2:1', 'original:1:1'], revised: ['revised:1:1'] };
const selected = pipelineSelection(request, ranks);
const start = rows[0].text.indexOf('INR 500');
const raw = {
  format: 'noticebridge-chat-pipeline-result', version: 1, request_sha256: digest,
  ranking: { format: 'noticebridge-chat-embedding-result', version: 1,
    request_sha256: sha(request.embedding.text), model: 'embedding:latest',
    model_digest: 'a'.repeat(64), dimension: 2, candidate_count: 3, ranks, authority_verified: false },
  extractive: { format: 'noticebridge-chat-extractive-result', version: 1,
    request_sha256: sha(selected.text), model: 'answer:latest', model_digest: 'b'.repeat(64),
    proposal: { status: 'extract', spans: [{ id: 'original:1:1', start, end: start + 7 }] },
    authority_verified: false },
  authority_verified: false,
};
test('combined protocol checks both bindings and reconstructs original quote', async () => {
  const result = await reviewPipeline(encode(raw), request, digest);
  expect(result.selectionCount).toBe(3);
  expect(result.extractive.proposal.spans[0].text).toBe('INR 500');
  expect(result.extractive.proposal.spans[0].source).toBe(rows[0]);
  expect(result.extractive.missingRoles).toEqual(['revised']);
  expect(answer.citations).toEqual([rows[0], rows[2]]);
});
test('pipeline selection retains baseline order before dense ranks', () => {
  expect([...selected.allowed.keys()]).toEqual(['original:1:1', 'revised:1:1', 'original:2:1']);
});
test('valid abstention preserves all baseline citations', async () => {
  const result = await reviewPipeline(encode({ ...raw, extractive: { ...raw.extractive,
    proposal: { status: 'insufficient', spans: [] } } }), request, digest);
  expect(result.extractive.omittedBaseline).toEqual(answer.citations);
  expect(result.extractive.proposal.spans).toEqual([]);
});
for (const [name, value] of [
  ['outer hash', { ...raw, request_sha256: 'c'.repeat(64) }],
  ['embedding hash', { ...raw, ranking: { ...raw.ranking, request_sha256: 'c'.repeat(64) } }],
  ['selection hash', { ...raw, extractive: { ...raw.extractive, request_sha256: 'c'.repeat(64) } }],
  ['cross-source rank', { ...raw, ranking: { ...raw.ranking, ranks: { ...ranks, original: ['revised:1:1', 'original:1:1'] } } }],
  ['unknown quote', { ...raw, extractive: { ...raw.extractive, proposal: {
    status: 'extract', spans: [{ id: 'original:99:1', start: 0, end: 3 }] } } }],
  ['authority', { ...raw, authority_verified: true }],
  ['extra field', { ...raw, answer: 'invented' }],
]) {
  test('rejects ' + name, async () => {
    await expect(reviewPipeline(encode(value), request, digest)).rejects.toThrow();
  });
}
test('canonical outer result rejects duplicate keys and oversized data', async () => {
  await expect(reviewPipeline(encode(raw).replace('"version": 1,', '"version": 1, "version": 1,'), request, digest)).rejects.toThrow();
  await expect(reviewPipeline('x'.repeat(MAX_PIPELINE_RESULT_BYTES + 1), request, digest)).rejects.toThrow();
  await expect(reviewPipeline(encode(raw), request, 'd'.repeat(64))).rejects.toThrow();
});
test('new question cannot replay prior result', async () => {
  const next = preparePipeline(index, answerQuestion(index, 'Eligibility?', 'original'), 'full');
  await expect(reviewPipeline(encode(raw), next, sha(next.text))).rejects.toThrow();
});

test('Python pipeline emits an independently verifiable Unicode result', async () => {
  // Execute the actual Python request parser, candidate selection,
  // UTF-16 span validator, result serializer and mocked local HTTP pipeline.
  // No installed model or network service is required for this protocol test.
  const program = [
    'import asyncio, json, sys, httpx',
    'from noticebridge.chat_pipeline import parse_request, run_pipeline, encode',
    'request = parse_request(sys.stdin.buffer.read())',
    'class Stream(httpx.AsyncByteStream):',
    '    def __init__(self, payload): self.payload = payload',
    '    async def __aiter__(self): yield json.dumps(self.payload).encode()',
    'def reply(payload): return httpx.Response(200, stream=Stream(payload))',
    'def handler(req):',
    '    assert req.url.host == "127.0.0.1"',
    '    if req.url.path == "/api/tags":',
    '        return reply({"models": [{"name": "embedding:latest", "digest": "a"*64},',
    '                                 {"name": "answer:latest", "digest": "b"*64}]})',
    '    payload = json.loads(req.content)',
    '    if req.url.path == "/api/embed":',
    '        return reply({"model": "embedding:latest", "embeddings": [[1, 0] for _ in payload["input"]]})',
    '    assert req.url.path == "/api/generate"',
    '    candidates = json.loads(payload["prompt"])["candidates"]',
    '    assert [row["id"] for row in candidates][:2] == list(request.baseline)',
    '    return reply({"model": "answer:latest", "done": True, "done_reason": "stop",',
    '                  "response": json.dumps({"status": "extract",',
    '                    "quotes": [{"id": "original:1:1", "quote": "INR 500"}]})})',
    'result = asyncio.run(run_pipeline(request, embedding_model="embedding:latest",',
    '    embedding_digest="a"*64, answer_model="answer:latest", answer_digest="b"*64,',
    '    consent=True, _transport=httpx.MockTransport(handler)))',
    'sys.stdout.buffer.write(encode(result))',
  ].join('\n');
  const bytes = execFileSync(process.env.PYTHON || 'python', ['-c', program], {
    input: request.text, maxBuffer: MAX_PIPELINE_RESULT_BYTES, timeout: 20000,
  }).toString('utf8');
  const result = await reviewPipeline(bytes, request, digest);
  expect(result.extractive.proposal.spans[0].text).toBe('INR 500');
  expect(result.extractive.proposal.spans[0].start).toBe(start);
  expect(result.extractive.proposal.spans[0].source).toBe(rows[0]);
  expect(bytes).not.toContain('INR 500');
  expect(result.selectionCount).toBe(3);
});

test('direct pipeline uses exact multipart binding and selected metadata', async () => {
  const { requestLocalPipeline } = await import('../src/pdfChatLocalPipeline');
  const config = { embeddingModel: 'embedding:latest', embeddingDigest: 'a'.repeat(64),
    answerModel: 'answer:latest', answerDigest: 'b'.repeat(64) };
  const controller = new AbortController();
  const result = await requestLocalPipeline(request, config, controller.signal, true,
    async (service, body, signal) => {
      expect(service).toBe('pipeline');
      expect(signal).toBe(controller.signal);
      expect(await (body.get('request_file') as Blob).text()).toBe(request.text);
      expect(body.get('embedding_model')).toBe(config.embeddingModel);
      expect(body.get('embedding_digest')).toBe(config.embeddingDigest);
      expect(body.get('answer_model')).toBe(config.answerModel);
      expect(body.get('answer_digest')).toBe(config.answerDigest);
      expect(body.get('consent')).toBe('true');
      return encode(raw);
    });
  expect(result.extractive.proposal.spans[0].text).toBe('INR 500');
});
test('direct pipeline refuses missing consent, malformed model metadata and aborted request before transport', async () => {
  const { requestLocalPipeline } = await import('../src/pdfChatLocalPipeline');
  const config = { embeddingModel: 'embedding:latest', embeddingDigest: 'a'.repeat(64),
    answerModel: 'answer:latest', answerDigest: 'b'.repeat(64) };
  const never = async () => { throw new Error('unexpected transport'); };
  const signal = new AbortController().signal;
  await expect(requestLocalPipeline(request, config, signal, false, never)).rejects.toThrow('Invalid');
  for (const change of [{ answerModel: 'remote:cloud' }, { embeddingModel: 'https://host/model:tag' },
    { answerDigest: 'invalid' }, { embeddingDigest: 'A'.repeat(64) }]) {
    await expect(requestLocalPipeline(request, { ...config, ...change }, signal, true, never)).rejects.toThrow('Invalid');
  }
  const controller = new AbortController();
  controller.abort();
  await expect(requestLocalPipeline(request, config, controller.signal, true, never)).rejects.toThrow('abort');
});
test('direct pipeline rejects a valid but differently configured result', async () => {
  const { requestLocalPipeline } = await import('../src/pdfChatLocalPipeline');
  const config = { embeddingModel: 'embedding:latest', embeddingDigest: 'a'.repeat(64),
    answerModel: 'answer:latest', answerDigest: 'b'.repeat(64) };
  for (const output of [{ ...raw, ranking: { ...raw.ranking, model_digest: 'c'.repeat(64) } },
    { ...raw, extractive: { ...raw.extractive, model: 'different:latest' } }]) {
    await expect(requestLocalPipeline(request, config, new AbortController().signal, true,
      async () => encode(output))).rejects.toThrow('selected model metadata');
  }
});
test('direct pipeline discards response after cancellation', async () => {
  const { requestLocalPipeline } = await import('../src/pdfChatLocalPipeline');
  const controller = new AbortController();
  await expect(requestLocalPipeline(request, { embeddingModel: 'embedding:latest',
    embeddingDigest: 'a'.repeat(64), answerModel: 'answer:latest', answerDigest: 'b'.repeat(64) },
  controller.signal, true, async () => { controller.abort(); return encode(raw); })).rejects.toThrow('abort');
});
