import {useRef,useState} from 'react';
import {COLLECTION_TOOL_GROUPS,COLLECTION_TOOL_SEARCH_LIMIT,collectionToolAnchor,collectionToolSearch,
  type CollectionToolGroup,type CollectionToolId,type CollectionToolState} from './pdfChatCollectionNavigation';

/** Open an existing destination without remounting any workspace tools.
 * Only the explicitly selected disclosure is opened. */
export function focusCollectionDestination(root:HTMLElement,id:CollectionToolId):boolean{
  const target=root.querySelector<HTMLElement>('#'+collectionToolAnchor(id));
  if(!target||!root.contains(target))return false;
  const disclosure=target.matches('details')?target:target.firstElementChild?.matches('details')?
    target.firstElementChild:null;
  if(disclosure instanceof HTMLDetailsElement)disclosure.open=true;
  const focus=disclosure?.querySelector<HTMLElement>(':scope > summary')??target;
  focus.focus({preventScroll:true});
  target.scrollIntoView({block:'start',behavior:'instant'});
  return true;
}
export default function PdfChatCollectionNavigation({state,onNavigate}:{
  state:CollectionToolState;onNavigate:(id:CollectionToolId)=>boolean;
}){
  const [query,setQuery]=useState('');
  const [group,setGroup]=useState<CollectionToolGroup|'all'>('all');
  const [only,setOnly]=useState(false);
  const [error,setError]=useState('');
  const search=useRef<HTMLInputElement>(null);
  const rows=collectionToolSearch(query,group,state,only);
  return <details className="chat-collection-inspection chat-collection-navigation" aria-label="Collection workspace navigation">
    <summary>Find a collection workspace tool</summary>
    <p>Search by task or choose a group. Opening a tool does not change the PDFs, questions or saved reviews.</p>
    <div className="chat-collection-filter-grid">
      <label>Find collection tool<input ref={search} value={query} maxLength={COLLECTION_TOOL_SEARCH_LIMIT}
        placeholder="Examples: deadline, OCR, export" onChange={event=>{setQuery(event.target.value);setError('');}}/></label>
      <label>Collection tool group<select value={group} onChange={event=>{setGroup(event.target.value as typeof group);setError('');}}>
        <option value="all">All tool groups</option>
        {(Object.keys(COLLECTION_TOOL_GROUPS) as CollectionToolGroup[]).map(key=>
          <option key={key} value={key}>{COLLECTION_TOOL_GROUPS[key]}</option>)}
      </select></label>
    </div>
    <div className="chat-toolbar">
      <label className="chat-checkbox"><input type="checkbox" checked={only} onChange={event=>setOnly(event.target.checked)}/>
        Show available collection tools only</label>
      <button type="button" className="chat-button" onClick={()=>{setQuery('');setGroup('all');setOnly(false);setError('');search.current?.focus();}}>Reset tool search</button>
    </div>
    <p role="status">{rows.length} matching workspace tool(s).</p>
    {rows.length===0&&<p>No tool matches. Try a shorter task keyword or reset the filters.</p>}
    <div className="chat-collection-navigation-grid">
      {rows.map(({tool,unavailable})=><article key={tool.id} className="chat-citation">
        <h5>{tool.title}</h5><p>{tool.description}</p>
        <p className="chat-muted">{COLLECTION_TOOL_GROUPS[tool.group]}</p>
        {unavailable&&<p className="chat-muted">{unavailable}</p>}
        <button type="button" className="chat-button" disabled={unavailable!==null} onClick={()=>{
          if(!onNavigate(tool.id))setError('The selected workspace destination is no longer available.');
          else setError('');
        }}>Open {tool.title}</button>
      </article>)}
    </div>
    {error&&<p role="alert" className="chat-error">{error}</p>}
  </details>;
}
