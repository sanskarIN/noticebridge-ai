# PDF chat research and design

## Objective

Allow a user to ask questions of one or two notices, including unchanged
content that is absent from a comparison report. The first implementation
is an English-oriented, local extractive chat workspace. It retrieves
source lines and displays literal printed values for matching field labels.
It does not run a generative model, predict an answer from world knowledge,
infer legal authority, or promise that relevant evidence was found.

## Research basis

- Robertson and Zaragoza (2009), [BM25 and Beyond](https://doi.org/10.1561/1500000019):
  a lightweight lexical ranking baseline. The implementation uses BM25
  term weights and length normalization, with full query-term coverage
  as a conservative eligibility gate. This is not a calibrated confidence.
- Rajpurkar et al. (2018), [Know What You Don't Know](https://aclanthology.org/P18-2124/):
  answerability must be evaluated separately from answering known questions.
  Our baseline abstains when no line covers the query rather than filling
  in missing facts.
- Gao et al. (2023), [Enabling Large Language Models to Generate Text with Citations](https://aclanthology.org/2023.emnlp-main.398/):
  citation correctness and completeness are distinct from fluent answers.
  Every displayed excerpt is indexed from an actual page; its reference
  does not certify that the excerpt entails the question.
- [OWASP RAG Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/RAG_Security_Cheat_Sheet.html):
  retrieved content must be treated as untrusted. The baseline gives
  passages no execution privileges and does not send them to a model.

## Data flow and trust boundaries

1. The user explicitly chooses one or two local PDF files.
2. Snapshot the selected bytes. PDF.js extracts native text in its worker.
3. Build a temporary per-session term-frequency index of bounded lines
   with role, physical page number and within-page ordinal.
4. Apply English aliases and query-term coverage; rank qualifying lines
   with BM25-style scores, independently per selected source role.
5. Display up to four matching passages per role. A literal colon-delimited
   field whose label contains all query terms may appear as a printed
   value. No date arithmetic, eligibility verdict or generated fact.
6. Open the matching immutable source file at the referenced physical
   page. No bounding rectangle is asserted by the chat engine.
7. Clear chat state on source replacement. A user may explicitly reuse
   the previous question as search context, never a prior answer as proof.

The workspace uses no backend API, analytics, storage API or external
model. Ordinary hosting assets are still fetched from the application
origin. The current app's existing comparison API is a separate workflow.
Document-derived text is rendered as text, not interpreted as HTML or
instructions. Do not add links, commands or tools executed from PDF text.

## Bounds and limitations

- 10 MiB, 80 indexed pages and 800,000 indexed characters per file.
- Up to 6,000 passages per PDF and 900 characters per passage; overlong
  passages are excluded rather than truncated as though complete.
- Bounded streamed text items per page and a 30-second extraction timer.
  These are application-level limits, not an OS memory or CPU sandbox.
- 400 question characters, 16 distinct query terms, 24 chat turns.
- English keyword retrieval is deliberately conservative. Paraphrases,
  multi-line facts, tables, formulas, negation, ambiguous dates, synonyms
  and image-only text can fail or retrieve irrelevant passages.
- A missing result does not establish an absent requirement. Matching
  excerpts may omit context. The user must inspect the source page.
- Upload order does not establish which notice supersedes another.
- Clearing state releases application references; it is not secure erasure.

## Evaluation and next-stage architecture

Use independently labeled fictional and real-world permitted notice
examples with answerable, unanswerable, ambiguous, multi-page and
multi-document questions. Record retrieval recall@k, citation page
accuracy, unsupported answer rate and abstention behavior separately.
Do not use synthetic test pass rates as real-world QA accuracy.

A later hybrid retriever can combine lexical scores with local embeddings.
A generative stage should be optional, explicitly consented to, and return
bounded structured evidence IDs and candidate answer spans. Validate
every ID against the retrieved corpus and every quoted span against the
exact source bytes. ID validity alone cannot prove semantic entailment.
When evidence is conflicting or missing, abstain or present alternatives.
Do not expose shell, network, filesystem, upload, or tool permissions
to the model. Evaluate against a held-out set before enabling it by default.

## Use

Open the application's Chat with PDFs navigation link. Attach one PDF or
select Try fictional notices. Choose one or both source roles and ask a
question. Click a citation's Inspect source button to display the page.
The feature also works in the static showcase build without an API.


## Compound questions and comparative evidence

Explicit semicolon or question-mark separators create up to four independent
retrieval queries. A narrow grammar additionally recognizes bare lists of
deadline, fee and eligibility fields. Other conjunctions and alternatives
are not automatically split, because they may represent conditions rather
than independent questions. Each subquestion independently retrieves or
abstains; no successful answer can mask a missing second answer.

Printed fields with identical normalized labels are grouped per source role.
Repeated identical strings retain all displayed citations; multiple distinct
strings in one role are flagged without choosing one. Across roles, the
interface distinguishes identical displayed text, differing displayed text
and multiple displayed values. This is not numerical equivalence, a
confirmed amendment, or semantic contradiction detection. Only the displayed
retrieval results participate; additional matches may exist.

A source inspection panel can show up to two neighboring extracted fragments
on each side of the citation, restricted to the same PDF and physical page.
The fragments remain separate and are not treated as verified reading order
or additional answer claims.

A follow-up can reuse a single previous question only. Multi-question turns
require an explicit new question rather than guessing which subquestion the
user means. Prior trailing question punctuation is removed before adding
context so that a follow-up does not accidentally become two searches.


## Notice phrase normalization and automatic source selection

The lexical baseline normalizes a small set of notice-specific phrases
in both query and extracted text, including "last date", "closing date"
and "application charges". This avoids asymmetric synonym matching.
"How much" alone is not a fee indicator; questions about duration or
experience must not be converted into fee queries. Aliases affect retrieval
only; the original extracted wording is always retained for citations.

Auto scope is an optional selection. Explicit phrases such as "original
notice", "updated PDF", or "both versions" determine each independent
question's source scope. Otherwise it searches the attached source(s).
An explicitly requested but unattached source produces no matching evidence;
the other source is never silently substituted. Explicit manual scope
selection remains available and takes precedence when chosen.


## Adjacent-line retrieval

When a single source line does not contain every query term, the optional
nearby-line search (enabled by default in the UI) considers minimal
windows of two or three consecutive extracted fragments on the same
physical page. Every query term must be present across the window and
each endpoint must be necessary for coverage. Windows are bounded to
1,400 characters; at most two non-overlapping windows per role are shown.
Single-line retrieval remains preferred independently per source role.

Each fragment receives its own citation. The interface labels these
groups as nearby matches rather than verified answers, never joins
fragments into a fabricated quote, and never creates a printed-field
value from contextual matches. Omitted oversized lines leave ordinal
gaps so retrieval cannot bridge them. Visual columns, unrelated nearby
statements, and conditions remain important failure modes. Users may
disable nearby-line search to retain the original strict retrieval mode.


## Physical page constraints

Explicit "on page 2", "from PDF page 2" or "in physical page 2" syntax
restricts retrieval to that physical PDF page in each selected source.
It applies to strict and contextual retrieval; no other page is searched
if the requested page has no evidence. Page numbering refers to physical
PDF order rather than a printed page number, section or clause number.
Multiple page filters, ranges and out-of-budget page numbers are rejected.
An explicit new page in a follow-up replaces the preceding page constraint.
Lexical ranking uses full-corpus statistics even when candidates are filtered.


## Coverage-aware answers

Each extraction records total physical pages, processed prefix length,
pages with no indexed text, and pages affected by indexing bounds.
Question responses warn when their requested source has incomplete
coverage. Page-scoped questions distinguish nonexistent pages, unprocessed
pages, pages with no indexed text, and partially indexed pages. The
presence of some indexed text is never treated as proof that a page was
fully extracted. Even a fully processed PDF may contain unsearched images
or incorrectly encoded embedded text.


## Labeled retrieval regression suite

The browser test suite now includes a hand-authored fictional training
notice corpus with 15 labeled queries (nine answerable and six
unanswerable). The test records exact citation identities (source role,
physical page, extraction ordinal) rather than checking only answer
wording. It separately measures citation precision, citation recall,
complete relevant-citation retrieval and abstention on unanswerable
questions for strict and adjacent-line modes.

Run the suite from the frontend directory with:

```bash
npx playwright test pdfChatEvaluation.spec.ts
```

The aggregate assertions require the nearby-line mode to recover the
two split-evidence cases that strict search cannot retrieve, while
retaining the expected abstentions. These are regression expectations,
not measured performance until the test actually runs. The corpus is
small, authored alongside the implementation, and does not evaluate
OCR, natural-language entailment, real-world retrieval accuracy or
independent human relevance labels.
