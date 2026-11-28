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
