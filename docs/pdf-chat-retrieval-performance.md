# PDF chat retrieval performance

The strict lexical evidence ranker now constructs role-specific term and
recognized-field postings for native text. It uses the smallest query-term
posting as a candidate superset, merges recognized-field candidates in source
order, and applies the same full-term predicate and BM25 score as before.
This is not a semantic relevance or authority-confidence model.

Physical page views retain the original corpus document-frequency and average
length statistics. A bounded eight-entry least-recently-used cache avoids
rebuilding the same page view on repeated questions. The reading order used
for optional neighboring-line evidence is precomputed per role; page and
geometry guards are unchanged.

The compatibility scan path remains available for derived indexes assembled by
other callers. Treat indexes produced by buildIndex as immutable snapshots;
create a new index when source documents or extracted text change. The cache
is attached through a WeakMap and is not serialized, uploaded, or persisted.

## Verification

The regression suite compares accelerated and exhaustive results on multiple
deterministic synthetic corpora, checks original evidence object identity,
role and page isolation, aliases, missing terms, Unicode, duplicates, ties,
reading-order geometry, bounded view eviction, and the maximum 12,000-passage
budget. The maximum-corpus test counts term membership operations rather than
asserting a machine-specific elapsed time.

These checks establish intended behavioral equivalence, not real-world
retrieval accuracy or end-to-end latency. Measure memory and latency on
independently labeled real notice PDFs before claiming production performance.
