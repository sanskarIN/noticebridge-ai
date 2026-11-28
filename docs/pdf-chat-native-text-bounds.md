# Native PDF chat text extraction bounds

Native text assembly is separately testable without a browser, PDF.js worker,
OCR model or server. Valid positioned fragments retain their literal text
and layout hints. Invalid or rotated geometry is isolated with ordinal gaps;
it can be searched as a literal fragment but cannot create a merged
multi-fragment quotation through neighboring-line retrieval.

Each input document has a 10 MiB file limit, 80 physical-page limit,
800,000 retained UTF-16 code-unit limit, 6,000 retained fragment limit,
80,000 inspected text/marked-content items per page and 240,000 inspected
items across the document. The PDF.js processing deadline remains 30 seconds.
These are conservative application-level limits, not a guarantee about PDF.js
worker memory or adversarial PDF parsing complexity.

On truncation the assembler discards an unfinished line, retains complete
fragments already accepted, and reports a limited page. Omitted overlong
or over-budget fragments leave ordinal gaps rather than shortening a source
quote. Unprocessed pages remain separately identifiable through corpus coverage.
A deadline or explicit cancellation does not return a successful extraction.

Tests cover native fragment assembly, malformed geometry, column gaps,
character and item budgets, page identity, contextual-retrieval isolation
and stream truncation. Existing real-PDF browser tests remain the integration
gate; independently labeled layout evaluation and OCR accuracy are separate.
