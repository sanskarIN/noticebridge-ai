import {useState,type FormEvent} from 'react';
import type {CollectionDocument} from './pdfChatCollection';
import type {Passage} from './pdfChatCore';
import {highlightedSegments} from './pdfChatEvidenceExplorer';
import {parseCollectionEvidencePage} from './pdfChatCollectionTools';
import {searchBooleanEvidence,booleanResultPage,inspectBooleanHit,MAX_BOOLEAN_QUERY,
  type BooleanSearchResult,type BooleanSearchSide} from './pdfChatBooleanEvidence';
type Props={documents:readonly CollectionDocument[];selected:string[];names:Map<string,string>;
  onInspect:(id:string,source:Passage,target:HTMLElement)=>void};
function Side({side,result,documents,names,onInspect}:Omit<Props,'selected'>&{side:BooleanSearchSide;result:BooleanSearchResult}){
  const [page,setPage]=useState(1);
  const shown=booleanResultPage(side.hits,page);
  return <section className="chat-answer" aria-label={'Boolean evidence '+names.get(side.documentId)}>
    <h4>{names.get(side.documentId)}</h4>
    <p>{side.hits.length} matching native fragments out of {side.examined} examined.</p>
    <p className="chat-muted">{side.coverage.pageState?.replaceAll('_',' ')??side.coverage.processedPages+' / '+side.coverage.pageCount+' pages indexed'}.
      {' '}{side.coverage.limited||side.coverage.missingPages.length?'Some native coverage is incomplete.':'Complete transcription is not established.'}</p>
    {!side.hits.length&&<p>No indexed match. Exclusions concern a single fragment, not the complete PDF.</p>}
    {shown.hits.map(hit=><article key={hit.source.page+':'+hit.source.ordinal} className="chat-citation">
      <p className="chat-muted">Page {hit.source.page} · fragment {hit.source.ordinal}</p>
      <p>{highlightedSegments(hit.source.text,hit.ranges).map(segment=>segment.match?<mark key={segment.start}>{segment.text}</mark>:
        <span key={segment.start}>{segment.text}</span>)}</p>
      <p>Matched positive phrases: {hit.matchedPhrases.join(' · ')}</p>
      <button type="button" className="chat-button" onClick={event=>onInspect(side.documentId,
        inspectBooleanHit(documents,result,side.documentId,hit),event.currentTarget)}>Inspect boolean match {hit.source.page}:{hit.source.ordinal}</button>
    </article>)}
    {shown.pages>1&&<div className="chat-toolbar">
      <button type="button" className="chat-button" disabled={page===1} onClick={()=>setPage(page-1)}>Previous boolean matches</button>
      <span>{shown.first}–{shown.last} of {side.hits.length}</span>
      <button type="button" className="chat-button" disabled={page===shown.pages} onClick={()=>setPage(page+1)}>Next boolean matches</button>
    </div>}
  </section>;
}
export default function PdfChatBooleanEvidence({documents,selected,names,onInspect}:Props){
  const [expression,setExpression]=useState('');
  const [physical,setPhysical]=useState('');
  const [ignoreAsciiCase,setIgnoreAsciiCase]=useState(true);
  const [result,setResult]=useState<BooleanSearchResult|null>(null);
  const [error,setError]=useState('');
  const [epoch,setEpoch]=useState(0);
  function clear(){setResult(null);setError('');}
  function submit(event:FormEvent<HTMLFormElement>){
    event.preventDefault();clear();
    try{setResult(searchBooleanEvidence(documents,{expression,documentIds:selected,page:parseCollectionEvidencePage(physical),ignoreAsciiCase}));
      setEpoch(old=>old+1);}
    catch{setError('Use quoted nonempty phrases and explicit uppercase AND, OR or NOT, with balanced parentheses. Each alternative must require a positive phrase.');}
  }
  return <details className="chat-collection-inspection" aria-label="Boolean literal evidence search">
    <summary>Search quoted phrases with AND, OR and NOT</summary>
    <p className="chat-note">Each expression is evaluated inside one native fragment. NOT excludes a phrase only from that
      fragment; it does not establish that the phrase is absent from the PDF or that a rule does not apply.
      Matches are inspection candidates, not chat answers.</p>
    <details><summary>Expression examples and rules</summary>
      <p><code>"application fee" AND "rural"</code></p>
      <p><code>("registration" OR "application") AND NOT "cancelled"</code></p>
      <p><code>"certificate" AND ("required" OR "mandatory")</code></p>
      <p>Use uppercase operators. NOT has highest precedence, followed by AND, then OR.
        Parentheses can change grouping. A purely negative alternative is rejected. Text is literal, including punctuation.</p>
      <button type="button" className="chat-button" disabled={!!expression.trim()} onClick={()=>{
        setExpression('"application fee" AND NOT "refundable"');clear();
      }}>Fill example expression</button>
    </details>
    <form className="chat-form" onSubmit={submit}>
      <label>Boolean evidence expression<textarea rows={3} value={expression} maxLength={MAX_BOOLEAN_QUERY}
        onChange={event=>{setExpression(event.target.value);clear();}}/></label>
      <label>Boolean physical page (optional)<input value={physical} maxLength={2} inputMode="numeric"
        onChange={event=>{setPhysical(event.target.value);clear();}}/></label>
      <label className="chat-checkbox"><input type="checkbox" checked={ignoreAsciiCase}
        onChange={event=>{setIgnoreAsciiCase(event.target.checked);clear();}}/> Ignore ASCII letter case</label>
      <button type="submit" className="chat-button" disabled={!selected.length||!expression.trim()}>Search boolean collection evidence</button>
    </form>
    {error&&<p role="alert" className="chat-error">{error}</p>}
    {result&&<div aria-label="Boolean collection evidence results">
      <p role="status">{result.total} matching native fragment(s) across {result.sides.length} selected PDF(s).</p>
      {result.sides.map(side=><Side key={epoch+':'+side.documentId} side={side} result={result} documents={documents}
        names={names} onInspect={onInspect}/>)}
    </div>}
  </details>;
}
