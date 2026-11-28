import {useMemo,useState,type ReactNode} from 'react';
import type {CollectionDocument,CollectionPart,CollectionStep} from './pdfChatCollection';
import type {Passage} from './pdfChatCore';
import {highlightedSegments} from './pdfChatEvidenceExplorer';
import {requirementKinds} from './pdfChatRequirements';
import {broadCollectionIntent,collectionBrief,briefPage,inspectBriefSource,briefFieldDraft,type CollectionBrief} from './pdfChatCollectionBrief';
type Props={documents:readonly CollectionDocument[];documentId:string;part:CollectionPart;includeContext:boolean;draftDisabled:boolean;
  onInspect:(id:string,source:Passage,target:HTMLElement)=>void;onDraft:(step:CollectionStep)=>void};
function Paged<T>({rows,render,label}: {rows:readonly T[];render:(row:T,index:number)=>ReactNode;label:string}){
  const [page,setPage]=useState(1);
  const result=briefPage(rows,page);
  return <>
    {result.rows.map((row,i)=>render(row,result.first+i-1))}
    {!rows.length&&<p className="chat-muted">No matching native candidate in this scope.</p>}
    {result.pages>1&&<div className="chat-toolbar">
      <button type="button" className="chat-button" disabled={page===1} onClick={()=>setPage(page-1)}>Previous {label}</button>
      <span>{result.first}–{result.last} of {rows.length}</span>
      <button type="button" className="chat-button" disabled={page===result.pages} onClick={()=>setPage(page+1)}>Next {label}</button>
    </div>}
  </>;
}
function SourceButton({documents,brief,source,onInspect}:{documents:readonly CollectionDocument[];brief:CollectionBrief;source:Passage;onInspect:Props['onInspect']}){
  return <button type="button" className="chat-button" onClick={event=>onInspect(brief.documentId,
    inspectBriefSource(documents,brief,source),event.currentTarget)}>Inspect brief source {source.page}:{source.ordinal}</button>;
}
const labels={mandatory:'Mandatory',prohibited:'Prohibition',exception:'Exception or condition',permission:'Permission',recommendation:'Recommendation'};
export default function PdfChatCollectionBrief({documents,documentId,part,includeContext,draftDisabled,onDraft,onInspect}:Props){
  const intent=broadCollectionIntent(part.answer.question);
  const [open,setOpen]=useState(false);
  const brief=useMemo(()=>open&&intent?collectionBrief(documents,documentId,part,includeContext):null,[open,documents,documentId,part,includeContext,!!intent]);
  if(!intent)return null;
  const title=intent.kind==='summary'?'Source-linked native document overview':
    intent.kind==='requirements'?'Source-linked requirement discovery':'Source-linked printed reference discovery';
  return <details className="chat-collection-inspection" aria-label={title} onToggle={event=>setOpen(event.currentTarget.open)}>
    <summary>{title}</summary>
    <p className="chat-note">This broad-question view uses exact native evidence independently of strict lexical ranking.
      It does not generate a certified summary, verify official authority or change saved answer citations.</p>
    {brief&&<>
      <p>{brief.fragments} native fragment(s) in the requested scope. {brief.coverage.replaceAll('_',' ')}; complete transcription is not established.</p>
      {brief.intent.kind==='summary'&&<>
        <div className="chat-collection-budget">
          <div><strong>{brief.fields.length}</strong><span>Recognized printed field categories</span></div>
          <div><strong>{brief.headings.length}</strong><span>Heading candidates</span></div>
          <div><strong>{brief.requirements.length}</strong><span>Requirement-cue fragments</span></div>
        </div>
        <h5>Recognized printed fields</h5>
        <Paged rows={brief.fields} label="brief fields" render={field=><article className="chat-citation" key={field.definition.id}>
          <h5>{field.definition.label}</h5>
          <p>{field.distinctValues} distinct printed value(s). {field.distinctValues>1?'No single value is chosen.':''}</p>
          {field.values.map(value=><div key={value.value}>
            <p>{value.value}</p>{value.citations.map(citation=><SourceButton key={citation.source.page+':'+citation.source.ordinal}
              documents={documents} brief={brief} source={citation.source} onInspect={onInspect}/>)}
            {value.occurrences>value.citations.length&&<p>{value.occurrences-value.citations.length} further native occurrences.</p>}
          </div>)}
          {field.distinctValues>field.values.length&&<p>Additional distinct values exist beyond the display limit.</p>}
          <button type="button" className="chat-button" disabled={draftDisabled} onClick={()=>onDraft(briefFieldDraft(documents,brief,field,includeContext))}>Draft question about {field.definition.label.toLowerCase()}</button>
        </article>}/>
        <details><summary>Printed heading candidates ({brief.headings.length})</summary>
          <Paged rows={brief.headings} label="brief headings" render={row=><article key={row.source.page+':'+row.source.ordinal} className="chat-citation">
            <p>{row.source.text}</p><SourceButton documents={documents} brief={brief} source={row.source} onInspect={onInspect}/>
          </article>}/>
        </details>
        <details><summary>Physical-page opening fragment sample ({brief.sampledPages} of {brief.scopedPages} indexed pages)</summary>
          <p className="chat-muted">The first retained fragment from each sampled physical page is an orientation aid, not a representative semantic summary.</p>
          {brief.sampleLimited&&<p>Evenly spaced indexed pages were sampled, including the first and last.</p>}
          <Paged rows={brief.sample} label="brief sample fragments" render={source=><article key={source.page+':'+source.ordinal} className="chat-citation">
            <p>{source.text}</p><SourceButton documents={documents} brief={brief} source={source} onInspect={onInspect}/>
          </article>}/>
        </details>
      </>}
      {brief.intent.kind!=='references'&&<details open={brief.intent.kind==='requirements'}><summary>Requirement and exception wording ({brief.requirements.length} candidates)</summary>
        <p className="chat-muted">Cue categories overlap. These fragments are not an action plan or determination of applicability.</p>
        <div className="chat-toolbar">{requirementKinds.map(kind=><span key={kind}>{labels[kind]}: {brief.requirementCounts[kind]}</span>)}</div>
        <Paged rows={brief.requirements} label="brief requirements" render={row=><article className="chat-citation" key={row.source.page+':'+row.source.ordinal}>
          <p>{row.kinds.map(kind=>labels[kind]).join(' · ')}</p>
          <p>{highlightedSegments(row.source.text,row.cues).map(segment=>segment.match?<mark key={segment.start}>{segment.text}</mark>:<span key={segment.start}>{segment.text}</span>)}</p>
          {row.total>row.cues.length&&<p>{row.total-row.cues.length} further cue occurrences.</p>}
          <SourceButton documents={documents} brief={brief} source={row.source} onInspect={onInspect}/>
        </article>}/>
      </details>}
      {brief.references.map(group=><section className="chat-answer" key={group.reference.kind+':'+group.reference.identifier}>
        <h5>{group.reference.kind} {group.reference.identifier}</h5>
        <p>{group.hits.length} native fragment(s) mention this identifier. Leading mentions are not verified definitions.</p>
        <Paged rows={group.hits} label="brief reference candidates" render={hit=><article className="chat-citation" key={hit.source.page+':'+hit.source.ordinal}>
          <p>{hit.startsWithReference?'Leading identifier candidate':'Inline mention'}</p>
          <p>{highlightedSegments(hit.source.text,hit.ranges).map(segment=>segment.match?<mark key={segment.start}>{segment.text}</mark>:<span key={segment.start}>{segment.text}</span>)}</p>
          <SourceButton documents={documents} brief={brief} source={hit.source} onInspect={onInspect}/>
        </article>}/>
      </section>)}
    </>}
  </details>;
}
