import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import type { BatchIndex } from './batchIndex';
import {
  LedgerError, readLedger, reviewStates, reviewStateNames, serializeLedger, serializeLedgerCsv,
  summarizeReviews, type ReviewLedger,
} from './batchReviewLedger';

function download(name: string, content: string, mime: string) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  // Defer revocation until after the browser has started the download.
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function message(error: unknown): string {
  if (error instanceof LedgerError) {
    if (error.code === 'different') return 'Review ledger belongs to a different exact batch index.';
    if (error.code === 'size') return 'Choose a nonempty review ledger up to 16 KiB.';
    if (error.code === 'crypto') return 'Review ledger requires local SHA-256 support.';
  }
  return 'Invalid review ledger. Existing review markers have not been changed.';
}

export default function BatchLedgerPanel({ index, ledger, onRestore }: {
  index: BatchIndex; ledger: ReviewLedger; onRestore: (next: ReviewLedger) => void;
}) {
  const generation = useRef(0);
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<{ text: string; error: boolean } | null>(null);
  const [candidate, setCandidate] = useState<ReviewLedger | null>(null);
  useEffect(() => () => { generation.current++; }, [index]);

  function clearCandidate() {
    generation.current++;
    setCandidate(null);
    setPending(false);
    setFeedback(null);
  }

  async function read(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file) return;
    clearCandidate();
    const token = generation.current;
    setPending(true);
    try {
      const result = await readLedger(file, index);
      if (token === generation.current) setCandidate(result);
    } catch (error) {
      if (token === generation.current) setFeedback({ text: message(error), error: true });
    } finally {
      if (token === generation.current) setPending(false);
    }
  }

  function apply() {
    if (!candidate) return;
    onRestore(candidate);
    setFeedback({ error: false, text: 'Restored ' + candidate.size + ' human review markers.' });
    setCandidate(null);
  }

  function exportLedger(csv: boolean) {
    try {
      if (csv) download('batch-review-summary.csv', serializeLedgerCsv(index, ledger),
        'text/csv;charset=utf-8');
      else download('batch-review-ledger.json', serializeLedger(index, ledger), 'application/json');
      setFeedback(null);
    } catch (error) {
      setFeedback({ error: true, text: message(error) });
    }
  }

  const counts = summarizeReviews(index, ledger);
  return <section className="batch-panel" aria-labelledby="batch-ledger-title">
    <h2 id="batch-ledger-title">Human review progress</h2>
    <p>Mark the cases you are working on or need to follow up. These are your own
      organizational labels, not verified findings or issuer approval.</p>
    <dl className="batch-metrics">
      {reviewStates.map(state => <div key={state}>
        <dt>{reviewStateNames[state]}</dt><dd>{counts[state]}</dd>
      </div>)}
    </dl>
    {!index.indexHash ? <p role="status" className="batch-note">
      Review export and restore require HTTPS or localhost for SHA-256.
    </p> : <>
      <p className="batch-muted">The ledger is tied to the exact index bytes and individual report
        fingerprints. Exports contain no saved quotations or source filenames. Reloading the
        page clears this session unless you export a ledger first.</p>
      <div className="batch-toolbar batch-ledger-controls">
        <button type="button" className="batch-secondary" onClick={() => exportLedger(false)}>
          Export review ledger JSON
        </button>
        <button type="button" className="batch-secondary" onClick={() => exportLedger(true)}>
          Export quote-free review CSV
        </button>
        <label className="batch-file-control">Restore review ledger JSON
          <input type="file" accept=".json,application/json" onChange={read} />
        </label>
      </div>
      {pending && <p role="status">Checking saved review ledger…</p>}
      {candidate && <div className="batch-note" role="region" aria-label="Review restore confirmation">
        <p>Found {candidate.size} saved human review markers. Applying them replaces the
          {ledger.size} current markers, but does not modify the evidence reports.</p>
        <div className="batch-toolbar">
          <button type="button" className="batch-secondary" onClick={apply}>Apply saved markers</button>
          <button type="button" className="batch-secondary" onClick={clearCandidate}>Cancel restore</button>
        </div>
      </div>}
    </>}
    {feedback && <p role={feedback.error ? 'alert' : 'status'}
      className={feedback.error ? 'batch-error' : 'batch-note'}>{feedback.text}</p>}
  </section>;
}
