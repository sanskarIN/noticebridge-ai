import { useMemo, useState } from 'react';
import type { Passage, Role } from './pdfChatCore';
import { tableCellQuestion, type CategoryTable, type TableIndex } from './pdfChatTables';

const names: Record<Role, string> = { original: 'Original / first PDF', revised: 'Updated / second PDF' };
const tableKey = (table: CategoryTable) => table.role + ':' + table.page + ':' + table.headers[0].ordinal;

export default function PdfChatTableExplorer({ indexes, onInspect, onAsk }: {
  indexes: Record<Role, TableIndex | null>;
  onInspect: (passage: Passage) => void;
  onAsk: (question: string, role: Role) => void;
}) {
  const tables = useMemo(() => Object.values(indexes).flatMap(index => index?.tables ?? []), [indexes]);
  const [selected, setSelected] = useState('');
  const table = tables.find(item => tableKey(item) === selected) ?? tables[0];
  if (!table) return null;
  return <details className="chat-panel chat-table-explorer">
    <summary>Explore aligned category tables ({tables.length})</summary>
    <p className="chat-note">Possible native-text tables, not verified row or column associations.
      Use the page viewer to inspect the original layout before relying on a cell.</p>
    <label className="chat-table-selector">Select table candidate
      <select value={tableKey(table)} onChange={event => setSelected(event.target.value)}>
        {tables.map((item, i) => <option key={tableKey(item)} value={tableKey(item)}>
          {names[item.role]} · page {item.page} · table {i + 1}
        </option>)}
      </select>
    </label>
    <div className="chat-table-scroll" tabIndex={0} role="region" aria-label="Aligned category table preview">
      <table>
        <caption>{names[table.role]} · physical PDF page {table.page}</caption>
        <thead><tr>{table.headers.map((header, i) =>
          <th key={header.ordinal} scope="col">
            {header.text}
            <button className="chat-button" type="button" onClick={() => onInspect(header)}
              aria-label={'Inspect table header ' + (i + 1)}>Source</button>
          </th>,
        )}</tr></thead>
        <tbody>{table.rows.map((row, i) => <tr key={row[0].ordinal}>
          <th scope="row">{row[0].text}
            <button type="button" className="chat-button" onClick={() => onInspect(row[0])}
              aria-label={'Inspect category row ' + (i + 1)}>Source</button>
          </th>
          {row.slice(1).map((cell, j) => {
            const question = tableCellQuestion(table, i, j + 1);
            return <td key={cell.ordinal}>
              <strong>{cell.text}</strong>
              <div className="chat-table-actions">
                <button type="button" className="chat-button" onClick={() => onInspect(cell)}
                  aria-label={'Inspect ' + table.headers[j + 1].text + ' for ' + row[0].text}>Source</button>
                {question && <button type="button" className="chat-button"
                  aria-label={'Ask ' + table.headers[j + 1].text + ' for ' + row[0].text}
                  onClick={() => onAsk(question, table.role)}>Ask</button>}
              </div>
            </td>;
          })}
        </tr>)}</tbody>
      </table>
    </div>
    <p className="chat-muted">Ask prefills a scoped physical-page question; it does not submit automatically.
      Cells that cannot round-trip through the supported question grammar have a source link only.</p>
  </details>;
}
