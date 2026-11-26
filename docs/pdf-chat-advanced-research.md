# Advanced PDF Chat research and engineering plan

Status: research design, 2026-11-25. Not a claim of deployed generative QA.

## Research question

Can semantic retrieval improve the recall of evidence for English official
notice questions without introducing unsupported answers, cross-version
leakage, or mandatory remote processing? A notice assistant must handle
exact dates and fees, exceptions to eligibility, amendments and tables.
Fluent text is not the primary success criterion: the user must be able
to inspect the actual PDF and understand uncertainty.

## Existing baseline and evidence

At commit c3cf8a19cd6f068637a1eed1c91e81452dc255e6, GitHub Actions run
45605111346 passed all four jobs. The browser job reported 163 tests
and two static showcase tests passing. The hand-authored 15-question
retrieval regression corpus returned the following:

| Measure | Strict | Adjacent-line |
| --- | --- | --- |
| Labeled citations retrieved | 11/17 | 17/17 |
| Complete relevant-citation sets | 7/9 | 9/9 |
| No-evidence questions abstained on | 6/6 | 6/6 |
| Retrieved citations judged relevant by fixture | 11/11 | 17/17 |

These are measurements from a tiny implementation-authored corpus,
not a held-out result or accuracy of generated answers. In particular,
an unanswerable question may contain the same tokens as an answerable
one; exact term coverage alone cannot identify entailment. The newer
overview and replay implementation needs its own verification.

## Literature and implications

### Sparse and dense retrieval

Robertson and Zaragoza (2009), *The Probabilistic Relevance Framework:
BM25 and Beyond*, describes a probabilistic retrieval framework and
term-frequency saturation and document-length effects. Existing
NoticeBridge uses BM25-style ranking with a strict eligibility rule.

Karpukhin et al. (2020), *Dense Passage Retrieval for Open-Domain
Question Answering*, uses separate question and passage encoders to
learn representations for candidate retrieval. The reported gains are
on open-domain QA benchmarks; official notice retrieval needs its own
assessment because dates, identifiers and category qualifiers are decisive.

Thakur et al. (2021), BEIR, compares retrieval systems across 18 datasets.
Its finding that BM25 is a strong cross-domain baseline argues against
discarding exact lexical matching. Dense or reranked retrieval can help
paraphrases but must be evaluated on the target corpus. A model trained
on general text is not necessarily better at notices.

Cormack, Clarke and Büttcher (2009) propose reciprocal rank fusion (RRF).
It combines ranked lists without assuming that lexical and embedding
scores share a numerical scale. We adopt it as a testable candidate
fusion baseline, not a universally optimal ranker. For document d,
score(d) = sum over channels of 1/(k + rank(d)), with one-based ranks.
Use k=60 initially and tune only on a development set. A rank score
is never a probability that an answer is true.

### Retrieval-augmented generation and citations

Lewis et al. (2020) combine retrieval and language generation in RAG.
NoticeBridge should instead keep a modular application-level pipeline:
retrieval, restricted proposal, evidence validation and display.
A model can help select and explain relevant evidence, but must never
become the sole authority on dates, amounts or eligibility.

Gao et al. (2023), ALCE, evaluate answer quality and attribution as
separate dimensions. A correct-looking answer with a valid citation
identifier may still be unsupported. We therefore distinguish identifier
validity, exact span membership, claim entailment and answer completeness.
All four matter. A citation's existence proves only that the source exists.

Rajpurkar, Jia and Liang (2018), SQuAD 2.0, add difficult unanswerable
questions. Use plausible missing-fact negatives, not merely unrelated
queries. Buchmann, Liu and Gurevych (2024), *Attribute or Abstain*,
motivates evaluating attribution and abstention together for document
assistants. A safe answer can be a source excerpt or a clear abstention,
not a guessed fact with decorative citations.

Liu et al. (2024), *Lost in the Middle*, find context-position sensitivity.
Do not put entire 80-page PDFs into a prompt simply because a model
advertises a long context. Measure sensitivity to shuffled evidence,
contradictory excerpts and distractor placement. Keep compact contexts
with all material exceptions; never truncate a qualifying sentence.

The mtRAG benchmark (2025), motivates evaluation of follow-up
queries and conversational context. Maintain explicit source and page
scope, resolve the user's earlier question rather than model output,
and test turns where the requested source or subject changes. See the
publisher's author list for complete attribution.

### Layout and scanned material

Mathew, Karatzas and Jawahar (2021), DocVQA, show document structure
is essential to many visual document questions. Plain line retrieval
cannot reliably resolve column headings, checkboxes or table cells.

Smock, Pesala and Abraham (2022), PubTables-1M, provide a benchmark for
table extraction including structural labels. Table detection and cell
association should be measured independently before table QA; merely
joining adjacent text can assign a fee to the wrong applicant category.
NoticeBridge already has native extraction/table analysis components in
the comparison backend. Reuse those after an explicit data-flow review,
rather than claiming the browser's adjacent-line mode is table-aware.

### Security and evaluation

OWASP's RAG Security and LLM Prompt Injection Prevention cheat sheets
treat retrieved content as untrusted. A document hash is not evidence
of authenticity or harmless content. Prompt instructions alone do
not defeat injection. An optional model must have no shell, browser,
filesystem, tools, external endpoint or automatic follow-up execution.
Treat its output as data, validate it and render as escaped text.

Es et al. (2024), RAGAs, and Saad-Falcon et al. (2024), ARES, explore
automated evaluation of RAG systems. Automated judges may be useful as
secondary triage, but cannot replace independently labeled human evidence
and conflict decisions. Never use the same model's self-confidence as
a release gate for correctness.

## Architecture decision

Keep the current browser-only mode as the default. No vector database
is needed for the current two-document, 12,000-fragment bound. Maintain
a strict no-model route for GitHub Pages and offline use.

Add an opt-in local-model experiment through a separately enabled
local backend, not through browser calls to arbitrary endpoints.
Existing backend semantic.py contains a bounded loopback Ollama
integration for comparison suggestions. Reuse its security patterns
after review, not its comparison-specific API or prompt. The existing
API accepts multipart PDFs; the new experiment must not silently use
that path. Explain which question and source fragments leave the
browser and require explicit approval. A remote hosted backend is not
equivalent to a local service.

Model runtime candidates:
- Ollama local embeddings and structured generation: suitable initial
  experiment because the repository already uses a local Ollama service.
  Pin model artifact identity and runtime version. No automatic download.
- Browser/WASM or WebGPU encoders: stronger browser-local data boundary,
  but model assets, memory, runtime support and download costs need
  measurement. Do not promise that all browsers can run the same model.
- Hosted APIs: outside the first experiment; require separate privacy,
  access control, deployment and consent decisions.

Evaluate at least two suitable embedding models on development and held-out
notice questions. Do not choose based on model size or a public general
leaderboard alone. Log actual dimensions, model artifact digest, tokenizer,
maximum context, device, memory and inference time; do not log PDFs.

## Candidate and evidence contract

Immutable source identity is the role plus SHA-256 of the actual PDF.
A fragment identity is derived inside the application from role,
physical page and extraction ordinal, with an extraction version.
The application holds source text; a ranker returns only identities.
Filter by allowed role and requested page before any ranking.
The model cannot assign role, page number, source digest or geometry.

Stage A: keep strict lexical and recognized-field candidates.
Stage B: use an optional dense retriever for additional candidates.
Stage C: combine unique rank lists via RRF, preserving channel provenance.
Stage D: reserve evidence budget independently for each requested source;
do not let the longer notice crowd out the shorter notice.
Stage E: return strict evidence unchanged and label semantic-only
candidates as review suggestions, not answers.

An early pure rank-fusion prototype lives in pdfChatResearch.ts. It is
not called by the production UI. It validates rank channels and allowed
source IDs, rejects duplicate or unknown candidates and provides a
bounded cosine baseline. An embedding adapter is not implemented here.

## Proposed model output and validation

For a first experiment, prefer extractive proposals:
schema = { status: "extract" | "insufficient", spans: [{ id, start, end }] }.
Use offsets defined in UTF-16 code units if checked in JavaScript. Reject
out-of-range offsets and split surrogate pairs. The server or application
looks up the exact original string and renders it with source identity.
The model does not supply an independent quotation. Preserve full
surrounding fragment for inspection.

No generated numeric transformations, inferred eligibility, inferred
amendments or claims of official authority. An extractive span can still
be misleading when a negation or exception is outside the span, so keep
the full passage and mark the result as a candidate. Conflicting roles
or values remain separate; absence of a retrieved value is not removal.

Only a later experimentally evaluated abstractive layer may output
short atomic natural-language claims, each linked to supporting spans.
Review entails checking claim meaning, qualifier coverage and whether
the answer omits contradictory or qualifying evidence. A second model
is not a proof of truth. If any consequential claim fails verification,
withhold that claim, surface uncertainty, or fall back to source passages.

## Initial experimental resource budgets (proposals, not measured limits)

- No more than 12,000 indexed fragments and 900 characters per fragment.
- At most 16 retrieved candidate fragments per subquestion and no more
  than 8 per requested source; preserve strict matches separately.
- For a bounded prototype dense matrix, at most 2,048 dimensions and
  12,000 rows; float32 storage is at most 98,304,000 bytes (93.75 MiB),
  excluding metadata, runtime and copies. Benchmark lower caps on
  representative machines before exposing the feature.
- Query and embedding batches must have exact cardinality, fixed
  dimension, finite numbers and nonzero norms; never silently truncate.
- Suggested local inference deadline: 30 seconds for embedding and
  30 seconds for generation, with cancellation and no automatic retry.
  Enforce true wall-clock deadlines, not only per-read timeouts.
- Bounded response bodies before JSON parsing, strict shape and depth,
  no duplicate fields, no redirects or proxy environment, no user URLs.
- Source replacement or cancellation invalidates outstanding work.
  Do not persist vectors, prompts or responses without explicit action.

All budgets require measurements. A local process is not automatically
a sandbox, and a local model may itself be configured to use remote
providers. Require an explicitly approved local-only configuration.

## Evaluation protocol

Separate deterministic fixture tests from an independently annotated
development set and a held-out notice-family test set. Split by issuing
organization and notice family, not randomly by individual query from
the same PDF. Use public documents only where storage/redistribution is
permitted; otherwise keep authorized local references and hashes. Avoid
PII in committed data, questions or logs. Record URL, retrieval date,
document SHA-256, extraction version and source role.

Proposed first held-out set: at least 100 question cases across
at least 20 unrelated notice families. Use stratified reporting and
record overlaps rather than force every example into one bucket:
- single-line exact values and unchanged text;
- synonyms and paraphrases; multi-line and multi-page facts;
- same-label conflicting values and changed conditions;
- applicant-category qualifiers and negated requirements;
- absent yet plausible answers and intentionally misleading distractors;
- scanned pages, mixed native/image pages, column and table questions;
- follow-ups that change scope, page or referent;
- prompt-like source text and malformed evidence.

Two annotators independently label answerability, source role, physical
page, supporting span(s), acceptable variants, exceptions and conflicts.
Disagreements are adjudicated before freezing the test. A question
can have multiple acceptable evidence sets. Distinguish genuinely
unanswerable from inaccessible extraction and ambiguous questions.

Measure retrieval recall@k, precision@k, MRR, complete evidence set
coverage, page correctness and source-role leakage. Report results by
slice. For answer proposals, measure exact span validity, claim support,
qualification completeness, conflict preservation and unsupported claim
rate; report abstention on negatives and coverage on positives separately.
Use paired comparisons and confidence intervals clustered by document
family; publish raw denominators and reproducible configuration.

Record latency p50/p95, index time, model load time, peak process memory,
model/asset size and failure/cancellation rate. Use fixed test hardware
and distinguish cold from warm runs. Compare strict, contextual,
dense-only, fused and optional reranked retrieval on the same cases.
Do not tune thresholds on held-out test results.

### Proposed gates before enabling semantic assistance

- Zero unauthorized source-role/page references or fabricated citation
  identities in deterministic adversarial tests.
- Zero invalid span outputs accepted by the protocol validator.
- No regression in critical exact-value retrieval or required
  abstention on the existing deterministic fixture suite.
- Demonstrate a useful held-out recall improvement over lexical +
  adjacent-line retrieval, without unacceptable loss in precision;
  select numeric thresholds using development data and report uncertainty.
- Human-reviewed consequential answers must retain all material
  qualifiers. A failure blocks promotion to verified factual answers.
- Test offline/static mode, unavailable model, malformed model response,
  cancellation, oversized input, mixed coverage, and document changes.
- Publish limitations honestly; an experimental model must not block
  users from using the deterministic mode.

## Implementation sequence

P0: establish exact source identity, candidate protocol, rank fusion
and validation tests; freeze baseline metrics.
P0: implement bounded local embedding adapter with explicit consent
and no persistence; measure candidate-only retrieval on held-out data.
P0: add restricted extractive proposal protocol and validation;
independent evaluation and failure-path tests.
P1: integrate source-layout-aware native tables; evaluate row/column
association before answering table questions.
P1: opt-in isolated OCR, extraction provenance and per-page coverage;
never silently pass OCR text as native.
P1: improve conversational planning and source comparisons. Only after
the above gates, experiment with constrained generated explanations.
P2: assess larger document libraries and on-device models after the
two-PDF workflow is stable; consider vector indexing only when measured
scale justifies it.

No change to public API, model runtime, downloads, external storage,
merge or release is authorized by this research document.

## References (publisher/maintainer sources)

1. Robertson, S.; Zaragoza, H. (2009). BM25 and Beyond.
   https://doi.org/10.1561/1500000019
2. Karpukhin et al. (2020). Dense Passage Retrieval.
   https://aclanthology.org/2020.emnlp-main.550/
3. Thakur et al. (2021). BEIR.
   https://datasets-benchmarks-proceedings.neurips.cc/paper_files/paper/2021/hash/65b9eea6e1cc6bb9f0cd2a47751a186f-Abstract-round2.html
4. Cormack, Clarke, Büttcher (2009). Reciprocal Rank Fusion.
   https://doi.org/10.1145/1571941.1572114
5. Lewis et al. (2020). Retrieval-Augmented Generation.
   https://proceedings.nips.cc/paper/2020/hash/6b493230205f780e1bc26945df7481e5-Abstract.html
6. Gao et al. (2023). Enabling LLMs to Generate Text with Citations.
   https://aclanthology.org/2023.emnlp-main.398/
7. Rajpurkar, Jia, Liang (2018). Know What You Don't Know.
   https://aclanthology.org/P18-2124/
8. Buchmann, Liu, Gurevych (2024). Attribute or Abstain.
   https://aclanthology.org/2024.emnlp-main.463/
9. Liu et al. (2024). Lost in the Middle.
   https://aclanthology.org/2024.tacl-1.9/
10. mtRAG (2025). Multi-Turn Conversational Benchmark.
    https://aclanthology.org/2025.tacl-1.36/
11. Mathew, Karatzas, Jawahar (2021). DocVQA.
    https://openaccess.thecvf.com/content/WACV2021/html/Mathew_DocVQA_A_Dataset_for_VQA_on_Document_Images_WACV_2021_paper.html
12. Smock, Pesala, Abraham (2022). PubTables-1M.
    https://openaccess.thecvf.com/content/CVPR2022/html/Smock_PubTables-1M_Towards_Comprehensive_Table_Extraction_From_Unstructured_Documents_CVPR_2022_paper.html
13. Es et al. (2024). RAGAs. https://aclanthology.org/2024.eacl-demo.16/
14. Saad-Falcon et al. (2024). ARES. https://aclanthology.org/2024.naacl-long.20/
15. OWASP RAG Security and Prompt Injection Prevention.
    https://cheatsheetseries.owasp.org/cheatsheets/RAG_Security_Cheat_Sheet.html
    https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html
16. Ollama official API and embedding documentation.
    https://github.com/ollama/ollama/blob/main/docs/api.md
    https://github.com/ollama/ollama/blob/main/docs/capabilities/embeddings.mdx

## Research prototype: extractive protocol

The pure validator in `pdfChatProposal.ts` checks bounded UTF-8 JSON,
object shape, nesting, decoded duplicate keys, scoped candidate identity,
UTF-16 offsets, surrogate boundaries, and overlapping spans. It returns
only locally resolved source substrings and source objects. Tests include
malformed proposals and attempted source spoofing. It is not integrated
with a runtime and cannot prove entailment or sufficient context.


## Local embedding experiment implemented

The bounded Python adapter uses Ollama's documented /api/embed endpoint
(https://docs.ollama.com/api/embed), with array input and truncate=false.
Before and after inference it checks the exact installed model name and
digest in /api/tags. The user must separately configure Ollama local-only
mode (https://docs.ollama.com/faq); a loopback address and manifest digest
cannot attest that the service is trustworthy or cloud-disabled.
The CLI requires explicit consent, has no remote endpoint, automatic
download, model generation or external network fallback. Its asyncio
deadline covers the client work; cancellation cannot guarantee a model
server stops computation immediately.

In the browser, use the experimental semantic retrieval panel after
one question. Explicitly approve the export of the full scoped indexed
text. The request is limited to 512 fragments; narrow the physical page
or source if necessary. Run from backend (with the existing dependencies
installed) against an already installed, trusted local embedding model:

```bash
python -m noticebridge.chat_embedding_cli noticebridge-embedding-request.json --output ranking.json --model MODEL:TAG --digest EXACT_64_HEX_DIGEST --allow-local-processing
```

Replace the placeholders with the exact installed name and digest.
Do not upload request files to a shared service. The output is an
atomic no-overwrite JSON of candidate IDs, request hash and model
metadata, not vectors, quotes or answers. Import it in the same chat
question while the request remains in memory. The browser validates
the request digest, schema, canonical result encoding and role-specific
candidate sets before local reciprocal rank fusion. It renders all
candidate text from its own index, separate from the unchanged answer.
An imported file is not signed: a dishonest local process can report
arbitrary permitted ranks and model metadata. Treat them only as
unverified review suggestions. No actual model benchmark or real model
runtime compatibility has been established yet.


## Local LLM evidence selection experiment implemented

The first generative-model integration uses a deliberately narrower
contract than free-form RAG or the earlier offset prototype. Instead of
asking a language model to generate answer prose or calculate character
offsets, it selects full candidate fragment IDs or explicitly abstains.
The structured generation response uses Ollama /api/generate, with
a schema-constrained response and independent strict parsing.

The browser supplies deterministic citations first, then optional hybrid
ranking candidates, deduplicated and bounded to 12 full passages per
source. All baseline evidence is retained in the request; the original
chat answer is never modified. Imported selection files must match the
request hash and canonical result format. The browser resolves IDs
against its in-memory source fragments rather than trusting model quotes.
If the model omits baseline evidence, the UI explicitly reports that
omission. A model abstention is not an assertion that evidence is absent.

After a single question, expand Experimental local AI selection and
explicitly approve exporting candidate text. Optionally import a semantic
ranking first to supplement the deterministic candidate set. With an
already installed, trusted local-only generation model and its exact
inventory digest, run from the backend directory:

```bash
python -m noticebridge.chat_selection_cli noticebridge-selection-request.json --output selection.json --model MODEL:TAG --digest EXACT_64_HEX_DIGEST --allow-local-processing
```

Replace placeholders with the exact local model name and digest. Import
selection.json in the same question. No remote endpoint, tool execution,
download, or automatic retry is enabled. The bounded client checks the
installed model before and after inference and rejects incomplete or
length-truncated responses. The request contains document text and
should be treated as private. Result hashes are bindings, not signatures.
No claim of actual installed-model inference, verified entailment,
generative answer accuracy, or independent evaluation is made.


## Concise grounded field answers

For bare recognized field questions, the deterministic chat now renders
a concise natural-language summary using the literal printed label and
value. It scans all recognized indexed fields in the requested role
and physical page scope, not just the top four lexical matches. This
means conflicts beyond the retrieval display cap are still counted.
Each displayed value links directly to its source page and fragment.
The summary is deliberately disabled for questions with additional
qualifiers and for ambiguous vocabulary keys. It does not infer
equivalent dates, fees, eligibility, legal effect or official authority.
Other matches and coverage warnings remain visible. This is templated
extractive synthesis, not free-form generative QA.

Generic application timing is not automatically interpreted as a closing
date. Opening and closing question patterns remain distinct; general
window questions require matching window text. Conversation replay and
clearing invalidate pending experimental model exchanges even when the
last question text is unchanged.


## Experimental aligned category-table question answering

The browser now retains optional native-text position hints (horizontal
unrotated text, finite baseline and width). These are not verified
highlight rectangles. A separate bounded detector looks for 2–4 aligned
columns headed by an explicit category label and recognized notice field
labels, then at least two complete, consistently spaced rows. It rejects
nearby incomplete, duplicate-category, overlapping, misaligned or wrapped
rows rather than inferring missing cells. Pages with unavailable geometry,
partial extraction or more than 512 fragments are skipped. At most 32
candidate tables per document and 40 rows per table are retained.

Questions of the form "Application fee for General category?" use exact
normalized category and recognized field keys, constrained to the
requested document role and physical page. The returned candidate
preserves four separate source fragments: category header, field header,
category cell and value cell. It links to the source page, keeps conflicting
values across pages and roles, and never replaces the ordinary lexical
answer. There is no fuzzy category equivalence, currency/date conversion,
OCR, merged-cell inference, or official applicability decision.

Unlike the existing server-side ruled-grid extraction, this browser
experiment uses text alignment alone. Unrelated columns can mimic a
table, and real tables may have right-aligned values, merged cells,
multi-line headers or nonuniform rows. Thus all results are explicitly
layout review candidates, not verified table facts. Independent layout
and row/column annotation is still needed. Tests include synthetic
position fixtures and generated PDFs with complete and missing cells.

The optional table explorer shows one aligned candidate at a time,
including explicit headers and all recognized rows. Every cell has a
source inspection link. A guided question is offered only when the
same parser round-trips the exact category and field, and is prefilled
with the correct source role and physical page rather than auto-submitted.

Native position hints also constrain adjacent-line retrieval when both
fragments have valid geometry: same-baseline cells, far-separated columns,
reversed order and large vertical gaps cannot form a contextual window.
Missing geometry retains the existing bounded ordinal-only fallback;
neither route proves that neighboring text is semantically connected.

## Review context for concise printed-field answers

A bare field question still reports all distinct recognized printed values
in the selected scope. It now also scans all indexed non-value passages
for full normalized query-term coverage, not just the displayed lexical
top four, and preserves cited context fragments. A passage might contain
an exception even when several exact field labels outrank it.

For each recognized value occurrence, the immediately preceding and
following indexed fragments can be proposed for inspection only if both
have native geometry and pass the same-reading-flow guard. Page and role
boundaries, missing ordinals, absent geometry, and separate columns
prevent a nearby-text association. Other recognized field labels are not
added solely because of proximity. Matching text takes precedence over
nearby text; physical source identities are deduplicated. Counts reflect
all candidates within the indexed scope, while display is limited to six
source-linked review passages per role, ordered by reason then source
position. The UI reports omitted counts.

Neither lexical overlap nor geometric proximity proves a qualification,
contradiction, or semantic relationship. These are review candidates,
not inferred exceptions. The printed values remain unchanged, with
independent source links and extraction-coverage warnings.

### Native text whitespace boundary

PDF.js may represent the horizontal distance between separately
positioned text items as a whitespace-only item with a large width.
Extraction must not replace the last nonblank geometry with that item.
Wide or displaced whitespace now terminates a fragment; ordinary spaces
remain separators and do not become layout anchors. This addresses a
suspected cause of the generated-PDF category-table browser failures.
The new regression asserts that the nine separately placed cells remain
nine fragments and form one aligned candidate. The fix requires browser
CI confirmation; synthetic whitespace handling does not validate general
PDF table reconstruction.

## Explicit routing follow-ups

With previous-question reuse enabled, a closed vocabulary of source-only
and physical-page-only follow-ups now replaces the requested routing
dimension rather than appending conversational filler to the search
subject. For example, "What about the revised notice?" after
"Application fee for General category in original notice on page 1?"
keeps the category, field and page, while changing the source. A later
"On page 2?" preserves the source. The resulting query is displayed as
search context and remains bounded by the shared question limit.

Questions containing substantive additional words continue through the
existing explicit concatenation path. The resolver does not infer
pronouns, remove material qualifiers, override a manually selected
scope, broaden a missing source, or turn a multiple-question turn into
a single referent. Malformed page selectors are rejected. Repeated
route-only follow-ups do not accumulate filler. Portable question plans
still store only user questions and settings, not answers; on replay
they use the current deterministic resolver, so results can differ
from older implementation revisions.

## Optional cross-page evidence exploration

When strict and enabled adjacent-line retrieval leave a requested source
unanswered, a separate user-triggered search can look for two partial
lexical matches on distinct physical pages of that same source. Each line
must contribute at least one term absent from the other; together they
must contain every normalized query term. The feature is unavailable for
a physical-page-filtered question, single-term queries, or more than
16 terms. It cannot combine the original and revised document or replace
successful strict/contextual retrieval for that source.

Equivalent term masks on a page retain the shortest source line (then
earliest extraction ordinal). At most 128 page/mask candidates per role
are considered for pair selection, bounding comparisons to 8,128 pairs.
The selected pair minimizes shared terms and then total text length;
the UI reports candidate truncation and never treats a bounded miss as
evidence of absence. This is a heuristic, not entailment or completeness.

The opt-in panel displays each original fragment, matched terms and a
physical-page inspection link. The original answer/abstention remains
unchanged. Leads are not included in strict citations, printed field
comparisons, local model exchanges or saved question plans. They are
not automatically recomputed or persisted on replay. Separate pages may
describe unrelated conditions, so no cross-page factual synthesis is
performed. A generated two-page PDF exercises the user-visible contract.

## Private deterministic chat evidence reports

Question plans deliberately omit answers. A separate explicit-consent
evidence report can now export exact deterministic search citations,
printed fields, matched counts, context groups, unresolved source roles,
resolved questions, and per-source extraction coverage. It embeds the
canonical source-fingerprint-bound question plan; it does not embed PDFs.
The browser recomputes all deterministic answers before export and refuses
to write a report if the current conversation differs from replay.

Verification reads at most 4 MiB, decodes strict UTF-8 and treats the
imported report as untrusted. Only the embedded canonical question plan
is consumed for replay against the attached exact PDF bytes and current
index. The entire report must match a newly serialized deterministic
snapshot byte-for-byte, including role, physical page, ordinal, quoted
text, counts, abstentions and extraction-coverage markers. Unexpected
fields, duplicate members, altered quotes and stale extraction results
are rejected. Verification reports counts and never imports saved
answers or changes the conversation.

The report includes private question text and quotations; export requires
explicit consent and does not use a network service. It is not a signature,
proof of publisher identity, independently verified PDF transcription,
or guarantee of factual accuracy. A matching report is reproducible only
under the current deterministic search and extraction behavior. It excludes
layout hints, table candidates, concise field summaries, cross-page review
leads and experimental model results. Those exclusions are stated in the UI.
Regression tests cover changed pins, altered evidence, mismatched coverage,
canonical encoding, stale state, file bounds and explicit browser consent.

## Experimental local OCR review bridge

For scanned pages, the first OCR integration deliberately does not replace
native chat indexing. It is a separate selected-page, English-only review
channel. Install the local backend and English Tesseract language data,
then run on a trusted computer:

```bash
python -m noticebridge.chat_ocr_cli source.pdf --role original --pages 1,3 --output ocr.json --allow-local-processing
```

The CLI accepts at most 10 MiB and 80 physical pages per PDF, 12 explicitly
selected pages, 16 million rendered pixels per page, 6,000 retained lines
and 800,000 UTF-16 code units. It runs a disposable worker with the existing
restricted environment, wall-clock deadline, POSIX limits and Windows job
assignment before input. This is not an OS sandbox. The worker does not
return diagnostics containing source text. Its report is structurally
validated, bound to the PDF SHA-256, and written atomically without
overwriting existing files. No remote OCR or network model is used.

The browser imports a canonical JSON report of at most 2 MiB, checks the
source role, fingerprint, physical page count, exact schema, ordered page
and line identities, text and count limits, and rejects ambiguous encoding.
It searches only the latest single question's selected source and physical
page in imported OCR lines. No OCR line is added to the strict native index,
printed-field summaries, table candidates, cross-page leads, replay reports
or model exchange. Every match is labeled machine transcription and links
to manual inspection of its original PDF page. Selected page status is
shown, including unavailable and limited pages; source replacement and
conversation reset discard imported data.

The report is unsigned; its fingerprint binds it to a PDF but does not prove
the contents were produced by OCR or that transcription is correct.
The implementation tests simulated OCR extraction and protocol validation;
installed Tesseract inference and representative scanned-document accuracy
require separate verification before this experimental feature is promoted.

OCR page inspection explicitly identifies machine transcription and
suppresses native ordinal-based nearby-fragment highlighting: OCR and
native extraction ordinals do not share a namespace. Conversation
replacement also remounts per-turn exploratory panels so previously
selected cross-page leads cannot survive into a different replay.
A browser regression uses a simulated OCR report, checks the fingerprint,
verifies the native answer still abstains, opens the correct PDF page,
rejects a changed fingerprint, and discards data when replacing a source.

A real image-only PDF regression additionally runs the complete isolated
CLI and actual English OCR when Tesseract and its English pack are
installed. It checks a printed date, selected-page isolation, exact
source fingerprint and quote-free terminal output; Windows without
Tesseract skips only that installed-runtime case. A separate browser
protocol test passes a Python-encoded report with currency, accented and
supplementary Unicode text through the TypeScript parser. These tests
must pass in CI before claiming runtime interoperability; one fictional
scan is not evidence of representative real-world OCR accuracy.

## Constrained local AI extractive answer proposals

The next model experiment accepts the same bounded complete-passage
request as selection, with all baseline fragments preserved. The local
model proposes exact unique substrings and candidate IDs, or abstains.
The backend validates literal equality without normalization, rejects
ambiguous repeated substrings, overlapping quotes and excess per-role
spans, and computes UTF-16 offsets itself. The result contains only
source IDs, offsets and request/model binding metadata, not model prose
or source quotations. Run with an explicitly approved installed local
model and exact digest:

```bash
python -m noticebridge.chat_extractive_cli noticebridge-extractive-request.json --output proposal.json --model MODEL:TAG --digest EXACT_64_HEX_DIGEST --allow-local-processing
```

The existing loopback-only transport checks the model inventory before
and after generation, rejects malformed/truncated responses and enforces
a total deadline. The browser independently validates bounded canonical
JSON, request hash, exact source IDs and UTF-16 boundaries, using its
existing extractive proposal validator. It also checks quote uniqueness,
per-role caps and canonical nested fields. The interface displays the
proposed substring highlighted inside the complete local fragment,
flags omitted baseline fragments and roles, and links to manual page
inspection. It never modifies the strict answer, reports or OCR review.

A valid extractive proposal is not a verified factual answer: literal
quotations can omit exceptions, negate context or select an irrelevant
fact. A model can produce plausible but misleading quotes, and unsigned
result files cannot attest model identity. No free-form generative
explanation or real-model accuracy claim is enabled. Tests exercise
UTF-16 interoperability, invalid quotations, abstention, source scope,
mocked model calls, request binding and browser review behavior.

## Full indexed evidence explorer and explicit references

The original strict ranker now exposes its complete deduplicated
ranked results without changing the top-four citations or counts.
When additional matches exist, each answer offers an opt-in paginated
review of every strict matching indexed passage in its exact source
and physical-page scope. Contextual windows are not promoted into
strict matches. The original answer and export format stay unchanged.

A separate native-text explorer supports literal substring search
(case-sensitive or ASCII-case-insensitive) and explicit singular
clause, section, paragraph, rule, article, annexure and schedule
references. The bounded reference grammar preserves numeric hierarchy
and parenthetical subparts, distinguishes reference types and does
not infer definitions from mentions. Questions containing explicit
references offer scoped lookup buttons. The explorer never joins
separate fragments, silently widens page filters or interprets
arbitrary patterns as regular expressions. Results are grouped by
source, paginated in sets of twelve and include physical page links.
Highlights are exact offsets in extracted text, not PDF rectangles.

The search exposes coverage limitations and missing source warnings.
An empty result is not a finding that text or a clause is absent.
Search is local, independent of model suggestions and OCR, and source
replacement clears manual search state. Tests cover literal Unicode
offsets, exact reference boundaries, scope, pagination, source
deduplication, strict ranking parity and user-visible workflows.
The OCR runtime regression normalizes whitespace only in its test
assertion; the exported machine transcription remains unchanged.

## Annotation-driven retrieval evaluation infrastructure

The offline TypeScript evaluation harness accepts scoped question cases,
notice-family identifiers, overlapping analysis slices, and one or more
complete acceptable evidence sets. It rejects duplicate or missing source
identities, cross-scope annotations and malformed case labels. Alternative
sufficient sets are evaluated independently: partial evidence taken from
two different alternatives is not automatically a complete answer.

The evaluator compares strict top-four retrieval, contextual retrieval and
the full strict explorer with the same frozen fixtures. It reports raw
denominators, citation precision, best-alternative recall, complete-set
coverage, mean reciprocal rank, duplicate/unknown source IDs, role and
physical-page leakage, and routing mismatches. Genuinely unanswerable,
unindexed and ambiguous cases have separate abstention denominators;
unjudged inaccessible or ambiguous outputs do not inflate precision.
Undefined ratios are null, not silently one or zero. It reports family
and slice metrics without printing questions or source quotations.

The committed benchmark is synthetic and only establishes regression
behavior. Independently annotated notice families, a held-out set, real
model experiments and manually checked qualifiers remain necessary.
Full strict retrieval is an exploration mode, not a replacement answer
engine; more citations do not establish better factual accuracy.

## Release-quality UI and page coverage navigation

The evidence explorer uses a distinct source-filter label from the chat
composer. The composer precedes expandable experimental model and report
panels; submitting a question scrolls the bounded conversation log
rather than the entire outer page. Browser test helpers verify that a
new turn really appeared, not merely that a click returned.

Direct physical-page navigation is now available for each attached PDF,
including pages with no indexed text, partially indexed pages and
unprocessed pages. It uses existing extraction coverage classifications,
never infers completeness from fragment counts, and remains local.
Manual page changes clear any selected quote and native-neighbor context;
the previous answer is left unchanged. Regression tests cover blank
pages, page bounds, role isolation, coverage and independent filters.

The page inventory is bounded to the first 80 physical pages per PDF,
including for much longer documents. A separate validated direct page
jump permits manual inspection beyond this list and the indexing limit.

### Workspace identity regression

The model exchange and evidence-report panels previously shared the
same React sibling key, allowing undefined reconciliation behavior.
All separately keyed workspace panels now use distinct purpose-specific
prefixes as well as source and conversation generations. The search-scope
select also has an explicit accessible name and an associated label.
Regression coverage checks for duplicate panels, stale imported ranking
state and exact accessible control identification after a new turn.

## Exact printed-value comparisons

The concise printed-field answer offers an opt-in arithmetic comparison
for two requested sources. It requires one recognized fee or calendar
date per source and withholds arithmetic for competing values, missing
sources, known additional query matches or nearby review text, and
unsupported syntax. Money uses exact BigInt minor units, bounded Western
or INR grouping, and at most two fractional digits. Bare dollar signs,
mixed currency labels, exponents, ranges and attached conditions are
rejected. An unspecified Rs. label is not equated with INR; two such
labels support numeric comparison only, with an explicit uncertainty
warning. No exchange-rate conversion is performed.

Calendar dates accept ISO year-month-day or a day/full English month/year,
with round-trip Gregorian validation. Differences count calendar days,
not inclusive application periods or time zones. Deterministic sentence
templates retain both printed values and direct source inspection links.
The calculation does not verify authority, applicability, equivalent
conditions, a valid amendment or complete PDF coverage. Tests include
very large exact amounts, leap days, omitted competing values, ambiguity
and browser interaction. The optional comparison is not persisted in
the deterministic citation report.

## Bounded hybrid shortlist for large PDF scopes

The full semantic request still refuses scopes exceeding 512 fragments.
A separate explicit shortlist mode allows the existing local model
exchange to operate on larger indexed corpora. It balances requested
source roles, reallocates unused capacity, preserves every baseline
citation, prioritizes strict lexical matches and then partial BM25
matches, and reserves a quarter of remaining capacity for page-diverse
samples. No candidate is promoted to an answer and no partial match
changes the deterministic abstention policy.

The browser shows selected and excluded fragment counts, selected and
eligible indexed pages, strict-match coverage and selection reasons
per role. The shortlist stays within the same source and physical page
filters and uses the existing bounded model request wire contract.
Dense ranking cannot recover excluded fragments. Its output remains
untrusted and limited to exact local source identities. Mode changes
invalidate the previous request and review. Tests cover large corpora,
balanced budgets, page filters, scope leakage, deterministic ordering,
baseline preservation, abstention and excluded-identity rejection.

An end-to-end fictional 24-page PDF fixture with 552 native fragments
exercises the full-export rejection, explicit 512-fragment shortlist,
visible exclusion counts, dense-result import and mode-change invalidation.
A 12,000-fragment index regression covers the maximum existing index size.
Neither test measures installed-model quality or representative PDF accuracy.

## Source-inspection cross-reference navigation

Native citation inspection now offers one-hop lookup of explicit printed
clause, section and other supported references. Sentence-final periods
are recognized as punctuation rather than identifier suffixes; malformed
hierarchical identifiers are not shortened. The lookup validates the
starting fragment against the local index, excludes itself, never searches
the other PDF, and distinguishes fragments beginning with a reference
from other mentions. Neither is a verified definition. Up to six unique
references are surfaced per fragment, with omitted-count disclosure and
eight results per page. Users can follow another reference only by
explicitly inspecting another fragment. No model, recursive expansion,
automatic scope widening of the answer or imported OCR is involved.

## Combined local retrieval and extractive workflow

A single opt-in local request now combines existing dense ranking with
exact-quote generation. The browser can export all scoped candidates
within 512 fragments or the bounded hybrid shortlist. The request
contains the question, candidate texts and every baseline identity.
The CLI validates both model configurations before inference, checks
each installed model digest before and after its stage, and enforces
the existing stage timeouts plus an outer 80-second deadline.
Baseline fragments always enter the second stage before dense-ranked
candidates; each role has a separate twelve-fragment cap. The result
contains only ranking identities, source offsets and binding metadata.

```bash
python -m noticebridge.chat_pipeline_cli noticebridge-pipeline-request.json --output result.json --embedding-model MODEL:TAG --embedding-digest EXACT_DIGEST --answer-model MODEL:TAG --answer-digest EXACT_DIGEST --allow-local-processing
```

The browser reconstructs both nested request files, recomputes SHA-256,
validates the exact dense rank and selection ordering independently,
and verifies literal source spans against its own index. Any malformed
stage rejects the entire result. No partial result is published when
local inference fails. Model output never replaces the deterministic
answer. A new question or source invalidates the exchange. This is
still an optional local file workflow, not a hosted model service or
validated factual entailment engine. Mocked transport, nested binding,
scope, malformed data, timeout, consent and UI regressions accompany
the implementation; real-model accuracy remains an independent gate.

A cross-language regression invokes the real Python pipeline using mocked
loopback transport and feeds the resulting bytes to the TypeScript browser
validator. This checks both nested hashes and non-BMP Unicode offsets with
one shared protocol, not model accuracy. Pipeline requests also require
canonical JSON to avoid ambiguous representations.

## Explicit natural-language comparison questions

A closed grammar now recognizes exact comparison forms for existing
fee and calendar-date field labels (compare, difference, how much
changed, and explicit directional questions). The original question
is preserved for replay and display; all strict retrieval and review
paths use the same normalized field and physical-page filter. Auto
requests both sources for this recognized intent, while an explicit
single-source selection is never overridden. A missing role remains
missing. The numeric explanation opens automatically for these
questions and reports the actual direction, not a direction assumed
by the question. Unsupported labels, category qualifiers, negation,
extra conditions, and multi-field questions are not simplified.
Regression tests cover recognized forms, unsupported forms, scope,
page routing, ranking parity, wrong-direction premises and UI behavior.
