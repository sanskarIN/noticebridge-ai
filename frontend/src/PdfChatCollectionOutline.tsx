import { useMemo,useState } from 'react';
import type { Passage } from './pdfChatCore';
import type { CollectionDocument } from './pdfChatCollection';
import { MAX_SECTION_FILTER_CHARS } from './pdfChatStructure';
import { collectionOutline,filterCollectionOutline,collectionOutlinePage,collectionSectionFragments,
  collectionSectionSource,alignCollectionSections,COLLECTION_OUTLINE_PAGE_SIZE,COLLECTION_SECTION_PAGE_SIZE,
  type CollectionSection,type CollectionOutlineFilter,type CollectionSectionAlignment } from './pdfChatCollectionOutline';

type Inspect=(id:string,source:Passage,target:HTMLElement)=>void;
function SectionView({documents,row,names,onInspect}:{
  documents:readonly CollectionDocument[];row:CollectionSection;names:Map<string,string>;onInspect:Inspect;
}){
  const [keyword,setKeyword]=useState('');
  const [page,setPage]=useState(1);
  const rows=useMemo(()=>collectionSectionFragments(documents,row.documentId,row.key,keyword),[documents,row,keyword]);
  const shown=collectionOutlinePage(rows,Math.min(page,Math.max(1,Math.ceil(rows.length/COLLECTION_SECTION_PAGE_SIZE))),COLLECTION_SECTION_PAGE_SIZE);
  return <section className="chat-answer" aria-label="Collection section fragments">
    <h4>{names.get(row.documentId)} · {row.section.source.text}</h4>
    <p className="chat-muted">Candidate physical pages {row.section.firstPage}–{row.section.lastPage}.
      {' '}{row.section.ordinalGaps} ordinal gap(s). Extraction order is not certified section structure.</p>
    {row.section.uncertainPages.length>0&&<p className="chat-note">Incomplete native pages: {row.section.uncertainPages.join(', ')}.</p>}
    <label>Find text within collection section
      <input value={keyword} maxLength={MAX_SECTION_FILTER_CHARS} onChange={event=>{setKeyword(event.target.value);setPage(1);}}/>
    </label>
    <p role="status">{rows.length} native fragment(s) match.</p>
    {shown.items.map(source=><div className="chat-citation" key={source.page+':'+source.ordinal}>
      <p className="chat-muted">Physical page {source.page} · fragment {source.ordinal}</p>
      <p>{source.text}</p>
      <button type="button" className="chat-button" onClick={event=>onInspect(row.documentId,
        collectionSectionSource(documents,row.documentId,row.key,source),event.currentTarget)}>Inspect collection section fragment {source.page}:{source.ordinal}</button>
    </div>)}
    {shown.pages>1&&<div className="chat-toolbar">
      <button type="button" className="chat-button" disabled={page===1} onClick={()=>setPage(page-1)}>Previous section fragments</button>
      <span>Page {page} of {shown.pages}</span>
      <button type="button" className="chat-button" disabled={page===shown.pages} onClick={()=>setPage(page+1)}>Next section fragments</button>
    </div>}
  </section>;
}
function Alignment({result,names,onInspect}:{
  result:CollectionSectionAlignment;names:Map<string,string>;onInspect:Inspect;
}){
  const [page,setPage]=useState(1);
  const [different,setDifferent]=useState(false);
  const rows=different?result.rows.filter(row=>row.kind!=='same'):result.rows;
  const shown=collectionOutlinePage(rows,page);
  return <section aria-label="Collection section exact alignment" className="chat-answer">
    <h4>Exact sequence alignment</h4>
    <p>{result.matched} matching fragments · {result.leftUnpaired} left unpaired · {result.rightUnpaired} right unpaired.</p>
    <p className="chat-note">An unpaired fragment is not proof of a change or removal. These PDFs have no inferred version relationship.</p>
    {result.repeatedText&&<p>Repeated wording may admit several valid alignments.</p>}
    {result.coverageLimited&&<p>Native extraction or candidate section coverage is incomplete.</p>}
    <label className="chat-checkbox"><input type="checkbox" checked={different} onChange={event=>{setDifferent(event.target.checked);setPage(1);}}/> Only unpaired collection fragments</label>
    {shown.items.map((row,i)=><article key={shown.first+i} className="chat-collection-matrix">
      {(['left','right'] as const).map(side=>{
        const source=side==='left'?('left' in row?row.left:undefined):('right' in row?row.right:undefined);
        const doc=result[side];
        return <div key={side} className="chat-overview-side"><h5>{names.get(doc.documentId)}</h5>
          {source?<><p>{source.text}</p><p className="chat-muted">Physical page {source.page} · fragment {source.ordinal}</p>
            <button type="button" className="chat-button" onClick={event=>onInspect(doc.documentId,source,event.currentTarget)}>Inspect {side} aligned collection source</button></>:<p>No paired native fragment in this alignment.</p>}
        </div>;
      })}
    </article>)}
    {shown.pages>1&&<div className="chat-toolbar">
      <button type="button" className="chat-button" disabled={page===1} onClick={()=>setPage(page-1)}>Previous aligned fragments</button>
      <span>Page {page} of {shown.pages}</span>
      <button type="button" className="chat-button" disabled={page===shown.pages} onClick={()=>setPage(page+1)}>Next aligned fragments</button>
    </div>}
  </section>;
}
export default function PdfChatCollectionOutline({documents,selected,names,onInspect}:{
  documents:readonly CollectionDocument[];selected:string[];names:Map<string,string>;onInspect:Inspect;
}){
  const [open,setOpen]=useState(false);
  const [filter,setFilter]=useState<CollectionOutlineFilter>({kind:'all',keyword:'',sharedOnly:false});
  const [page,setPage]=useState(1);
  const [choice,setChoice]=useState('');
  const [rightKey,setRightKey]=useState('');
  const [alignment,setAlignment]=useState<CollectionSectionAlignment|null>(null);
  const [error,setError]=useState(false);
  const sides=useMemo(()=>open&&selected.length?collectionOutline(documents,selected):[],[open,documents,selected]);
  const all=sides.flatMap(side=>side.sections);
  const rows=filterCollectionOutline(sides,filter);
  const current=Math.min(page,Math.max(1,Math.ceil(rows.length/COLLECTION_OUTLINE_PAGE_SIZE)));
  const shown=collectionOutlinePage(rows,current);
  const active=all.find(row=>row.key===choice);
  const counterparts=active?all.filter(row=>row.documentId!==active.documentId&&row.section.heading.key===active.section.heading.key):[];
  const right=counterparts.find(row=>row.key===rightKey);
  function change(value:Partial<CollectionOutlineFilter>){setFilter(old=>({...old,...value}));setPage(1);}
  function pick(key:string){setChoice(key);setRightKey('');setAlignment(null);setError(false);}
  return <details className="chat-collection-inspection" aria-label="Collection candidate outline" onToggle={event=>setOpen(event.currentTarget.open)}>
    <summary>Explore collection document structure</summary>
    <p className="chat-note">These are candidate headings derived from native text markers, not a certified document outline.
      Identical headings do not establish equivalent meaning or a version relationship.</p>
    {open&&<>
      <div className="chat-collection-filter-grid">
        <label>Collection outline heading type
          <select value={filter.kind} onChange={event=>change({kind:event.target.value as CollectionOutlineFilter['kind']})}>
            <option value="all">All candidates</option><option value="reference">Reference</option>
            <option value="numbered">Numbered heading</option><option value="named">Recognized named heading</option>
          </select>
        </label>
        <label>Find collection outline heading
          <input value={filter.keyword} maxLength={MAX_SECTION_FILTER_CHARS} onChange={event=>change({keyword:event.target.value})}/>
        </label>
        <label className="chat-checkbox"><input type="checkbox" checked={filter.sharedOnly} onChange={event=>change({sharedOnly:event.target.checked})}/> Heading key also occurs in another selected PDF</label>
      </div>
      {sides.map(side=><p className="chat-muted" key={side.documentId}>{names.get(side.documentId)}:
        {' '}{side.sections.length} candidate heading(s); {side.outline.beforeFirst.length} native fragments before first candidate;
        {' '}{side.outline.processedPages}/{side.outline.physicalPages} physical pages processed.</p>)}
      <p role="status">{rows.length} matching collection heading candidate(s).</p>
      {shown.items.map(row=><article key={row.key} className="chat-citation">
        <h5>{names.get(row.documentId)} · {row.section.source.text}</h5>
        <p>Physical page {row.section.firstPage} · {row.section.fragments.length} subsequent native fragment(s).
          {' '}{row.repeatedHere} candidate(s) with this key in this PDF; {row.counterpartDocuments.length} other selected PDF(s) with this key.</p>
        <button type="button" className="chat-button" onClick={()=>pick(row.key)}>Browse collection section</button>
        <button type="button" className="chat-button" onClick={event=>onInspect(row.documentId,row.section.source,event.currentTarget)}>Inspect collection heading source</button>
      </article>)}
      {shown.pages>1&&<div className="chat-toolbar">
        <button type="button" className="chat-button" disabled={current===1} onClick={()=>setPage(current-1)}>Previous collection headings</button>
        <span>Page {current} of {shown.pages}</span>
        <button type="button" className="chat-button" disabled={current===shown.pages} onClick={()=>setPage(current+1)}>Next collection headings</button>
      </div>}
      {active&&<>
        <SectionView key={active.key} documents={documents} row={active} names={names} onInspect={onInspect}/>
        {counterparts.length>0&&<section className="chat-answer" aria-label="Choose collection section counterpart">
          <h4>Optional explicit section alignment</h4>
          <label>Choose second collection section
            <select value={rightKey} onChange={event=>{setRightKey(event.target.value);setAlignment(null);setError(false);}}>
              <option value="">Choose a physical candidate</option>
              {counterparts.map(row=><option key={row.key} value={row.key}>{names.get(row.documentId)} · page {row.section.firstPage} · fragment {row.section.source.ordinal} · {row.section.source.text}</option>)}
            </select>
          </label>
          <button type="button" className="chat-button" disabled={!right} onClick={()=>{
            if(!right)return;
            try{setAlignment(alignCollectionSections(documents,active.documentId,active.key,right.documentId,right.key));setError(false);}
            catch{setAlignment(null);setError(true);}
          }}>Align selected collection sections</button>
          {error&&<p role="alert" className="chat-error">Sections could not be aligned within the processing budget.</p>}
          {alignment&&<Alignment key={alignment.left.key+'/'+alignment.right.key} result={alignment} names={names} onInspect={onInspect}/>}
        </section>}
      </>}
    </>}
  </details>;
}
