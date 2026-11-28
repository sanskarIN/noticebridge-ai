import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { admitCollectionDocument, checkCollectionFile, collectionCitation, collectionStats, collectionSteps,
  loadCollectionEvidence, loadCollectionPlan, normalizeCollectionStep, parseCollectionPlan,
  prepareCollectionFile, replayCollectionSteps, runCollectionStep, serializeCollectionEvidence,
  serializeCollectionPlan, verifyCollectionEvidence, MAX_COLLECTION_BYTES, MAX_COLLECTION_DOCUMENTS,
  MAX_COLLECTION_FILE_BYTES, MAX_COLLECTION_PLAN_BYTES, MAX_COLLECTION_REPORT_BYTES, MAX_COLLECTION_TURNS,
  type CollectionDocument, type CollectionStep, type CollectionExtractor } from '../src/pdfChatCollection';
import type { Corpus, Passage } from '../src/pdfChatCore';

const signal = () => new AbortController().signal;
function pdf(bytes: string, name = 'same.pdf') { return new File([bytes], name, { type: 'application/pdf' }); }
function corpus(lines: string[], pageCount = 1, limited = false): Corpus {
  return { passages: lines.map((text, i): Passage => ({ role: 'original', page: 1, ordinal: i + 1, text })),
    pageCount, processedPages: 1, missingPages: lines.length ? [] : [1], limited, limitedPages: [] };
}
const extractor = (lines: string[], pageCount = 1, limited = false): CollectionExtractor =>
  async () => corpus(lines, pageCount, limited);
async function add(docs: CollectionDocument[], bytes: string, lines: string[], name = 'same.pdf') {
  return admitCollectionDocument(docs, pdf(bytes, name), signal(), extractor(lines));
}
async function fixture() {
  const a = await add([], 'document A', ['Application fee: INR 500', 'Rural applicants']);
  const b = await add([a], 'document B', ['Application fee: INR 350', 'Residence certificate']);
  const c = await add([a, b], 'document C', ['Eligibility: Class 12']);
  return [a, b, c];
}
function question(docs: CollectionDocument[], text = 'Application fee?', includeContext = true): CollectionStep {
  return { question: text, documentIds: docs.map(doc => doc.id), includeContext };
}

test('fingerprint binds immutable bytes independently of private filenames', async () => {
  const input = pdf('document bytes', 'private name.pdf');
  const prepared = await prepareCollectionFile(input, signal());
  expect(prepared.id).toBe(createHash('sha256').update('document bytes').digest('hex'));
  expect(prepared.file).not.toBe(input);
  expect(await prepared.file.text()).toBe('document bytes');
  expect(prepared.file.name).toBe(input.name);
  expect((await prepareCollectionFile(pdf('document bytes', 'other.pdf'), signal())).id).toBe(prepared.id);
});
test('duplicate content is rejected before extraction and same filenames are not merged', async () => {
  const a = await add([], 'same bytes', ['First']);
  let called = false;
  await expect(admitCollectionDocument([a], pdf('same bytes', 'renamed.pdf'), signal(), async () => {
    called = true;
    return corpus(['Changed']);
  })).rejects.toMatchObject({ code: 'duplicate' });
  expect(called).toBe(false);
  const b = await add([a], 'different bytes', ['Second']);
  expect(a.file.name).toBe(b.file.name);
  expect(a.id).not.toBe(b.id);
  expect(collectionStats([a, b]).documents).toBe(2);
});
test('rejects invalid file and oversized collection before extraction', async () => {
  const never: CollectionExtractor = async () => { throw new Error('unexpected extraction'); };
  for (const file of [pdf('', 'empty.pdf'), pdf('text', 'text.txt'),
    new File([new Uint8Array(MAX_COLLECTION_FILE_BYTES + 1)], 'large.pdf')]) {
    await expect(admitCollectionDocument([], file, signal(), never)).rejects.toMatchObject({ code: 'file' });
  }
  const docs: CollectionDocument[] = [];
  for (let i = 0; i < MAX_COLLECTION_DOCUMENTS; i++) docs.push(await add(docs, String(i), []));
  expect(() => checkCollectionFile(docs, pdf('extra'))).toThrow('budget');
  expect(collectionStats(docs).documents).toBe(MAX_COLLECTION_DOCUMENTS);
});
test('checks aggregate bytes even when each file is individually valid', async () => {
  const first = await add([], 'a', []);
  const second = await add([first], 'b', []);
  const large = new File([new Uint8Array(MAX_COLLECTION_FILE_BYTES)], 'large.pdf');
  const existing = [{ ...first, file: large }, { ...second, file: large }];
  expect(collectionStats(existing).bytes).toBe(2 * MAX_COLLECTION_FILE_BYTES);
  expect(() => checkCollectionFile(existing, large)).toThrow('budget');
  expect(() => checkCollectionFile(existing,
    new File([new Uint8Array(MAX_COLLECTION_BYTES - 2 * MAX_COLLECTION_FILE_BYTES)], 'fits.pdf'))).not.toThrow();
});
test('malformed extraction never enters the collection', async () => {
  const invalid: Corpus[] = [
    { ...corpus(['One']), missingPages: [1] },
    { ...corpus(['One']), processedPages: 0 },
    { ...corpus(['One']), passages: [{ role: 'revised', page: 1, ordinal: 1, text: 'One' }] },
    { ...corpus(['One']), passages: [{ role: 'original', page: 2, ordinal: 1, text: 'One' }] },
    { ...corpus(['One']), passages: [{ role: 'original', page: 1, ordinal: 1, text: ' x ' }] },
    { ...corpus(['One']), passages: [{ role: 'original', page: 1, ordinal: 1, text: 'x'.repeat(901) }] },
    { ...corpus(['One']), passages: [{ role: 'original', page: 1, ordinal: 1, text: '\ud800' }] },
  ];
  for (const value of invalid) {
    await expect(admitCollectionDocument([], pdf('bytes'), signal(), async () => value))
      .rejects.toMatchObject({ code: 'extraction' });
  }
});
test('late extraction cannot commit after cancellation', async () => {
  const controller = new AbortController();
  await expect(admitCollectionDocument([], pdf('data'), controller.signal, async () => {
    controller.abort();
    return corpus(['Never admitted']);
  })).rejects.toThrow('abort');
  const stopped = new AbortController();
  stopped.abort();
  await expect(prepareCollectionFile(pdf('data'), stopped.signal)).rejects.toThrow('abort');
});
test('same page and ordinal in separate documents never collapse or share citation identity', async () => {
  const docs = await fixture();
  const turn = runCollectionStep(docs, question(docs));
  expect(turn.results.map(result => result.documentId)).toEqual(docs.map(doc => doc.id));
  expect(turn.results.map(result => result.parts[0].answer.citations.map(row => row.text))).toEqual([
    ['Application fee: INR 500'], ['Application fee: INR 350'], [],
  ]);
  expect(turn.results[2].parts[0].answer.kind).toBe('insufficient');
  const first = turn.results[0].parts[0].answer.citations[0];
  expect(collectionCitation(docs, docs[0].id, first).file).toBe(docs[0].file);
  expect(() => collectionCitation(docs, docs[1].id, first)).toThrow('source fragment');
  expect(() => collectionCitation(docs, docs[0].id, { ...first })).toThrow('source fragment');
});
test('explicit document selection and order are retained without global rank fusion', async () => {
  const docs = await fixture();
  const selected = [docs[2], docs[0]];
  const turn = runCollectionStep(docs, question(selected));
  expect(turn.results.map(result => result.documentId)).toEqual(selected.map(doc => doc.id));
  expect(turn.results[0].parts[0].answer.kind).toBe('insufficient');
  expect(turn.results[1].parts[0].answer.printedFields[0].value).toBe('INR 500');
  expect(turn.results[1].parts[0].answer.matchedCounts.original).toBe(1);
});
test('nearby-line fallback never joins fragments across unrelated PDFs', async () => {
  const docs = await fixture();
  const turn = runCollectionStep(docs, question(docs, 'rural residence certificate'));
  expect(turn.results.every(result => result.parts[0].answer.kind === 'insufficient')).toBe(true);
  const joined = await add(docs, 'document D', ['Rural applicants', 'Residence certificate']);
  const result = runCollectionStep([...docs, joined], question([joined], 'rural residence certificate'));
  expect(result.results[0].parts[0].answer.citations).toEqual(joined.corpus.passages);
  expect(result.results[0].parts[0].answer.printedFields).toEqual([]);
});
test('physical page and coverage stay independent per document', async () => {
  const a = await add([], 'A', ['Application fee: INR 500']);
  const b = await admitCollectionDocument([a], pdf('B'), signal(), extractor(['Application fee: INR 300'], 3, true));
  const c = await admitCollectionDocument([a, b], pdf('C'), signal(), extractor([]));
  const docs = [a, b, c];
  const result = runCollectionStep(docs, question(docs, 'Application fee on page 2?'));
  expect(result.results.map(row => row.parts[0].coverage)).toEqual(['not_present', 'not_indexed', 'not_present']);
  expect(result.results.every(row => row.parts[0].answer.citations.length === 0)).toBe(true);
  const first = runCollectionStep(docs, question(docs, 'Application fee on page 1?'));
  expect(first.results.map(row => row.parts[0].coverage)).toEqual(['some_text', 'some_text', 'no_indexed_text']);
  expect(runCollectionStep(docs, question(docs)).results.map(row => row.parts[0].coverage))
    .toEqual(['some_text', 'partial', 'no_indexed_text']);
});
test('compound questions retain one result per part and per document', async () => {
  const docs = await fixture();
  const result = runCollectionStep(docs, question(docs, 'Application fee? Eligibility?'));
  expect(result.results.map(row => row.parts.map(part => part.answer.kind))).toEqual([
    ['passages', 'insufficient'], ['passages', 'insufficient'], ['insufficient', 'passages'],
  ]);
});
test('rejects ambiguous version routing, change intent and malformed query plans', async () => {
  const docs = await fixture();
  for (const text of ['Application fee in the revised notice?', 'Application fee in both PDFs?',
    'Application fee on page 0?', 'Application fee on page 1-2?', 'a?b?c?d?e?',
    ' ', ' x ', 'x'.repeat(401), '\ud800']) {
    expect(() => runCollectionStep(docs, question(docs, text))).toThrow();
  }
  for (const documentIds of [[], [docs[0].id, docs[0].id], ['a'.repeat(64)], ['invalid']]) {
    expect(() => runCollectionStep(docs, { ...question(docs), documentIds })).toThrow();
  }
  expect(() => normalizeCollectionStep({ ...question(docs), extra: 'field' }, docs.map(doc => doc.id))).toThrow();
});
test('private plan contains questions and hashes, not filenames, excerpts or answers', async () => {
  const docs = await fixture();
  const steps = [question([docs[1], docs[0]]), question([docs[2]], 'Eligibility?')];
  const text = serializeCollectionPlan(docs, steps);
  expect(text).not.toContain('same.pdf');
  expect(text).not.toContain('INR 500');
  expect(text).not.toContain('citations');
  expect(parseCollectionPlan(text, [...docs].reverse())).toEqual(steps);
  expect(collectionSteps(replayCollectionSteps(docs, parseCollectionPlan(text, docs)))).toEqual(steps);
  await expect(loadCollectionPlan(new File([text], 'plan.json'), docs)).resolves.toEqual(steps);
});
test('plan replay refuses different or missing PDF bytes, including additional attachments', async () => {
  const docs = await fixture();
  const text = serializeCollectionPlan(docs, [question(docs)]);
  const other = await add(docs, 'other', []);
  for (const changed of [docs.slice(1), [...docs, other], [docs[0], docs[1], other]]) {
    expect(() => parseCollectionPlan(text, changed)).toThrow('fingerprints');
  }
});
test('plan parser rejects duplicate JSON keys, unexpected answer fields and noncanonical order', async () => {
  const docs = await fixture();
  const text = serializeCollectionPlan(docs, [question(docs)]);
  const value = JSON.parse(text);
  for (const invalid of [text.trim(), text.replace('"version": 1,', '"version": 1, "version": 1,'),
    JSON.stringify({ ...value, answers: [] }, null, 2) + '\n',
    JSON.stringify({ ...value, source_ids: [...value.source_ids].reverse() }, null, 2) + '\n']) {
    expect(() => parseCollectionPlan(invalid, docs)).toThrow();
  }
  await expect(loadCollectionPlan(new File([new Uint8Array([0xff])], 'invalid.json'), docs)).rejects.toThrow();
  expect(() => parseCollectionPlan('x'.repeat(MAX_COLLECTION_PLAN_BYTES + 1), docs)).toThrow();
  expect(() => serializeCollectionPlan(docs, Array(MAX_COLLECTION_TURNS + 1).fill(question(docs)))).toThrow();
});
test('evidence report recomputes literal text and requires exact replay without filenames', async () => {
  const docs = await fixture();
  const steps = [question(docs)];
  const text = serializeCollectionEvidence(docs, steps);
  expect(text).toContain('INR 500');
  expect(text).toContain('INR 350');
  expect(text).not.toContain('same.pdf');
  expect(verifyCollectionEvidence(text, [...docs].reverse())).toEqual({
    questions: 1, documents: 3, authorityVerified: false,
  });
  await expect(loadCollectionEvidence(new File([text], 'report.json'), docs))
    .resolves.toEqual({ questions: 1, documents: 3, authorityVerified: false });
});
test('altered report citations, roles, authority and results cannot verify', async () => {
  const docs = await fixture();
  const text = serializeCollectionEvidence(docs, [question(docs)]);
  const value = JSON.parse(text);
  for (const mutate of [
    (v: any) => { v.authority_verified = true; },
    (v: any) => { v.questions[0].results[0].parts[0].citations[0].text = 'INR 999'; },
    (v: any) => { v.questions[0].results[0].parts[0].strict_match_count++; },
    (v: any) => { v.questions[0].results[0].document_id = docs[1].id; },
    (v: any) => { v.questions[0].results.reverse(); },
    (v: any) => { v.questions[0].results[0].parts[0].coverage = 'partial'; },
    (v: any) => { v.questions[0].results[0].parts[0].citations[0].ordinal = 7; },
    (v: any) => { v.questions[0].results.pop(); },
  ]) {
    const edited = structuredClone(value);
    mutate(edited);
    expect(() => verifyCollectionEvidence(JSON.stringify(edited, null, 2) + '\n', docs)).toThrow();
  }
  expect(() => verifyCollectionEvidence(text.replace('"version": 1,', '"version": 1, "version": 1,'), docs)).toThrow();
  expect(() => verifyCollectionEvidence('x'.repeat(MAX_COLLECTION_REPORT_BYTES + 1), docs)).toThrow();
});
test('report replay is distinct from matching PDF fingerprints when extraction changes', async () => {
  const docs = await fixture();
  const text = serializeCollectionEvidence(docs, [question(docs)]);
  const changed = await add([], 'document A', ['Application fee: INR 700']);
  expect(changed.id).toBe(docs[0].id);
  expect(() => verifyCollectionEvidence(text, [changed, ...docs.slice(1)])).toThrow();
  expect(parseCollectionPlan(serializeCollectionPlan(docs, [question(docs)]),
    [changed, ...docs.slice(1)])).toEqual([question(docs)]);
});
