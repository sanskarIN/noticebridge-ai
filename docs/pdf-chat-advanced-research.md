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
