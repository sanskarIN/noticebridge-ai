import {useMemo,useState} from 'react';
import type {CollectionDocument,CollectionStep,CollectionTurn} from './pdfChatCollection';
import type {ReferenceKind} from './pdfChatEvidenceExplorer';
import {GUIDE_GROUPS,MAX_GUIDE_PARTS,guideInventory,filterGuideOptions,prepareGuidedDraft,moveGuidedPart,
  type GuideGroup,type GuidedPart,type GuideId} from './pdfChatGuidedQuestions';
const kinds:ReferenceKind[]=['clause','section','paragraph','rule','article','annexure','schedule'];
type Props={documents:CollectionDocument[];selected:string[];turns:CollectionTurn[];names:Map<string,string>;
  includeContext:boolean;draft:string;disabled:boolean;onDraft:(step:CollectionStep)=>void};
export default function PdfChatGuidedQuestions({documents,selected,turns,names,includeContext,draft,disabled,onDraft}:Props){
  const [open,setOpen]=useState(false),[parts,setParts]=useState<GuidedPart[]>([]);
  const [ids,setIds]=useState<string[]>(()=>[...selected]),[context,setContext]=useState(includeContext);
  const [group,setGroup]=useState<GuideGroup|'all'>('all'),[query,setQuery]=useState(''),[recognized,setRecognized]=useState(false);
  const [choice,setChoice]=useState<GuideId>('application_deadline'),[referenceKind,setReferenceKind]=useState<ReferenceKind>('clause');
  const [identifier,setIdentifier]=useState(''),[replace,setReplace]=useState<string|null>(null);
  const inventory=useMemo(()=>open?guideInventory(documents,ids):[],[open,documents,ids]);
  const options=filterGuideOptions(group,query,recognized,inventory);
  const preview=useMemo(()=>{
    if(!open||!parts.length||!ids.length)return null;
    try{return prepareGuidedDraft(documents,{parts,documentIds:ids,includeContext:context},turns);}catch{return null;}
  },[open,documents,parts,ids,context,turns]);
  function change(next:GuidedPart[]){setParts(next);setReplace(null);}
  function changePart(index:number,page:number|null){change(parts.map((part,i)=>i===index?{...part,page}:part));}
  function reset(){change([]);setIds([...selected]);setContext(includeContext);setIdentifier('');}
  return <details className="chat-collection-inspection" aria-label="Guided collection question composer" onToggle={event=>setOpen(event.currentTarget.open)}>
    <summary>Build a question from common notice topics</summary>
    <p className="chat-muted">Choose up to four independent topics, select the PDFs and optionally set one physical page for each topic.
      This creates editable standalone wording only. It does not submit or answer a question.</p>
    {open&&<>
      <fieldset className="chat-citation" disabled={disabled}><legend>Guided question scope</legend>
        {documents.map(doc=><label className="chat-checkbox" key={doc.id}>
          <input type="checkbox" checked={ids.includes(doc.id)} onChange={event=>{setIds(old=>event.target.checked?[...old,doc.id]:old.filter(id=>id!==doc.id));setReplace(null);}}/>
          {names.get(doc.id)}</label>)}
        <button type="button" className="chat-button" onClick={()=>{setIds([...selected]);setContext(includeContext);setReplace(null);}}>Use current question selection</button>
        <label className="chat-checkbox"><input type="checkbox" checked={context} onChange={event=>{setContext(event.target.checked);setReplace(null);}}/> Search nearby lines</label>
      </fieldset>
      <fieldset className="chat-citation" disabled={disabled||parts.length>=MAX_GUIDE_PARTS}><legend>Add a guided topic</legend>
        <label>Topic group<select value={group} onChange={event=>setGroup(event.target.value as typeof group)}>
          <option value="all">All topics</option>{Object.entries(GUIDE_GROUPS).map(([key,label])=><option key={key} value={key}>{label}</option>)}
        </select></label>
        <label>Find topic<input maxLength={100} value={query} onChange={event=>setQuery(event.target.value)}/></label>
        <label className="chat-checkbox"><input type="checkbox" checked={recognized} onChange={event=>setRecognized(event.target.checked)}/>
          Only topics with recognized printed labels in these PDFs</label>
        <label>Notice topic<select value={options.some(row=>row.id===choice)?choice:''} onChange={event=>setChoice(event.target.value as GuideId)}>
          <option value="">Choose a topic</option>{options.map(option=>{
            const count=inventory.find(row=>row.id===option.id)?.documentsWithField??0;
            return <option key={option.id} value={option.id}>{option.label}{count?' ('+count+' PDF(s) with printed labels)':''}</option>;
          })}
        </select></label>
        <button type="button" className="chat-button" disabled={!options.some(row=>row.id===choice)} onClick={()=>change([...parts,{kind:'template',id:choice,page:null}])}>Add selected notice topic</button>
        <p className="chat-muted">A missing printed label is not proof that the topic is absent; ordinary free-text questions remain available.</p>
      </fieldset>
      <fieldset className="chat-citation" disabled={disabled||parts.length>=MAX_GUIDE_PARTS}><legend>Add an explicit printed reference</legend>
        <label>Reference type<select value={referenceKind} onChange={event=>setReferenceKind(event.target.value as ReferenceKind)}>
          {kinds.map(kind=><option key={kind} value={kind}>{kind}</option>)}
        </select></label>
        <label>Printed identifier<input value={identifier} maxLength={32} placeholder="4.2(a)" onChange={event=>setIdentifier(event.target.value)}/></label>
        <button type="button" className="chat-button" disabled={!identifier.trim()} onClick={()=>{change([...parts,{kind:'reference',referenceKind,identifier:identifier.trim(),page:null}]);setIdentifier('');}}>Add printed reference topic</button>
      </fieldset>
      <h5>Guided parts ({parts.length}/{MAX_GUIDE_PARTS})</h5>
      {parts.map((part,index)=><fieldset key={index} disabled={disabled} className="chat-citation">
        <legend>Guided part {index+1}</legend>
        <p>{part.kind==='template'?part.id.replaceAll('_',' '):part.referenceKind+' '+part.identifier}</p>
        <label>Physical page for part {index+1}<input type="number" min={1} max={80} value={part.page??''}
          onChange={event=>changePart(index,event.target.value===''?null:Number(event.target.value))}/></label>
        <p className="chat-muted">Leave blank to search all retained native pages.</p>
        <div className="chat-toolbar">
          <button type="button" className="chat-button" disabled={index===0} onClick={()=>change(moveGuidedPart(parts,index,-1))}>Move guided part {index+1} earlier</button>
          <button type="button" className="chat-button" disabled={index===parts.length-1} onClick={()=>change(moveGuidedPart(parts,index,1))}>Move guided part {index+1} later</button>
          <button type="button" className="chat-button" onClick={()=>change(parts.filter((_,i)=>i!==index))}>Remove guided part {index+1}</button>
        </div>
      </fieldset>)}
      {parts.length>0&&!preview&&<p className="chat-note">Choose valid distinct topics, valid printed identifiers, page numbers 1–80 and at least one PDF. Check the remaining history capacity.</p>}
      {preview&&<section className="chat-answer" aria-label="Guided question draft preview">
        <h5>Editable question preview</h5><p>{preview.step.question}</p>
        <p>{preview.searches} independent searches · {preview.partial} partial scopes · {preview.unavailable} unavailable scopes.</p>
        {preview.parts.map((part,index)=><p key={index}>{part.question}: {part.scopes.map(scope=>names.get(scope.id)+' — '+scope.coverage.replaceAll('_',' ')).join('; ')}</p>)}
        {!!draft.trim()&&<label className="chat-checkbox"><input type="checkbox" checked={replace===draft} onChange={event=>setReplace(event.target.checked?draft:null)}/>
          Replace the current unsent question and its scope with this guided draft.</label>}
        <button type="button" className="chat-button" disabled={disabled||!!draft.trim()&&replace!==draft}
          onClick={()=>{onDraft(preview.step);setReplace(null);}}>Use guided question draft</button>
      </section>}
      <button type="button" className="chat-button" disabled={disabled} onClick={reset}>Reset guided question builder</button>
    </>}
  </details>;
}
