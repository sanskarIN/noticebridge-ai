import { useMemo, useState } from 'react';
import type { Passage, Role, SearchIndex } from './pdfChatCore';
import { buildNoticeOverview, type OverviewField, type OverviewSide } from './pdfChatOverview';

const names: Record<Role, string> = { original: 'Original / first PDF', revised: 'Updated / second PDF' };
const outcomes: Record<OverviewField['outcome'], string> = {
  one_source_only: 'Field found in one indexed source only',
  same_printed_text: 'Same printed value text',
  different_printed_text: 'Different printed value text',
  multiple_printed_values: 'Multiple printed values — inspect the sources',
};

function Side({ side, attached, onInspect }: {
  side: OverviewSide; attached: boolean; onInspect: (passage: Passage) => void;
}) {
  return <div className="chat-overview-side">
    <h4>{names[side.role]}</h4>
    {!attached ? <p className="chat-muted">Source not attached.</p>
      : side.values.length === 0 ? <p className="chat-muted">No recognized printed field found. This is not proof of absence.</p>
        : side.values.map(value => <div className="chat-overview-value" key={value.value}>
          <p><strong>{value.value}</strong></p>
          {value.citations.map(field => <div key={field.source.page + ':' + field.source.ordinal}>
            <p className="chat-muted">Printed label: {field.label}</p>
            <button className="chat-button" type="button" onClick={() => onInspect(field.source)}>
              Inspect {side.role} page {field.source.page}
            </button>
          </div>)}
          {value.occurrences > value.citations.length && <p className="chat-muted">
            {value.occurrences - value.citations.length} additional matching fragments not shown.
          </p>}
        </div>)}
    {side.distinctValues > side.values.length && <p className="chat-note">
      {side.distinctValues - side.values.length} additional distinct printed values not shown. Inspect the full notice.
    </p>}
  </div>;
}

export default function PdfChatOverview({ index, attached, onInspect, onAsk }: {
  index: SearchIndex; attached: Role[];
  onInspect: (passage: Passage) => void; onAsk: (question: string) => void;
}) {
  const fields = useMemo(() => buildNoticeOverview(index), [index]);
  const [filter, setFilter] = useState<'all' | 'review'>('all');
  const visible = filter === 'all' ? fields : fields.filter(field =>
    field.outcome === 'different_printed_text' || field.outcome === 'multiple_printed_values' ||
    (field.outcome === 'one_source_only' && attached.length === 2),
  );
  if (!attached.length) return null;
  return <section className="chat-panel" aria-labelledby="overview-title">
    <div className="chat-toolbar">
      <h2 id="overview-title">Document overview</h2>
      <label className="chat-overview-filter">Overview filter
        <select value={filter} onChange={event => setFilter(event.target.value as 'all' | 'review')}>
          <option value="all">All recognized fields</option>
          <option value="review">Fields needing comparison review</option>
        </select>
      </label>
    </div>
    <p>Extracted printed fields from the attached PDFs, grouped by a fixed notice-field vocabulary.
      This is a limited extractive overview, not a complete document summary or verified amendment list.</p>
    <p className="chat-muted">{fields.length} recognized field categories. Original wording is preserved
      in the linked source fragments. Scans, unrecognized labels and multi-line values can be missed.</p>
    {!visible.length && <p className="chat-muted">{fields.length
      ? 'No recognized field categories match this filter.'
      : 'No recognized printed fields found. You can still ask a question or inspect the PDF.'}</p>}
    {visible.map(field => <article className="chat-field-pair chat-overview-field" key={field.definition.id}>
      <div className="chat-toolbar">
        <h3>{field.definition.label}</h3>
        <button type="button" className="chat-button" onClick={() => onAsk(field.definition.query)}>
          Ask about {field.definition.label.toLowerCase()}
        </button>
      </div>
      {attached.length === 2 && <p className="chat-muted">{outcomes[field.outcome]}</p>}
      {field.outcome === 'multiple_printed_values' && <p className="chat-note">More than one distinct
        value was found for this field. No single value is selected.</p>}
      <div className="chat-field-grid">
        <Side side={field.original} attached={attached.includes('original')} onInspect={onInspect} />
        <Side side={field.revised} attached={attached.includes('revised')} onInspect={onInspect} />
      </div>
    </article>)}
    <p className="chat-muted">Matching labels use a narrow fixed alias list. Different value strings
      do not necessarily establish a factual change; missing fields do not establish removal.</p>
  </section>;
}
