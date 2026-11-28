import {useMemo,useState} from 'react';
import PdfChatDiagnosticExchange from './PdfChatDiagnosticExchange';
import type {CollectionDocument} from './pdfChatCollection';
import type {Passage} from './pdfChatCore';
import {QUALITY_FLAGS,QUALITY_PAGE_SIZE,QUALITY_FRAGMENT_SIZE,collectionQuality,filterQualityPages,filterQualityFragments,
  qualityPage,inspectQualityFragment,type CollectionQuality,type SourceQuality,type QualityFlag,type QualityPage,type QualityFilter} from './pdfChatCollectionQuality';

const labels:Record<QualityFlag,string>={replacement:'Unicode replacement character',private_use:'Private-use character',control:'Control or format character',
  no_letters_or_digits:'No letters or digits',missing_geometry:'No retained geometry',duplicate_on_page:'Exact text repeated on this page',
  repeated_across_pages:'Exact text repeated on different pages'};
type Props={documents:readonly CollectionDocument[];selected:string[];names:Map<string,string>;
  onInspect:(id:string,source:Passage,target:HTMLElement)=>void;onPage:(id:string,page:number,target:HTMLElement)=>void};
function Counts({counts}:{counts:SourceQuality['counts']}){
  return <dl className="chat-collection-budget">{QUALITY_FLAGS.map(flag=><div key={flag}>
    <dt>{labels[flag]}</dt><dd>{counts[flag]}</dd>
  </div>)}</dl>;
}
function PageDetails({row,flag,source,result,documents,onInspect,onPage}:{
  row:QualityPage;flag:QualityFlag|'all';source:SourceQuality;result:CollectionQuality;
  documents:Props['documents'];onInspect:Props['onInspect'];onPage:Props['onPage'];
}){
  const [page,setPage]=useState(1),[open,setOpen]=useState(false);
  const all=filterQualityFragments(row,flag);
  const current=qualityPage(all,Math.min(page,Math.max(1,Math.ceil(all.length/QUALITY_FRAGMENT_SIZE))),QUALITY_FRAGMENT_SIZE);
  return <article className="chat-citation">
    <h5>Physical page {row.page}</h5>
    <p>{row.coverage.replaceAll('_',' ')} · {row.fragments} native fragments · {row.characters} UTF-16 units · {row.flagged.length} flagged fragments.</p>
    <button type="button" className="chat-button" onClick={event=>onPage(source.id,row.page,event.currentTarget)}>Open quality inspection page {row.page}</button>
    <details onToggle={event=>setOpen(event.currentTarget.open)}><summary>Fragment signals ({all.length})</summary>
      <Counts counts={row.counts}/>
      {open&&<>
        {current.rows.map(item=><div key={item.source.ordinal} className="chat-citation">
          <p className="chat-muted">Fragment {item.source.ordinal}: {item.flags.map(value=>labels[value]).join(' · ')}</p>
          <p style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{item.source.text}</p>
          <button type="button" className="chat-button" onClick={event=>onInspect(source.id,
            inspectQualityFragment(documents,result,source.id,item),event.currentTarget)}>Inspect quality fragment {row.page}:{item.source.ordinal}</button>
        </div>)}
        {!all.length&&<p>No fragments match this signal.</p>}
        {current.pages>1&&<div className="chat-toolbar">
          <button type="button" className="chat-button" disabled={page===1} onClick={()=>setPage(value=>value-1)}>Previous quality fragments</button>
          <span>{current.first}–{current.last} of {all.length}</span>
          <button type="button" className="chat-button" disabled={page===current.pages} onClick={()=>setPage(value=>value+1)}>Next quality fragments</button>
        </div>}
      </>}
    </details>
  </article>;
}
function SourceDetails({source,result,documents,names,onInspect,onPage}:Pick<Props,'documents'|'names'|'onInspect'|'onPage'>&{
  source:SourceQuality;result:CollectionQuality;
}){
  const [filter,setFilter]=useState<QualityFilter>({flag:'all',coverage:'all',onlyFlagged:true});
  const [page,setPage]=useState(1),[open,setOpen]=useState(false);
  const rows=filterQualityPages(source,filter);
  const current=qualityPage(rows,Math.min(page,Math.max(1,Math.ceil(rows.length/QUALITY_PAGE_SIZE))));
  function change(update:Partial<QualityFilter>){setFilter(old=>({...old,...update}));setPage(1);}
  return <details className="chat-answer" onToggle={event=>setOpen(event.currentTarget.open)}>
    <summary>{names.get(source.id)} — {source.flaggedFragments} of {source.fragments} fragments with signals</summary>
    <p>{source.processedPages} of {source.physicalPages} physical pages processed. {source.unprocessedPages} physical pages not indexed.</p>
    {source.limited&&<p className="chat-note">Native extraction is limited. The diagnostic does not inspect unprocessed pages.</p>}
    <Counts counts={source.counts}/>
    <label>Quality signal<select value={filter.flag} onChange={event=>change({flag:event.target.value as QualityFilter['flag']})}>
      <option value="all">All signals</option>{QUALITY_FLAGS.map(flag=><option key={flag} value={flag}>{labels[flag]}</option>)}
    </select></label>
    <label>Native page coverage<select value={filter.coverage} onChange={event=>change({coverage:event.target.value as QualityFilter['coverage']})}>
      <option value="all">All processed pages</option><option value="some_text">Some native text</option>
      <option value="limited">Limited</option><option value="no_indexed_text">No indexed text</option>
    </select></label>
    <label className="chat-checkbox"><input type="checkbox" checked={filter.onlyFlagged} onChange={event=>change({onlyFlagged:event.target.checked})}/>
      Only pages with a signal or incomplete coverage</label>
    {open&&<>
      <p>{rows.length} matching processed page(s).</p>
      {current.rows.map(row=><PageDetails key={row.page+':'+filter.flag} row={row} flag={filter.flag} source={source} result={result}
        documents={documents} onInspect={onInspect} onPage={onPage}/>)}
      {current.pages>1&&<div className="chat-toolbar">
        <button type="button" className="chat-button" disabled={page===1} onClick={()=>setPage(value=>value-1)}>Previous quality pages</button>
        <span>{current.first}–{current.last} of {rows.length}</span>
        <button type="button" className="chat-button" disabled={page===current.pages} onClick={()=>setPage(value=>value+1)}>Next quality pages</button>
      </div>}
    </>}
  </details>;
}
export default function PdfChatCollectionQuality({documents,selected,names,onInspect,onPage}:Props){
  const [open,setOpen]=useState(false);
  const result=useMemo(()=>open&&selected.length?collectionQuality(documents,selected):null,[open,documents,selected]);
  return <details className="chat-collection-inspection" aria-label="Native extraction quality signals" onToggle={event=>setOpen(event.currentTarget.open)}>
    <summary>Inspect native extraction quality signals</summary>
    <p className="chat-note">Repeated text, symbols, control characters and missing geometry may be intentional. This inspection never
      changes retrieval, removes repeated lines, assigns OCR confidence or certifies a PDF. Verify the actual page whenever a signal matters.</p>
    {open&&!result&&<p>Select at least one attached PDF.</p>}
    {result&&<>
      <p>{result.fragments} native fragments · {result.flaggedFragments} with one or more signals · {result.characters} UTF-16 units. Counts overlap.</p>
      <Counts counts={result.counts}/>
      {result.sources.map(source=><SourceDetails key={source.id} source={source} result={result} documents={documents} names={names} onInspect={onInspect} onPage={onPage}/>)}
      <PdfChatDiagnosticExchange mode="quality" documents={documents} selected={selected}/>
    </>}
  </details>;
}
