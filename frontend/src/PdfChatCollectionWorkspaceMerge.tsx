import {useMemo,useState} from 'react';
import type {CollectionDocument} from './pdfChatCollection';
import type {CollectionWorkspace} from './pdfChatCollectionWorkspace';
import {prepareWorkspaceMerge,workspaceMergeSummary,setWorkspaceMergeChoice,workspaceConflictPage,applyWorkspaceMerge,
  type MergeChoice,type WorkspaceMergeResolution} from './pdfChatCollectionWorkspaceMerge';

export default function PdfChatCollectionWorkspaceMerge({documents,current,imported,unchanged,onApply}:{
  documents:readonly CollectionDocument[];current:CollectionWorkspace;imported:CollectionWorkspace;
  unchanged:boolean;onApply:(workspace:CollectionWorkspace)=>void;
}){
  const [choices,setChoices]=useState<WorkspaceMergeResolution[]>([]);
  const [page,setPage]=useState(1);
  const [error,setError]=useState(false);
  const plan=useMemo(()=>prepareWorkspaceMerge(documents,current,imported),
    [documents,current.turns,current.reviews,imported]);
  const summary=workspaceMergeSummary(plan,choices);
  const shown=workspaceConflictPage(plan.conflicts,page);
  return <section className="chat-note" aria-label="Collection workspace merge preview">
    <h4>Merge instead of replacing</h4>
    <p>Keep the existing history and review notebook. Append new exact question steps and new annotations.
      Conflicting review notes or statuses require a choice; neither is assumed more accurate.</p>
    <div className="chat-collection-budget">
      <div><strong>{summary.newQuestions}</strong><span>New questions</span></div>
      <div><strong>{summary.duplicateQuestions}</strong><span>Duplicate imported questions</span></div>
      <div><strong>{summary.newReviews}</strong><span>New review fragments</span></div>
      <div><strong>{summary.identicalReviews}</strong><span>Identical annotations</span></div>
      <div><strong>{summary.resolved} / {summary.conflicts}</strong><span>Conflicts resolved</span></div>
    </div>
    <p>{summary.questions} question turns and {summary.reviews} review fragments after merge.</p>
    {summary.reason&&<p role="status">{summary.reason}</p>}
    {shown.rows.map(conflict=>{
      const index=documents.findIndex(row=>row.id===conflict.current.documentId)+1;
      const selected=choices.find(row=>row.key===conflict.key)?.choice??'';
      return <section className="chat-answer" key={conflict.key} aria-label={'Conflicting annotation '+conflict.key}>
        <h5>PDF {index} · page {conflict.current.source.page} · fragment {conflict.current.source.ordinal}</h5>
        <blockquote>{conflict.current.source.text}</blockquote>
        <div className="chat-collection-filter-grid">
          <div><strong>Current annotation</strong><p>Status: {conflict.current.status.replaceAll('_',' ')}</p>
            <p>{conflict.current.note||'(No note)'}</p></div>
          <div><strong>Imported annotation</strong><p>Status: {conflict.imported.status.replaceAll('_',' ')}</p>
            <p>{conflict.imported.note||'(No note)'}</p></div>
        </div>
        <label>Resolve differing {conflict.noteDiffers&&conflict.statusDiffers?'note and status':conflict.noteDiffers?'note':'status'}
          <select value={selected} disabled={!unchanged} onChange={event=>{
            const value=event.target.value as MergeChoice|'';
            setChoices(old=>setWorkspaceMergeChoice(plan,old,conflict.key,value||null));setError(false);
          }}>
            <option value="">Choose explicitly</option>
            <option value="keep_current">Keep current annotation</option>
            <option value="use_imported">Use imported annotation</option>
          </select>
        </label>
      </section>;
    })}
    {shown.pages>1&&<div className="chat-toolbar" aria-label="Workspace merge conflict pagination">
      <button type="button" className="chat-button" disabled={page===1} onClick={()=>setPage(page-1)}>Previous conflicts</button>
      <span>Page {page} of {shown.pages}</span>
      <button type="button" className="chat-button" disabled={page===shown.pages} onClick={()=>setPage(page+1)}>Next conflicts</button>
    </div>}
    <button type="button" className="chat-button" disabled={!unchanged||!summary.ready} onClick={()=>{
      try{onApply(applyWorkspaceMerge(documents,current,plan,choices));}catch{setError(true);}
    }}>Apply merged collection workspace</button>
    {error&&<p role="alert" className="chat-error">Merge could not be applied. Re-import the workspace to review the current state.</p>}
  </section>;
}
