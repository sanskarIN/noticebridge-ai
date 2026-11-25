import type { Answer, Passage, Role, SearchIndex } from './pdfChatCore';
import { directFieldAnswer, directSourceKey } from './pdfChatDirectAnswer';

const names: Record<Role, string> = {
  original: 'The original / first PDF', revised: 'The updated / second PDF',
};
const comparisonText = {
  single_source: 'One recognized printed value was found in the selected indexed text.',
  same_text: 'The two indexed sources contain the same printed value text.',
  different_text: 'The two indexed sources contain different printed value text.',
  multiple_values: 'Multiple distinct printed values were found. No single value is chosen.',
  missing_value: 'One requested source has no recognized printed value. Do not infer removal.',
};

export default function PdfChatDirectAnswer({ index, answer, onInspect }: {
  index: SearchIndex; answer: Answer; onInspect: (passage: Passage) => void;
}) {
  const result = directFieldAnswer(index, answer);
  if (!result) return null;
  return <section className="chat-direct-answer" aria-label="Concise printed-field answer">
    <h4>At a glance: {result.field.label}</h4>
    <p>{comparisonText[result.comparison]}</p>
    {result.sides.map(side => <div className="chat-direct-side" key={side.role}>
      {side.distinctValues === 0 ? <p>{names[side.role]} has no recognized printed value in the selected indexed text.</p>
        : side.values.map(value => <div key={value.value} className="chat-direct-value">
          <p>{names[side.role]} prints <strong>“{value.value}”</strong> under the label
            {' '}“{value.sources[0].label}”.</p>
          <div className="chat-direct-links">
            {value.sources.map(source => <button type="button" className="chat-button"
              key={directSourceKey(source.source)} onClick={() => onInspect(source.source)}>
              Read {side.role} page {source.source.page}, fragment {source.source.ordinal}
            </button>)}
          </div>
          {value.occurrences > value.sources.length && <p className="chat-muted">
            {value.occurrences - value.sources.length} more occurrences not displayed.</p>}
        </div>)}
      {side.distinctValues > side.values.length && <p className="chat-note">
        {side.distinctValues - side.values.length} additional distinct printed values not displayed.
        Inspect the full source before drawing a conclusion.</p>}
      {side.otherMatchingPassages > 0 && <p className="chat-muted">
        Other matching passages are shown below; they may contain relevant conditions.</p>}
    </div>)}
    <p className="chat-muted">This is a deterministic summary of recognized labels in indexed text,
      not a complete or independently verified answer. It does not establish equivalent values,
      eligibility, an official amendment, or the absence of other requirements.</p>
  </section>;
}
