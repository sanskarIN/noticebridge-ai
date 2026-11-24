import { useState } from 'react';
import type { DocumentRole, Evidence, Report } from './comparison';

export type CoveragePage = Pick<Evidence, 'document_id' | 'filename' | 'page'> & {
  uncheckedImage?: boolean;
};
export type SelectedOcrPages = Record<DocumentRole, number[]>;

const MAX_OCR_PAGES = 12;
const documentNames = { original: 'Original notice', revised: 'Updated notice' };
const coverageMessages = {
  all_pages_have_text: 'Every PDF page yielded some text, but this does not prove every statement was captured.',
  partial: 'Some PDF pages yielded no text. Changes on those pages may be missed.',
  inconclusive: 'One or both PDFs yielded no text. The comparison is inconclusive.',
};

export default function CoverageReview({ report, busy, error, localAi, onOpen, onSettings, onRetry }: {
  report: Report;
  busy: boolean;
  error: string;
  localAi: boolean;
  onOpen: (source: CoveragePage) => void;
  onSettings: (role: DocumentRole) => void;
  onRetry?: (pages: SelectedOcrPages) => void;
}) {
  const [queued, setQueued] = useState<SelectedOcrPages>({ original: [], revised: [] });
  const queuedCount = queued.original.length + queued.revised.length;
  const canSelect = Boolean(onRetry) && report.documents.some(doc => {
    const attempted = doc.ocr_override_pages ?? [];
    return [...doc.pages_without_text, ...(doc.pages_with_unchecked_images ?? [])]
      .some(page => !attempted.includes(page));
  });

  function togglePage(role: DocumentRole, page: number, checked: boolean, existing: number) {
    setQueued(current => {
      const selection = current[role];
      if (checked && (selection.includes(page) || selection.length + existing >= MAX_OCR_PAGES)) {
        return current;
      }
      return { ...current, [role]: checked ? [...selection, page] : selection.filter(p => p !== page) };
    });
  }

  function retry() {
    const selection: SelectedOcrPages = { original: [], revised: [] };
    for (const doc of report.documents) {
      selection[doc.id] = [...(doc.ocr_override_pages ?? []), ...queued[doc.id]].sort((a, b) => a - b);
    }
    onRetry?.(selection);
  }

  return <section className={`coverage-report ${report.text_coverage}`} aria-labelledby="coverage-heading">
    <h3 id="coverage-heading">Text extraction coverage</h3>
    <p>{coverageMessages[report.text_coverage]}</p>
    {canSelect && <p id="coverage-ocr-help">
      Selected pages use OCR in place of embedded text. Check the transcription against the PDF.
    </p>}
    <ul className="coverage-documents">{report.documents.map(doc => {
      const previous = doc.ocr_override_pages ?? [];
      const selected = queued[doc.id];
      const groups = [
        { pages: doc.pages_without_text, title: 'Open pages with no extracted text', hasImages: false },
        { pages: doc.pages_with_unchecked_images ?? [], title: 'Review pages with large images', hasImages: true },
      ];
      const hasCandidates = groups.some(group => group.pages.some(page => !previous.includes(page)));
      return <li key={doc.id}>
        <span>{documentNames[doc.id]} · {doc.filename} · {doc.pages_with_text}/{doc.page_count} pages yielded text</span>
        {!!previous.length && <p>Selected for OCR · {previous.join(', ')}</p>}
        {!!doc.ocr_pages?.length && <p>Text extracted by OCR · {doc.ocr_pages.join(', ')}</p>}
        {onRetry && hasCandidates && <p className="coverage-ocr-count">
          {selected.length + previous.length}/{MAX_OCR_PAGES} selected OCR pages for this PDF
        </p>}
        {groups.filter(group => group.pages.length).map(({ pages, title, hasImages }) => <details key={title}>
          <summary>{title} ({pages.length})</summary>
          {hasImages && <p>These pages contain some selectable text. The large images may contain more notice text.</p>}
          <div className="coverage-page-links">
            {pages.map(page => <div className="coverage-page" key={page}>
              <button className="review-button" type="button" onClick={() => onOpen({
                document_id: doc.id, filename: doc.filename, page, uncheckedImage: hasImages,
              })}>Page {page}</button>
              {onRetry && !previous.includes(page) && <label>
                <input type="checkbox" checked={selected.includes(page)}
                  aria-label={`Select ${documentNames[doc.id].toLowerCase()} page ${page} for OCR`}
                  aria-describedby="coverage-ocr-help"
                  disabled={busy || (!selected.includes(page) && selected.length + previous.length >= MAX_OCR_PAGES)}
                  onChange={event => togglePage(doc.id, page, event.target.checked, previous.length)} />
                OCR
              </label>}
            </div>)}
            {onRetry && hasImages && <button className="review-button" type="button"
              disabled={busy} onClick={() => onSettings(doc.id)}>Open selected-page OCR settings</button>}
          </div>
        </details>)}
      </li>;
    })}</ul>
    {onRetry && canSelect && <div className="coverage-ocr-action">
      {queuedCount > 0 && <p>
        Both PDFs are uploaded again. Findings that change may need review again.
        {localAi && ' Local AI remains enabled and may receive unmatched text excerpts.'}
      </p>}
      {busy && <p role="status">The previous comparison is available while OCR runs.</p>}
      <button type="button" className="review-button" disabled={busy || queuedCount === 0} onClick={retry}>
        {busy ? 'Comparing with selected OCR pages…' : queuedCount > 0
          ? `Compare again with OCR on ${queuedCount} more ${queuedCount === 1 ? 'page' : 'pages'}`
          : 'Compare again with selected OCR pages'}
      </button>
    </div>}
    {error && <p role="alert" className="error-banner">OCR comparison failed. The previous comparison is still available. {error}</p>}
  </section>;
}
