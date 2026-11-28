# Independent local PDF collection

This experimental workspace is distinct from the original/revised notice
comparison. Up to six locally attached PDFs can be queried independently.
No document is automatically designated newer, authoritative or applicable.

Each document is fingerprinted using SHA-256 and indexed from the same
immutable byte snapshot. The filename is only a local display label; two
different files with the same name are allowed, while identical bytes are
deduplicated before extraction. Each source uses its own corpus statistics,
strict lexical and recognized-field retrieval, optional adjacent-line fallback
and physical page coverage. Scores are not fused across documents.

## Limits and privacy

- At most six documents, 10 MiB per PDF and 24 MiB in total.
- At most 18,000 retained native fragments and 2,000,000 retained UTF-16 code
  units across the collection, in addition to the ordinary per-document
  extraction limits.
- At most 24 saved turns and four explicit question parts per turn.
- Search selections are explicit document identities. Version-routing and
  arithmetic change-comparison questions remain in the two-PDF workflow.
- No upload, external API, local model invocation or OCR import is required.
- Source inspection opens the exact attached file and physical page.

A question plan saves only the exact source fingerprint set, selected
fingerprints, questions and the context setting. Replay requires the complete
matching set of attached PDFs and recomputes answers; filenames are not part
of the identity. A separate evidence report includes native excerpts and
coverage, and must be treated as private. Report verification recomputes the
canonical report from attached indexes and rejects any mismatch, without
importing results or changing the current conversation. Neither output
certifies the extracted text, meaning or official authority.

This feature still requires independently reviewed real-notice evaluation,
browser performance measurements and accessibility testing before release.

## Collection inspection tools

The printed-field matrix compares only recognized literal labels and values across the explicitly selected PDFs. Missing values, multiple values within one PDF, and differing single values are distinct states. It does not choose an authoritative notice. Filter the matrix to review unresolved fields, and inspect a citation in its original document and physical page.

The collection evidence explorer supports literal phrases and explicit clause references. Case folding is optional and ASCII-only. Matches are native-text offsets, not visual bounding boxes. A physical-page filter never falls back to another page or document. Search results are paginated per document and do not create chat turns. For a question whose strict matches exceed the displayed citations, the expansion reconstructs all strict matches from the same index and scope without changing the original answer.

## Collection evidence review

Save a specific native fragment from source inspection and assign a personal
review status and note. The document fingerprint is part of the entry identity;
matching fragment locations or text in unrelated PDFs do not collapse.
The notebook supports document/status/text filters and bounded pagination.
Clearing questions does not erase notes. Removing a document requires explicit
confirmation if it has notes and removes only that document's annotations.

Export is opt-in and includes private authored notes, review flags, exact
collection fingerprints, physical locations and SHA-256 hashes of extracted
text, not PDF bytes or automatically copied quotations. Import stages a
complete replacement only after the current attachment set and every saved
text hash match. Changed extraction, malformed encoding, duplicate entries
and noncanonical JSON fail closed. User confirmation is required to apply.
Review flags do not establish official authority or answer correctness.

## Physical page and table inspection

The collection page navigator can open every physical page of an attached
document, including image-only pages or pages beyond the 80-page indexing
limit. The coverage list is bounded and paginated; the manual jump validates
against that particular PDF's physical page count. Manual inspection never
creates a saved native fragment or adds a chat turn.

The aligned category table explorer operates independently on each selected
document. It uses the existing conservative native geometry rules and lists
skipped pages and candidate limits. Table cells can prefill a question scoped
to their exact document and page. Candidate answers remain optional layout
inspection leads, separate from the native lexical answer and its private
replay. No cells are joined across PDFs, and no table structure or official
applicability is certified.

## Complete collection workspace

A complete workspace combines the canonical question plan and review notebook
under the exact attached PDF fingerprint set. Question-only and review-only
workspaces are supported; an empty workspace is not. Import validates both
nested formats and recomputes answers before staging a single replacement.
The user must confirm the replacement, and any intervening change to questions
or review annotations invalidates that confirmation. Export requires a fresh
approval for the current workspace and does not include saved answers, source
quotes, filenames, PDF bytes or optional table proposals. Personal questions
and notes may still be sensitive.

## Independent collection conversation history

Choose an earlier question part to prepare a deterministic follow-up draft.
The draft retains the earlier document selection and search settings and is
shown for editing before submission. A page-only follow-up replaces the
earlier page constraint. No answer text is used as search context, and the
user must explicitly select any different PDFs. The saved step is the
standalone resolved question; replay does not need a prior answer.

Historical question edits recompute the selected turn, retain the earlier
prefix and require explicit approval before discarding later questions.
Individual question removal keeps all other standalone turns. Neither action
changes saved evidence-review notes. Question-plan and workspace formats
remain compatible because they contain standalone steps only.

## Collection printed-date inventory

Recognized date labels can be inspected in document or calendar order. The date field comparison reports only unsigned calendar-day spans when every selected document has a single supported printed date without detected contextual leads. Window checks never combine opening and closing labels across different PDFs. Source links retain exact PDF identity. These are inspection aids, not official deadlines or reminders.

## Collection source fragments

The source viewer offers a paginated native fragment list for the selected physical PDF page, with optional text filtering and immediate same-flow neighbors. The selected fragment remains an exact local source object. Empty native coverage is distinct from an absent physical page. Inspection does not add a chat turn or assert that adjacent text answers the question.

## Collection batch question workbench

Prepare up to twelve independent question turns with an explicit PDF selection and a bounded total of 144 document/question-part searches. The workbench yields between turns for cancellation and stages all results before any history change. It reports matching versus nonmatching native fragments and incomplete coverage separately. Applying requires the same document and history snapshot, verifies source identity, and recomputes the entire batch. Results append to the ordinary replay-compatible conversation; no assistant-generated text becomes context.

## Collection retrieval diagnostics

Each answer part can explain normalized term coverage, partial lexical leads and bounded one-edit spelling alternatives within its exact document and physical page scope. An alternative explicitly prefills a standalone question scoped to the PDF that supplied its vocabulary. It never submits automatically or overwrites an existing draft. Diagnostic leads are separate from answer citations and portable evidence replay.

## Collection requirement wording

Inspect mandatory, prohibited, exception, permission and recommendation cues separately by physical page and literal keyword. Exact counterpart counts include only distinct selected documents, never duplicate fragments within one PDF. A missing counterpart does not imply removal, change or applicability. Each source can be inspected and saved in the review notebook.

## Collection outline candidates and exact section alignment

Explore recognized heading candidates, repeated heading keys and native fragments in candidate spans. Users explicitly select two physical section candidates from different PDFs before bounded exact sequence alignment. Matching headings and unpaired fragments never imply equivalent rules or a revision direction. Repeated wording and incomplete extraction are reported separately.

## Independent collection source replay

Export a private canonical snapshot of the bounded native extraction, with explicit consent. Replay uses separately selected PDFs, identifies them by SHA-256 (not names or order), rejects duplicate bytes, and never extracts unexpected files. Missing sources, changed extraction and extraction failures remain distinct. A deterministic report contains fingerprints, coverage and fragment counts, not source quotations. Saved reports must be reproduced independently before acceptance. Neither the snapshot nor replay certifies authority, extraction completeness or answer accuracy.

## Independent collection local AI proposals

Prepare bounded semantic-ranking/extractive requests for one saved question part and explicitly selected PDFs. Each request retains its own PDF identity and native source map. No text is pooled across PDFs. Empty native scopes are skipped. Preparation sends no network requests; export and optional loopback processing require explicit consent. Results are independently checked against the existing local model protocol and exact local source fragments. A portable result bundle binds all constituent results to the canonical plan manifest. Model outputs do not change the deterministic conversation or establish verified answers.

### Offline collection AI runner

The collection model CLI accepts the canonical manifest and a directory containing the exact named request files. It validates every file length, SHA-256, question and single-document scope before invoking the trusted local runtime. Requests run sequentially with a bounded overall deadline; incomplete runs do not publish partial bundles. The browser imports the complete result only after independently validating every nested response against the active plan. Local runtime configuration and processing are opt-in and do not certify the correctness of model proposals.

## Human-labelled collection retrieval evaluation

The evaluation lab lets a reviewer explicitly label native fragments for a saved question part and exact PDF, or record an expected abstention. It computes micro precision/recall, reciprocal rank, expected evidence retrieval, abstention agreement and incomplete coverage separately. Labels are not generated from baseline answers. Unlabelled retrieved fragments may still be relevant. Canonical labels bind exact PDF fingerprints and expected native text hashes; canonical reports can be independently recomputed. All metrics are agreement with personal annotations, not answer truth or verified authority.

## Collection scanned PDF review

Optional OCR reports bind the exact PDF fingerprint and original-role physical pages. Import and direct loopback processing stage a review before replacing only that document's previous OCR report. Separate collection budgets bound retained machine transcription. OCR search reuses the saved question and physical page scope independently for each document, reports missing or unreviewed pages, and opens the rendered PDF for inspection. Native retrieval, native evidence exports and review annotations never incorporate machine-transcribed lines.

## Portable collection evidence review packet

The canonical review packet combines the native snapshot hash, canonical editable workspace, replayed question evidence, source coverage and exact reviewed quotations. Verification requires the complete current native extraction to match, including unquoted fragments. It never restores history or treats a saved review status as a factual verdict. A separate escaped, script-free, print-friendly HTML reading copy contains the source inventory, question excerpts and annotations. Both exports require explicit consent for the exact current workspace; the HTML copy is not itself a replay artifact.

### Offline model preflight

Before approving local model processing, export the independent model plan and
all request files into a private directory. Run:

```bash
python -m noticebridge.chat_collection_models_cli noticebridge-collection-model-manifest.json --request-directory . --output collection-preflight.json --preflight-only
```

No model names, digests, or processing consent are accepted in preflight mode.
The command validates the complete request set before writing a new private
report. Import the report into the plan's offline preflight panel to reproduce
the exact manifest binding and candidate counts by physical page. Counts describe
the selected candidate set, not complete native extraction. The report is not
an authenticated statement about how it was produced.

### Retrieval regression comparison

The human-labelled evaluation lab can export a coordinate-only regression run.
After changing the retrieval implementation, restore the same source collection
and the exact original labels, and import the historical run. The complete
native snapshot digest and canonical label digest must match, including text
outside the labelled fragments. Historical coordinates must resolve to unique
in-scope native fragments. Aggregate precision, recall, reciprocal rank,
expected abstention and per-case differences are reconstructed from the
recorded coordinates; the current retrieval is executed independently.

A mixed change means some labelled metrics improve while others decline.
A different retrieval with unchanged scores is also shown, rather than hidden
by the aggregate metrics. Neither a recorded run nor a better label score
establishes factual correctness, completeness, or official notice authority.
The historical run is unsigned and cannot establish that the recorded software
actually executed. Evaluation and comparison can be cancelled between cases.


## Workspace tool directory

Use the searchable, grouped directory to jump directly to a collection tool. Availability reflects attached documents, saved question turns, source inspection and active indexing. Opening a destination preserves other tool state and never changes the selected PDFs or submits a question.

## Question-centred answer overview

The at-a-glance view groups saved results by question part, keeps each PDF's printed values and native coverage distinct, and exposes multiple values or missing matches without treating them as amendments. Bare recognized field questions can show literal values and nearby review candidates. Qualified questions remain ordinary evidence retrieval. Shared quotations are grouped by exact text across distinct PDFs and retain each source identity.

## Optional native line location

The source viewer can show an opt-in dashed location cue. It independently streams the same physical PDF page through the bounded native assembler, requiring exact fragment ordinal, text and geometry before transforming a conservative line area into the rendered viewport. No approximate substitute is shown for a mismatch. The marker is not verified glyph geometry, a certified transcription or an official source verdict. Navigation resets the opt-in selection.

## Offline structural audit of a review packet

Export the native collection snapshot and canonical review packet from the same collection. The independent Python checker validates the exact snapshot byte hash, source inventory, annotation hashes, displayed quotation references, physical page scopes, coverage and literal printed fields. Optionally check the complete independently selected PDF byte set:

```bash
python -m noticebridge.chat_collection_audit_cli packet.json snapshot.json --pdf a.pdf --pdf b.pdf --output audit.json
```

The audit report contains only hashes, counts and explicit status fields. It does not execute the browser's extraction, question planning or ranking, and does not authenticate historical runs or certify source accuracy. Exit code 3 indicates that the packet is structurally consistent but the supplied PDF byte set differs; exit code 2 indicates a rejected artifact or output failure. Use browser source replay and packet verification for the independent native extraction and retrieval checks.

The collection review packet panel also accepts the original packet and an offline structural audit report. It independently replays the packet and reconstructs the audit counts and exact hashes; an optional positive PDF byte check is repeated from the attached local files. Reports with missing or unexpected source bytes cannot be reconstructed from the matching workspace alone. A matching report does not authenticate the prior process.

## Explicit table candidate comparison

Choose one physical aligned native table from each of at least two selected PDFs. Compare recognized field keys and complete normalized printed category keys, including rows on different physical pages. Missing category, missing field and missing both remain separate, and every present cell can be inspected with its actual category and column headers. Literal equality is not proof of equivalent eligibility or an official amendment. The private comparison report binds the full native extraction snapshot and is recomputed before acceptance.

## Offline collection snapshot retrieval

Export a native collection snapshot and either a question plan or a manually
labelled retrieval evaluation from the browser. On Node.js 22, run from the
frontend directory:

```sh
npm run replay:collection -- --mode questions --snapshot snapshot.json --input plan.json --output evidence.json
npm run replay:collection -- --mode labels --snapshot snapshot.json --input labels.json --output evaluation.json
npm run replay:collection -- --mode regression --snapshot snapshot.json --input labels.json --output run.json
npm run replay:collection -- --mode verify-evidence --snapshot snapshot.json --input evidence.json --output verified.json
npm run replay:collection -- --mode verify-evaluation --snapshot snapshot.json --input evaluation.json --labels labels.json --output verified-evaluation.json
```

The CLI builds the same independent retrieval indexes as the browser, checks
canonical source sets, expected-fragment hashes, scope and output limits, and
refuses to overwrite an existing artifact. Verification requires exact replay,
not merely matching a saved digest or accepting stored scores. It does not
open PDF files, prove extraction completeness, authenticate a source, or
verify the truth of an answer. Use independent PDF source replay for checking
the original bytes and native extraction. All artifacts may contain private
document content; store them locally and do not commit them to a public repo.

## Merge separately saved collection workspaces

Import a complete workspace against the same attached PDF fingerprints and
native review text. The confirmation panel offers replacement and a separate
merge preview. Merging keeps existing question order, appends new exact
question/selection/context combinations and preserves all nonconflicting
annotations. Repeated imported questions are counted rather than appended.
Review notes and statuses that differ for the same fragment require an
explicit choice of the current or imported annotation; no status wins
automatically. Combined limits are checked before applying. If the current
conversation or review changes, discard the preview and import again.

## Retrieval ranking trace

Expand the ranking trace under an individual saved question part to inspect
the exact normalized query terms, recognized field, local search scope, all
unique strict candidates and same-page duplicate counts. Filter by lexical
match, field alias or whether a candidate was displayed. Individual BM25
term contributions use the same calculation as the answer ranker and
retain whole-PDF statistics under a physical-page filter. Weights are not
probabilities and must not be compared between unrelated PDFs. The
adjacent-line fallback is separately identified when no strict match exists.
Inspection never changes the saved answer.
