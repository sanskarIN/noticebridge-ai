import { useState } from 'react';
import type { Passage } from './pdfChatCore';
import type { DirectAnswer } from './pdfChatDirectAnswer';
import { comparePrintedScalars, scalarExplanation, scalarFieldKind, type ScalarFailure } from './pdfChatScalarComparison';

const reasons: Record<ScalarFailure, string> = {
  single_source: 'Two requested sources are required.',
  unsupported_field: 'Only recognized fees and calendar dates are supported.',
  missing_value: 'At least one requested source has no recognized printed value.',
  competing_values: 'At least one source contains competing printed values.',
  possible_conditions: 'Additional matching or nearby text may contain conditions. Inspect that text first.',
  unrecognized_value: 'A value is not a supported single explicit currency amount or unambiguous calendar date.',
  different_currency: 'Currency labels differ or are not equivalent. No currency conversion is assumed.',
};

export default function PdfChatScalarComparison({ result, onInspect }: {
  result: DirectAnswer; onInspect: (source: Passage) => void;
}) {
  const [open, setOpen] = useState(false);
  if (result.sides.length !== 2 || !scalarFieldKind(result.field.id)) return null;
  const comparison = comparePrintedScalars(result);
  return <section className="chat-context-results" aria-label="Printed scalar comparison">
    <h4>Compare the printed values</h4>
    <p className="chat-muted">Optional exact arithmetic on the recognized fee amounts or calendar dates,
      not an interpretation of which notice is authoritative or what applies to you.</p>
    <button type="button" className="chat-button" aria-expanded={open}
      onClick={() => setOpen(value => !value)}>{open ? 'Hide numeric comparison' : 'Calculate printed difference'}</button>
    {open && (comparison.status === 'unavailable'
      ? <p className="chat-note">Comparison withheld. {reasons[comparison.reason]}</p>
      : <div>
        <p><strong>{scalarExplanation(comparison)}</strong></p>
        <div className="chat-field-grid">
          {[comparison.original, comparison.revised].map(source => <div key={source.source.role}>
            <p className="chat-muted">{source.source.role === 'original' ? 'Original / first PDF' : 'Updated / second PDF'}</p>
            <p>{source.label}: <strong>{source.value}</strong></p>
            <button type="button" className="chat-button" onClick={() => onInspect(source.source)}>
              Inspect {source.source.role} printed value on page {source.source.page}
            </button>
          </div>)}
        </div>
        {comparison.kind === 'money' && comparison.currency === 'RS' && <p className="chat-note">
          Both amounts use an unspecified Rs. label. This is a numeric comparison, not confirmation
          that they represent the same national currency.</p>}
        <p className="chat-note">This compares only the literal values retrieved in the selected indexed
          scope. It does not establish fee liability, a deadline extension, equal applicant conditions,
          a valid amendment or complete PDF coverage. Review both full notices before acting.</p>
      </div>)}
  </section>;
}
