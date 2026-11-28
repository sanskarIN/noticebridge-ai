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
