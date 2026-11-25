import { lazy, Suspense, useEffect, useRef, useState, type ChangeEvent } from 'react';
import { BatchReadError, checkSourcePdf, type CaseSummary, type Quote, type SourceRole } from './batchIndex';

const PdfEvidencePreview = lazy(() => import('./PdfEvidencePreview'));

const roleNames: Record<SourceRole, string> = {
  original: 'Original notice',
  revised: 'Updated notice',
};

type Slot =
  | { kind: 'empty' }
  | { kind: 'checking' }
  | { kind: 'matched'; file: File }
  | { kind: 'error'; message: string };

type Slots = Record<SourceRole, Slot>;
export type PageSelection = { role: SourceRole; quote: Quote };

function emptySlots(): Slots {
  return { original: { kind: 'empty' }, revised: { kind: 'empty' } };
}

function errorCopy(error: unknown): string {
  if (error instanceof BatchReadError) {
    if (error.code === 'hash') return 'PDF bytes do not match this saved source fingerprint.';
    if (error.code === 'size') return 'Choose a nonempty PDF no larger than 10 MiB.';
    if (error.code === 'crypto') return 'SHA-256 checking requires HTTPS or localhost.';
    if (error.code === 'source') return 'Choose a PDF with a valid PDF signature.';
  }
  return 'Unable to check the selected PDF.';
}

export default function BatchSourceReview({ row, selection, onClose }: {
  row: CaseSummary;
  selection: PageSelection | null;
  onClose: () => void;
}) {
  const [slots, setSlots] = useState<Slots>(emptySlots);
  const generation = useRef({ original: 0, revised: 0 });
  const previewHeading = useRef<HTMLHeadingElement>(null);
  const originalInput = useRef<HTMLInputElement>(null);
  const revisedInput = useRef<HTMLInputElement>(null);
  const previousSelection = useRef<PageSelection | null>(null);

  useEffect(() => () => {
    generation.current.original++;
    generation.current.revised++;
  }, []);
  useEffect(() => {
    if (selection && previousSelection.current !== selection) previewHeading.current?.focus();
    previousSelection.current = selection;
  }, [selection]);

  function update(role: SourceRole, slot: Slot) {
    setSlots(old => ({ ...old, [role]: slot }));
  }

  async function select(role: SourceRole, event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file) return;
    const token = ++generation.current[role];
    update(role, { kind: 'checking' });
    try {
      const snapshot = await checkSourcePdf(file, row.sources[role]);
      if (token === generation.current[role]) update(role, { kind: 'matched', file: snapshot });
    } catch (error) {
      if (token === generation.current[role]) {
        update(role, { kind: 'error', message: errorCopy(error) });
      }
    }
  }

  function clear(role: SourceRole) {
    generation.current[role]++;
    update(role, { kind: 'empty' });
    if (selection?.role === role) onClose();
  }

  function clearAll() {
    generation.current.original++;
    generation.current.revised++;
    setSlots(emptySlots());
    onClose();
  }

  const selectedSlot = selection ? slots[selection.role] : null;
  const matched = Number(slots.original.kind === 'matched') + Number(slots.revised.kind === 'matched');
  return <section className="batch-source-panel" aria-labelledby="batch-source-title">
    <h3 id="batch-source-title">Optional source PDF inspection</h3>
    <p>Attach the two original PDF files to compare their bytes with this case's saved
      fingerprints. Only matching files can be rendered. Matching a saved hash is
      not issuer authentication or independent extraction of the saved quotation.</p>
    <div className="batch-source-slots">
      {(['original', 'revised'] as const).map(role => {
        const slot = slots[role];
        const title = roleNames[role];
        const ref = role === 'original' ? originalInput : revisedInput;
        return <div key={role} className="batch-source-slot">
          <label className="batch-file-control">{title} PDF for this case
            <input type="file" ref={ref} accept=".pdf,application/pdf"
              onChange={event => void select(role, event)} />
          </label>
          {slot.kind === 'empty' && <p className="batch-muted">No PDF attached.</p>}
          {slot.kind === 'checking' && <p role="status">Checking {title.toLowerCase()} bytes…</p>}
          {slot.kind === 'matched' && <p role="status" className="batch-note">
            {title} PDF bytes match the saved fingerprint.
          </p>}
          {slot.kind === 'error' && <p role="alert" className="batch-error">{slot.message}</p>}
          <button type="button" className="batch-secondary" onClick={() => clear(role)}
            disabled={slot.kind === 'empty'}>Clear {title.toLowerCase()} PDF</button>
        </div>;
      })}
    </div>
    <div className="batch-toolbar">
      <span className="batch-muted">{matched} of 2 PDF fingerprints matched.</span>
      <button type="button" className="batch-secondary" onClick={clearAll}
        disabled={slots.original.kind === 'empty' && slots.revised.kind === 'empty'}>
        Clear attached PDFs
      </button>
    </div>
    {selection && <section className="batch-page-panel" aria-labelledby="batch-page-title">
      <div className="batch-toolbar">
        <h3 id="batch-page-title" ref={previewHeading} tabIndex={-1}>
          {roleNames[selection.role]} · page {selection.quote.page}
        </h3>
        <button type="button" className="batch-secondary" onClick={onClose}>Close source page</button>
      </div>
      <p className="batch-note">The page reference comes from the saved report.
        Inspect the actual PDF and decide whether the quotation and its context agree.</p>
      {selectedSlot?.kind === 'matched' ?
        <Suspense fallback={<p role="status">Preparing local PDF renderer…</p>}>
          <PdfEvidencePreview file={selectedSlot.file} pageNumber={selection.quote.page}
            evidence={selection.quote.geometry ?? undefined}
            uncheckedImage={false} inspectionOnly />
        </Suspense> :
        <div>
          <p>Attach the matching {roleNames[selection.role].toLowerCase()} PDF above to view this page.</p>
          <button type="button" className="batch-secondary" onClick={() => (
            selection.role === 'original' ? originalInput.current : revisedInput.current
          )?.focus()}>Focus matching PDF input</button>
        </div>}
    </section>}
  </section>;
}
