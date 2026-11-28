import {useMemo,useState} from 'react';
import type {CollectionDocument} from './pdfChatCollection';
import type {Passage} from './pdfChatCore';
import {highlightedSegments} from './pdfChatEvidenceExplorer';
import {collectionReferenceIndex,filterReferenceIndex,referenceIndexPage,inspectReferenceOccurrence,referenceTrails,
  REFERENCE_KINDS,COLLECTION_REFERENCE_PAGE_SIZE,COLLECTION_REFERENCE_OCCURRENCE_PAGE_SIZE,
  type CollectionReferenceIndex,type ReferenceGroup,type ReferenceOccurrence,type ReferenceFilter} from './pdfChatCollectionReferences';
type Props={documents:readonly CollectionDocument[];names:Map<string,string>;onInspect:(id:string,source:Passage,target:HTMLElement)=>void};
const states={no_leading:'No leading identifier candidate',single_leading:'One leading identifier candidate',multiple_leading:'Repeated leading identifier candidates'};
function Occurrences({documents,names,onInspect,index,group,items}:Props&{index:CollectionReferenceIndex;group:ReferenceGroup;items:ReferenceOccurrence[]}){
  const [page,setPage]=useState(1);
  const current=referenceIndexPage(items,Math.min(page,Math.max(1,Math.ceil(items.length/COLLECTION_REFERENCE_OCCURRENCE_PAGE_SIZE))),COLLECTION_REFERENCE_OCCURRENCE_PAGE_SIZE);
  return <>
    {!items.length&&<p className="chat-muted">No matching occurrence in this indexed scope.</p>}
    {current.rows.map(item=><article className="chat-citation" key={item.documentId+':'+item.source.page+':'+item.source.ordinal+':'+item.range.start}>
      <p className="chat-muted">{names.get(item.documentId)} · page {item.source.page}, fragment {item.source.ordinal} · {item.leading?'Leading identifier':'Inline mention'}</p>
      <p>{highlightedSegments(item.source.text,[item.range]).map(segment=>segment.match?<mark key={segment.start}>{segment.text}</mark>:<span key={segment.start}>{segment.text}</span>)}</p>
      <button className="chat-button" type="button" onClick={event=>onInspect(item.documentId,inspectReferenceOccurrence(documents,index,group,item),event.currentTarget)}>
        Inspect reference occurrence {item.source.page}:{item.source.ordinal}</button>
    </article>)}
    {current.pages>1&&<div className="chat-toolbar">
      <button className="chat-button" type="button" disabled={page===1} onClick={()=>setPage(page-1)}>Previous reference occurrences</button>
      <span>{current.first}–{current.last} of {items.length}</span>
      <button className="chat-button" type="button" disabled={page===current.pages} onClick={()=>setPage(page+1)}>Next reference occurrences</button>
    </div>}
  </>;
}
function ReferenceDetails({documents,names,onInspect,index,group}:Props&{index:CollectionReferenceIndex;group:ReferenceGroup}){
  return <article className="chat-answer">
    <h4>{group.reference.kind} {group.reference.identifier}</h4>
    <p>{states[group.state]} · {group.documents} PDF(s) · {group.occurrences} native occurrence(s).</p>
    {group.sides.map(side=><details key={side.documentId}>
      <summary>{names.get(side.documentId)}: {side.leading.length} leading, {side.inline.length} inline</summary>
      <h5>Leading candidates</h5>
      <Occurrences documents={documents} names={names} onInspect={onInspect} index={index} group={group} items={side.leading}/>
      <h5>Inline mentions</h5>
      <Occurrences documents={documents} names={names} onInspect={onInspect} index={index} group={group} items={side.inline}/>
    </details>)}
  </article>;
}
export default function PdfChatCollectionReferences({documents,names,onInspect,selected}:Props&{selected:string[]}){
  const [open,setOpen]=useState(false);
  const [filter,setFilter]=useState<ReferenceFilter>({kind:'all',state:'all',documentId:'all',text:'',sharedOnly:false});
  const [page,setPage]=useState(1);
  const index=useMemo(()=>open&&selected.length?collectionReferenceIndex(documents,selected):null,[open,documents,selected]);
  const rows=index?filterReferenceIndex(index,filter):[];
  const current=referenceIndexPage(rows,Math.min(page,Math.max(1,Math.ceil(rows.length/COLLECTION_REFERENCE_PAGE_SIZE))));
  function change(update:Partial<ReferenceFilter>){setFilter(old=>({...old,...update}));setPage(1);}
  return <details className="chat-collection-inspection" aria-label="Collection reference index" onToggle={event=>setOpen(event.currentTarget.open)}>
    <summary>Browse printed clause and section references across PDFs</summary>
    <p className="chat-note">Leading identifiers and inline mentions are text candidates only. References may point outside
      this collection. Repeated identifiers are not proof of corresponding clauses, and no leading candidate is not proof of absence.</p>
    {open&&!index&&<p>Select at least one PDF.</p>}
    {index&&<>
      <div className="chat-collection-budget">
        <div><strong>{index.groups.length}</strong><span>Distinct reference identifiers</span></div>
        <div><strong>{index.totalOccurrences}</strong><span>Native reference occurrences</span></div>
        <div><strong>{index.examinedFragments}</strong><span>Examined native fragments</span></div>
      </div>
      {index.limited&&<p className="chat-note">Reference occurrence budget reached. Some selected sources were not fully examined.</p>}
      <details><summary>Reference index coverage by PDF</summary>
        {index.documentCoverage.map(doc=><p key={doc.documentId}>{names.get(doc.documentId)}: {doc.processedPages}/{doc.pageCount} pages processed,
          {' '}{doc.missingPages.length} without indexed text{doc.limited?', extraction limited':''}.</p>)}
      </details>
      <div className="chat-collection-filter-grid">
        <label>Reference kind<select value={filter.kind} onChange={event=>change({kind:event.target.value as ReferenceFilter['kind']})}>
          <option value="all">All kinds</option>{REFERENCE_KINDS.map(kind=><option key={kind} value={kind}>{kind}</option>)}
        </select></label>
        <label>Reference candidate state<select value={filter.state} onChange={event=>change({state:event.target.value as ReferenceFilter['state']})}>
          <option value="all">All states</option>{(Object.keys(states) as (keyof typeof states)[]).map(state=><option key={state} value={state}>{states[state]}</option>)}
        </select></label>
        <label>Reference source PDF<select value={filter.documentId} onChange={event=>change({documentId:event.target.value})}>
          <option value="all">All selected PDFs</option>{selected.map(id=><option key={id} value={id}>{names.get(id)}</option>)}
        </select></label>
        <label>Find reference identifier<input value={filter.text} maxLength={100} onChange={event=>change({text:event.target.value})}/></label>
        <label className="chat-checkbox"><input type="checkbox" checked={filter.sharedOnly} onChange={event=>change({sharedOnly:event.target.checked})}/> Occurs in multiple PDFs</label>
      </div>
      <p role="status">{rows.length} of {index.groups.length} reference identifier(s) match.</p>
      {current.rows.map(group=><ReferenceDetails key={group.key} documents={documents} names={names} onInspect={onInspect} index={index} group={group}/>)}
      {current.pages>1&&<div className="chat-toolbar">
        <button className="chat-button" type="button" disabled={page===1} onClick={()=>setPage(page-1)}>Previous reference identifiers</button>
        <span>{current.first}–{current.last} of {rows.length}</span>
        <button className="chat-button" type="button" disabled={page===current.pages} onClick={()=>setPage(page+1)}>Next reference identifiers</button>
      </div>}
    </>}
  </details>;
}
export function PdfChatCollectionReferenceTrail({documents,names,onInspect,documentId,source}:Props&{documentId:string;source:Passage}){
  const [open,setOpen]=useState(false);
  const [cross,setCross]=useState(false);
  const index=useMemo(()=>open?collectionReferenceIndex(documents,cross?documents.map(doc=>doc.id):[documentId]):null,
    [open,cross,documents,documentId]);
  const trails=index?referenceTrails(documents,index,documentId,source):[];
  return <details className="chat-collection-inspection" aria-label="Follow printed source references" onToggle={event=>setOpen(event.currentTarget.open)}>
    <summary>Follow explicit references printed in this fragment</summary>
    <p className="chat-note">One-hop search only. Candidate fragments are not automatically added to the answer or treated as definitions.</p>
    {open&&<>
      <label className="chat-checkbox"><input type="checkbox" checked={cross} onChange={event=>setCross(event.target.checked)}/> Also search other attached PDFs independently</label>
      {index?.limited&&<p className="chat-note">The occurrence budget was reached. Some candidate references may be missing.</p>}
      {!trails.length&&<p>No indexed explicit reference trail available.</p>}
      {trails.map(trail=><section key={trail.group.key} className="chat-answer">
        <h5>{trail.printed}</h5>
        <p>{trail.sameDocument.length} other occurrence(s) in the same PDF.</p>
        <Occurrences key={'same:'+cross} documents={documents} names={names} onInspect={onInspect} index={index!} group={trail.group} items={trail.sameDocument}/>
        {cross&&<details><summary>Independent other-PDF mentions ({trail.otherDocuments.length})</summary>
          <Occurrences documents={documents} names={names} onInspect={onInspect} index={index!} group={trail.group} items={trail.otherDocuments}/>
        </details>}
      </section>)}
    </>}
  </details>;
}
