import {useMemo} from 'react';
import {previewCollectionDraft,draftFieldLabel,type DraftPart} from './pdfChatCollectionComposer';
import type {CollectionDocument,CollectionTurn} from './pdfChatCollection';
const coverage={some_text:'Some native text indexed',partial:'Partial native coverage',no_indexed_text:'No indexed native text',
  not_present:'Page not present',not_indexed:'Page not indexed'} as const;
function Part({part,names}:{part:DraftPart;names:Map<string,string>}){
  const field=draftFieldLabel(part.field);
  return <article className="chat-overview-side">
    <h5>{part.question}</h5>
    <p>Physical scope: {part.page===null?'all indexed pages':'page '+part.page}.</p>
    {field&&<p>Recognized printed field: {field}.</p>}
    {part.broad&&<p>Separate source-linked {part.broad.kind==='summary'?'overview':part.broad.kind==='requirements'?'requirement':'reference'} inspection is available.</p>}
    <p className="chat-muted">Strict query terms: {part.terms.length?part.terms.join(', '):'none'}.</p>
    {!part.strictTermBudget&&<p className="chat-note">Strict lexical matching requires one to sixteen terms. Consider a shorter, specific question.</p>}
    <ul>{part.scopes.map(row=><li key={row.id}>{names.get(row.id)??'Selected PDF'} — {coverage[row.coverage]}; {row.fragments} native fragment(s).</li>)}</ul>
  </article>;
}
export default function PdfChatCollectionComposer({documents,question,selected,includeContext,turns,names}:{
  documents:CollectionDocument[];question:string;selected:string[];includeContext:boolean;turns:CollectionTurn[];names:Map<string,string>;
}){
  const result=useMemo(()=>{
    if(!question.trim()||!selected.length)return null;
    try{return {preview:previewCollectionDraft(documents,question,selected,includeContext,turns)};}
    catch{return {error:true};}
  },[documents,question,selected,includeContext,turns]);
  if(!result)return null;
  if(!result.preview)return <p className="chat-note" aria-label="Question preview warning">The question could not be planned. Use independent PDF selection, at most four question parts, and at most one valid physical page per part.</p>;
  const preview=result.preview;
  return <details className="chat-context-results" aria-label="Collection question preview">
    <summary>Preview {preview.parts.length} question part(s) and {preview.searches} independent search(es)</summary>
    <p className="chat-muted">This preview has not run retrieval. Native coverage is not proof that a question can be answered.</p>
    <p>{preview.remainingTurns} conversation turn(s) remaining. Nearby-line candidates {preview.step.includeContext?'enabled':'disabled'}.</p>
    {preview.partial>0&&<p className="chat-note">{preview.partial} search scope(s) have partial native coverage.</p>}
    {preview.unavailable>0&&<p className="chat-note">{preview.unavailable} search scope(s) have unavailable native text or pages.</p>}
    {preview.repeatTurns.length>0&&<p className="chat-note">The same wording, selection and context mode were used in turn(s) {preview.repeatTurns.join(', ')}.</p>}
    <div className="chat-collection-matrix">{preview.parts.map((part,index)=><Part key={index} part={part} names={names}/>)}</div>
  </details>;
}
