import { useState, type FormEvent } from 'react';
import { pageCoverage, type Answer, type Passage, type Role, type Scope, type SearchIndex } from './pdfChatCore';
import { highlightedSegments } from './pdfChatEvidenceExplorer';
import type { ChatCorpora } from './pdfChatEvidenceReport';
import { parseRequirementQuestion } from './pdfChatInsights';
import { findRequirements, requirementKinds, requirementPage, REQUIREMENT_KEYWORD_LIMIT,
  type RequirementIndex, type RequirementKind, type RequirementOptions, type RequirementResults } from './pdfChatRequirements';

const labels: Record<RequirementKind | 'all', string> = {
  all: 'All cue categories', mandatory: 'Mandatory wording', prohibited: 'Prohibition wording',
  exception: 'Exception or condition wording', permission: 'Permission wording', recommendation: 'Recommendation wording',
};
const names: Record<Role, string> = { original: 'Original / first PDF', revised: 'Updated / second PDF' };

function Coverage({ corpora, options }: { corpora: ChatCorpora; options: RequirementOptions }) {
  const roles: Role[] = options.scope === 'both' ? ['original', 'revised'] : [options.scope];
  const messages = {
    not_present: 'Physical page does not exist.',
    not_indexed: 'Physical page was not indexed.',
    no_indexed_text: 'No native text was indexed on this page.',
    limited: 'Physical page was only partially indexed.',
    some_text: 'Some native text was indexed on this page.',
  };
  return <div className="chat-note">
    {roles.map(role => {
      const corpus = corpora[role];
      if (!corpus) return <p key={role}>{names[role]} is not attached.</p>;
      return <p key={role}>{names[role]}: {options.page === undefined
        ? corpus.processedPages + '/' + corpus.pageCount + ' physical pages processed. ' +
          (corpus.limited || corpus.missingPages.length ? 'Native text coverage is incomplete.' : 'Extraction may still omit content.')
        : messages[pageCoverage(corpus, options.page)]}</p>;
    })}
    <p>Cue detection can miss obligations, exceptions, image text and complex wording. It does not determine applicability.</p>
  </div>;
}
function Results({ result, onInspect }: { result: RequirementResults; onInspect: (source: Passage) => void }) {
  const [page, setPage] = useState(1);
  const current = requirementPage(result, page);
  return <div className="chat-requirement-results">
    <p role="status">{result.hits.length} cue-bearing fragments found in this search ·
      {' '}{result.countByRole.original} original · {result.countByRole.revised} revised.</p>
    <p className="chat-muted">{result.scopedCandidates} cue-bearing fragments among
      {' '}{result.scopedFragments} indexed fragments in the selected scope.</p>
    <div className="chat-toolbar">
      {requirementKinds.map(kind => <span className="chat-muted" key={kind}>
        {labels[kind]}: {result.countByKind[kind]}
      </span>)}
    </div>
    <p className="chat-muted">A fragment may contain several cue categories; these category counts overlap.</p>
    {!current.hits.length && <p>No cue-bearing fragment matches these filters. This does not establish absence of requirements.</p>}
    {current.hits.map(hit => <div className="chat-citation" key={hit.source.role + ':' + hit.source.page + ':' + hit.source.ordinal}>
      <p className="chat-muted">{names[hit.source.role]} · physical page {hit.source.page}
        {' '}· fragment {hit.source.ordinal}</p>
      <p><strong>{hit.kinds.map(kind => labels[kind]).join(' · ')}</strong></p>
      <p>{highlightedSegments(hit.source.text, hit.cues).map(segment => segment.match
        ? <mark key={segment.start}>{segment.text}</mark> : <span key={segment.start}>{segment.text}</span>)}</p>
      {hit.totalCues > hit.cues.length && <p className="chat-muted">{hit.totalCues - hit.cues.length}
        {' '}additional cue occurrences not highlighted.</p>}
      {hit.exactOtherOccurrences !== null && <p className="chat-muted">
        {hit.exactOtherOccurrences ? hit.exactOtherOccurrences + ' exact-wording occurrence(s) indexed in the other PDF.'
          : 'No identical wording indexed in the other PDF within this scope.'}
        {' '}This does not establish a change or equivalent meaning.</p>}
      <button className="chat-button" type="button" onClick={() => onInspect(hit.source)}>
        Inspect requirement source {hit.source.role} page {hit.source.page}, fragment {hit.source.ordinal}
      </button>
    </div>)}
    {current.pages > 1 && <div className="chat-toolbar">
      <button type="button" className="chat-button" disabled={page === 1}
        onClick={() => setPage(old => old - 1)}>Previous requirement results</button>
      <span>{current.first}–{current.last} of {result.hits.length}</span>
      <button type="button" className="chat-button" disabled={page === current.pages}
        onClick={() => setPage(old => old + 1)}>Next requirement results</button>
    </div>}
  </div>;
}
type Props = {
  index: SearchIndex; requirements: RequirementIndex; corpora: ChatCorpora;
  attached: Role[]; onInspect: (source: Passage) => void;
};

export function PdfChatRequirementAnswer({ index, requirements, corpora, attached, onInspect, answer }: Props & {
  answer: Answer;
}) {
  const [result, setResult] = useState<RequirementResults | null>(null);
  const kind = parseRequirementQuestion(answer.question);
  if (!kind) return null;
  const options: RequirementOptions = { scope: answer.scope, page: answer.pageFilter, kind };
  return <section className="chat-context-results" aria-label="Question requirement discovery">
    <h4>Explore printed requirements and conditions</h4>
    <p className="chat-note">This is a cue-based inspection view for your broad question.
      It is separate from the strict matching answer and cannot determine what you personally must do.</p>
    <button className="chat-button" type="button" aria-expanded={Boolean(result)}
      onClick={() => setResult(old => old ? null : findRequirements(index, requirements, options, attached))}>
      {result ? 'Hide requirement candidates' : 'Explore ' + labels[kind].toLowerCase()}
    </button>
    {result && <>
      <Coverage corpora={corpora} options={options} />
      <Results result={result} onInspect={onInspect} />
    </>}
  </section>;
}

export default function PdfChatRequirements({ index, requirements, corpora, attached, onInspect }: Props) {
  const [scope, setScope] = useState<Scope>('both');
  const [kind, setKind] = useState<RequirementKind | 'all'>('all');
  const [keyword, setKeyword] = useState('');
  const [pageText, setPageText] = useState('');
  const [result, setResult] = useState<{ options: RequirementOptions; data: RequirementResults; epoch: number } | null>(null);
  const [error, setError] = useState('');
  const [epoch, setEpoch] = useState(0);
  function reset() { setResult(null); setError(''); }
  function search(event: FormEvent) {
    event.preventDefault();
    reset();
    const page = pageText.trim() ? Number(pageText) : undefined;
    if (page !== undefined && (!/^[0-9]{1,2}$/.test(pageText.trim()) ||
        !Number.isSafeInteger(page) || page < 1 || page > 80)) {
      setError('Enter one physical page from 1 to 80, or leave it blank.'); return;
    }
    const options = { scope, kind, keyword, page };
    try {
      const data = findRequirements(index, requirements, options, attached);
      setEpoch(old => old + 1); setResult({ options, data, epoch: epoch + 1 });
    } catch { setError('Unable to search the selected indexed requirements.'); }
  }
  return <details className="chat-panel chat-embedding-panel">
    <summary>Explore requirements and exceptions</summary>
    <p className="chat-note">Find fragments containing explicit English wording such as must, must not,
      unless, optional and should. These are review leads, not verified rules or personal eligibility decisions.</p>
    <p className="chat-muted">{requirements.candidates.length} cue-bearing fragments in the native index.</p>
    <form className="chat-form" onSubmit={search}>
      <label>Requirement source filter
        <select value={scope} onChange={event => { setScope(event.target.value as Scope); reset(); }}>
          <option value="both">Both PDFs</option>
          <option value="original">Original / first PDF</option>
          <option value="revised">Updated / second PDF</option>
        </select>
      </label>
      <label>Requirement wording category
        <select value={kind} onChange={event => { setKind(event.target.value as typeof kind); reset(); }}>
          <option value="all">{labels.all}</option>
          {requirementKinds.map(item => <option key={item} value={item}>{labels[item]}</option>)}
        </select>
      </label>
      <label>Requirement text filter (optional)
        <input type="text" value={keyword} maxLength={REQUIREMENT_KEYWORD_LIMIT}
          onChange={event => { setKeyword(event.target.value); reset(); }} placeholder="certificate" />
      </label>
      <label>Requirement physical page (optional)
        <input type="text" inputMode="numeric" maxLength={2} value={pageText}
          onChange={event => { setPageText(event.target.value); reset(); }} />
      </label>
      <button className="chat-button" type="submit">Search requirement wording</button>
    </form>
    {error && <p role="alert" className="chat-error">{error}</p>}
    {result && <section aria-label="Requirement discovery results">
      <Coverage corpora={corpora} options={result.options} />
      <Results key={result.epoch} result={result.data} onInspect={onInspect} />
    </section>}
  </details>;
}
