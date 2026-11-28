import { useMemo } from 'react';
import type { Answer, Passage, Role } from './pdfChatCore';
import { answerCategoryTable, type TableIndex } from './pdfChatTables';

const names: Record<Role, string> = { original: 'Original / first PDF', revised: 'Updated / second PDF' };

export default function PdfChatTableAnswer({ indexes, answer, onInspect }: {
  indexes: Record<Role, TableIndex | null>; answer: Answer; onInspect: (passage: Passage) => void;
}) {
  const result = useMemo(() => answerCategoryTable(
    Object.values(indexes).flatMap(index => index?.tables ?? []), answer,
  ), [indexes, answer]);
  if (!result) return null;
  return <section className="chat-direct-answer" aria-label="Aligned table evidence candidates">
    <h4>Possible table answer</h4>
    <p className="chat-note">These are candidates from aligned native PDF text with explicit category and field headers.
      Alignment is not proof of a table's structure or that a value applies to you. Inspect the full page.</p>
    {result.matches.map((match, i) => <div className="chat-direct-side" key={match.role + ':' + match.page + ':' + match.value.ordinal}>
      <p className="chat-muted">{names[match.role]} · physical page {match.page} · candidate {i + 1}</p>
      <dl className="chat-table-evidence">
        <dt>Category header</dt><dd>{match.categoryHeader.text}</dd>
        <dt>Field header</dt><dd>{match.fieldHeader.text}</dd>
        <dt>Row category</dt><dd>{match.category.text}</dd>
        <dt>Aligned cell text</dt><dd><strong>{match.value.text}</strong></dd>
      </dl>
      <button className="chat-button" type="button" onClick={() => onInspect(match.value)}>Inspect table candidate {i + 1}</button>
    </div>)}
    {result.missingRoles.length > 0 && <p className="chat-note">No matching aligned table candidate in
      {' '}{result.missingRoles.map(role => names[role]).join(', ')}. This does not establish removal or absence.</p>}
    {result.total > result.matches.length && <p className="chat-note">{result.total - result.matches.length} more
      candidates not displayed. Inspect the documents.</p>}
    <p className="chat-muted">No OCR, merged-cell inference, category equivalence, or table-authority verification is performed.
      Other source passages remain independent of this layout experiment.</p>
  </section>;
}
