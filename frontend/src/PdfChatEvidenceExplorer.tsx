import { useState, type FormEvent } from 'react';
import { pageCoverage, type Answer, type Passage, type Role, type Scope, type SearchIndex } from './pdfChatCore';
import type { ChatCorpora } from './pdfChatEvidenceReport';
import { explorerPage, highlightedSegments, MAX_LITERAL_CHARS, parseReference,
  questionReferences, searchAllQuestionMatches, searchLiteral, searchReference,
  type ExplorerResult, type Reference, type SearchOptions } from './pdfChatEvidenceExplorer';

const names: Record<Role, string> = {
  original: 'Original / first PDF', revised: 'Updated / second PDF',
};
function ResultList({ result, onInspect }: {
  result: ExplorerResult; onInspect: (source: Passage) => void;
}) {
  const [page, setPage] = useState(1);
  const current = explorerPage(result.hits, page);
  return <div className="chat-explorer-results">
    <p role="status">{result.hits.length} matching indexed fragments — original:
      {' '}{result.countByRole.original}, revised: {result.countByRole.revised}.</p>
    {!result.hits.length && <p>No matching indexed fragment was found. This does not establish
      absence from the actual PDF.</p>}
    {current.hits.map(hit => <div className="chat-citation"
      key={hit.source.role + ':' + hit.source.page + ':' + hit.source.ordinal}>
      <p className="chat-muted">{names[hit.source.role]} · physical page {hit.source.page}
        {' '}· fragment {hit.source.ordinal}</p>
      {hit.startsWithReference !== undefined && <p className="chat-muted">
        {hit.startsWithReference ? 'Fragment starts with reference' : 'Reference appears within fragment'}.
        This does not identify a verified clause definition.</p>}
      <p>{highlightedSegments(hit.source.text, hit.ranges).map(segment =>
        segment.match ? <mark key={segment.start}>{segment.text}</mark> :
          <span key={segment.start}>{segment.text}</span>)}</p>
      <button type="button" className="chat-button" onClick={() => onInspect(hit.source)}>
        Inspect {hit.source.role} page {hit.source.page}, fragment {hit.source.ordinal}
      </button>
    </div>)}
    {current.pages > 1 && <div className="chat-toolbar" aria-label="Evidence result pagination">
      <button type="button" className="chat-button" disabled={page === 1}
        onClick={() => setPage(old => old - 1)}>Previous results</button>
      <p className="chat-muted">{current.first}–{current.last} of {result.hits.length}
        {' '}· results page {page} of {current.pages}</p>
      <button type="button" className="chat-button" disabled={page === current.pages}
        onClick={() => setPage(old => old + 1)}>Next results</button>
    </div>}
  </div>;
}
function CoverageNote({ corpora, options }: { corpora: ChatCorpora; options: SearchOptions }) {
  const roles: Role[] = options.scope === 'both' ? ['original', 'revised'] : [options.scope];
  const pageMessages = {
    not_present: 'does not exist', not_indexed: 'was not indexed',
    no_indexed_text: 'has no indexed native text', limited: 'was only partially indexed',
    some_text: 'contains some indexed native text',
  };
  return <div className="chat-note">
    {roles.map(role => {
      const corpus = corpora[role];
      if (!corpus) return <p key={role}>{names[role]} is not attached.</p>;
      const page = options.page;
      if (page !== undefined) return <p key={role}>{names[role]}: physical page {page}
        {' '}{pageMessages[pageCoverage(corpus, page)]}.</p>;
      return <p key={role}>{names[role]}: {corpus.processedPages}/{corpus.pageCount} physical pages
        processed. {corpus.limited || corpus.missingPages.length > 0
          ? 'Some native-text coverage is incomplete.' : 'Indexed text may still be incomplete.'}</p>;
    })}
    <p>Search results exclude imported OCR and image-only text. Highlights are text offsets, not PDF coordinates.</p>
  </div>;
}

export function PdfChatQuestionEvidence({ index, answer, corpora, onInspect }: {
  index: SearchIndex; answer: Answer; corpora: ChatCorpora; onInspect: (source: Passage) => void;
}) {
  const [choice, setChoice] = useState<{ result: ExplorerResult; label: string; epoch: number } | null>(null);
  const [error, setError] = useState(false);
  const references = questionReferences(answer.question);
  const more = Object.values(answer.matchedCounts).some(count => count > 4);
  if (!more && !references.length) return null;
  const options = { scope: answer.scope, page: answer.pageFilter };
  function choose(label: string, search: () => ExplorerResult) {
    try {
      const result = search();
      setChoice(old => ({ result, label, epoch: (old?.epoch ?? 0) + 1 }));
      setError(false);
    } catch { setChoice(null); setError(true); }
  }
  function referenceSearch(ref: Reference) {
    choose(ref.kind + ' ' + ref.identifier, () => searchReference(index, options, ref));
  }
  return <section className="chat-context-results" aria-label="Explore question evidence">
    <h4>Explore more question evidence</h4>
    <p className="chat-muted">Inspect additional indexed matches or explicit references within
      the same source/page scope. These results do not change the original answer.</p>
    <div className="chat-toolbar">
      {more && <button type="button" className="chat-button"
        onClick={() => choose('All strict matches', () => searchAllQuestionMatches(index, answer))}>
        Show all strict matching passages
      </button>}
      {references.map(ref => <button type="button" className="chat-button"
        key={ref.kind + ':' + ref.identifier} onClick={() => referenceSearch(ref)}>
        Find {ref.kind} {ref.identifier}
      </button>)}
    </div>
    {error && <p role="alert" className="chat-error">Unable to explore the selected evidence.</p>}
    {choice && <>
      <h4>{choice.label}</h4>
      <CoverageNote corpora={corpora} options={options} />
      <ResultList key={choice.epoch} result={choice.result} onInspect={onInspect} />
      <button className="chat-button" type="button" onClick={() => setChoice(null)}>Hide additional evidence</button>
    </>}
  </section>;
}

export default function PdfChatEvidenceExplorer({ index, corpora, onInspect }: {
  index: SearchIndex; corpora: ChatCorpora; onInspect: (source: Passage) => void;
}) {
  const [mode, setMode] = useState<'literal' | 'reference'>('literal');
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<Scope>('both');
  const [physicalPage, setPhysicalPage] = useState('');
  const [ignoreCase, setIgnoreCase] = useState(true);
  const [result, setResult] = useState<{ data: ExplorerResult; options: SearchOptions } | null>(null);
  const [error, setError] = useState('');
  const [epoch, setEpoch] = useState(0);
  function reset() { setResult(null); setError(''); }
  function search(event: FormEvent) {
    event.preventDefault();
    reset();
    if (!query.trim()) { setError('Enter a literal phrase or explicit reference.'); return; }
    const page = physicalPage.trim() ? Number(physicalPage) : undefined;
    if (page !== undefined && (!/^\d{1,2}$/.test(physicalPage.trim()) ||
        !Number.isInteger(page) || page < 1 || page > 80)) {
      setError('Enter one physical page from 1 to 80, or leave it blank.'); return;
    }
    const options = { scope, page };
    try {
      const data = mode === 'literal' ? searchLiteral(index, options, query, ignoreCase)
        : searchReference(index, options, parseReference(query));
      setEpoch(old => old + 1);
      setResult({ data, options });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Evidence search failed.');
    }
  }
  return <details className="chat-panel chat-embedding-panel">
    <summary>Explore indexed PDF evidence</summary>
    <p className="chat-note">Search exact text or explicit clause, section and similar references
      without asking a chat question. All matches are inspection leads, not factual conclusions.</p>
    <form className="chat-form" onSubmit={search}>
      <label>Evidence search mode
        <select value={mode} onChange={event => { setMode(event.target.value as typeof mode); reset(); }}>
          <option value="literal">Literal phrase</option>
          <option value="reference">Explicit reference</option>
        </select>
      </label>
      <label>Evidence search text
        <input type="text" value={query} maxLength={MAX_LITERAL_CHARS}
          placeholder={mode === 'literal' ? 'application fee' : 'Clause 4.2(a)'}
          onChange={event => { setQuery(event.target.value); reset(); }} />
      </label>
      <label>Evidence source filter
        <select value={scope} onChange={event => { setScope(event.target.value as Scope); reset(); }}>
          <option value="both">Both PDFs</option>
          <option value="original">Original / first PDF</option>
          <option value="revised">Updated / second PDF</option>
        </select>
      </label>
      <label>Evidence physical page (optional)
        <input type="text" inputMode="numeric" value={physicalPage} maxLength={2}
          onChange={event => { setPhysicalPage(event.target.value); reset(); }} />
      </label>
      {mode === 'literal' && <label className="chat-checkbox">
        <input type="checkbox" checked={ignoreCase}
          onChange={event => { setIgnoreCase(event.target.checked); reset(); }} /> Ignore ASCII letter case
      </label>}
      <p className="chat-muted">{mode === 'literal'
        ? 'Search within one extracted fragment at a time. Spacing and non-ASCII characters must match exactly.'
        : 'Use singular references such as Clause 4.2(a), Section 12, or Annexure B. Mentions are not definitions.'}</p>
      <button type="submit" className="chat-button">Search indexed evidence</button>
    </form>
    {error && <p role="alert" className="chat-error">{error}</p>}
    {result && <>
      <CoverageNote corpora={corpora} options={result.options} />
      <ResultList key={epoch} result={result.data} onInspect={onInspect} />
    </>}
  </details>;
}
