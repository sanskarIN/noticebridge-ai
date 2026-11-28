import {useEffect,useRef,useState} from 'react';
import {buildCheckpoint,restoreCheckpoint,type CheckpointState,type CheckpointInfo,type CheckpointProgress} from './pdfChatCollectionCheckpoint';
import {createCheckpointStore} from './pdfChatCheckpointStore';
import {readPdf} from './pdfChatExtract';
type Props={state:CheckpointState;draft:string;disabled:boolean;onRestore:(state:CheckpointState)=>void};
type Pending={state:CheckpointState;current:CheckpointState;revision:string;draft:string};
function same(a:CheckpointState,b:CheckpointState){
  return a.documents===b.documents&&a.turns===b.turns&&a.reviews===b.reviews&&a.selected===b.selected;
}
export default function PdfChatCollectionCheckpoint({state,draft,disabled,onRestore}:Props){
  const [info,setInfo]=useState<CheckpointInfo|null|undefined>(undefined);
  const [busy,setBusy]=useState(false);
  const [approval,setApproval]=useState<CheckpointState|null>(null);
  const [deleteApproval,setDeleteApproval]=useState<string|null>(null);
  const [pending,setPending]=useState<Pending|null>(null);
  const [progress,setProgress]=useState<CheckpointProgress|null>(null);
  const [feedback,setFeedback]=useState('');
  const [error,setError]=useState('');
  const latest=useRef(state);latest.current=state;
  const latestDraft=useRef(draft);latestDraft.current=draft;
  const controller=useRef<AbortController|null>(null),generation=useRef(0);
  useEffect(()=>()=>{generation.current++;controller.current?.abort();},[]);
  const approved=approval!==null&&same(approval,state);
  const pendingFresh=pending!==null&&same(pending.current,state)&&pending.revision===info?.revision&&pending.draft===draft;
  async function act(mode:'refresh'|'save'|'restore'|'delete'){
    if(disabled||controller.current||mode==='save'&&(!approved||info===undefined||!state.documents.length)||
      mode==='delete'&&(!info||deleteApproval!==info.revision)||mode==='restore'&&!info)return;
    const task=new AbortController();controller.current=task;const token=++generation.current;
    const active=()=>generation.current===token&&!task.signal.aborted;
    setBusy(true);setProgress(null);setError('');setFeedback('');setPending(null);setApproval(null);setDeleteApproval(null);
    try{
      const store=createCheckpointStore();
      if(mode==='refresh'){
        const next=await store.info();if(active())setInfo(next);
      }else if(mode==='save'){
        const checkpoint=await buildCheckpoint(state,true,task.signal);
        if(!active()||!same(latest.current,state))throw Error('stale');
        await store.save(checkpoint,info?.revision??null,task.signal);
        if(active()){setInfo(await store.info());setFeedback('Private collection checkpoint saved in this browser profile.');}
      }else if(mode==='restore'){
        const checkpoint=await store.load();
        if(!checkpoint||checkpoint.revision!==info?.revision)throw Error('changed');
        const restored=await restoreCheckpoint(checkpoint,readPdf,task.signal,value=>{if(active())setProgress(value);});
        if(active()&&same(latest.current,state)){
          const current=await store.info();
          if(current?.revision!==checkpoint.revision)throw Error('changed');
          if(active()&&same(latest.current,state)&&latestDraft.current===draft)setPending({state:restored,current:state,revision:checkpoint.revision,draft});
        }else if(active())throw Error('stale');
      }else{
        await store.remove(info!.revision,task.signal);
        if(active()){setInfo(null);setFeedback('Local collection checkpoint deleted.');}
      }
    }catch{
      if(active()){setInfo(undefined);setError('Local checkpoint operation failed or the checkpoint changed. Refresh its status before trying again.');}
    }finally{if(token===generation.current){controller.current=null;setBusy(false);setProgress(null);}}
  }
  return <details className="chat-collection-inspection" aria-label="Explicit browser-local collection checkpoint">
    <summary>Save or restore a private browser-local checkpoint</summary>
    <p className="chat-note">Nothing is saved automatically. Saving stores actual PDF bytes, filenames, extracted text,
      question text and personal annotations in this browser profile. This is not encrypted storage or cloud sync.
      Other people using this browser profile may be able to access the files. Avoid shared devices and sensitive PDFs.
      Deleting browser site data may remove the checkpoint.</p>
    <button type="button" className="chat-button" disabled={disabled||busy} onClick={()=>void act('refresh')}>Check local collection checkpoint</button>
    {info===undefined?<p>Storage status not checked.</p>:info===null?<p>No local collection checkpoint.</p>:
      <p>{info.documents} saved PDF(s), {(info.bytes/(1024*1024)).toFixed(2)} MiB PDF bytes. {info.containsWork?'Contains saved questions or annotations.':'No saved questions or annotations.'}</p>}
    <label className="chat-checkbox"><input type="checkbox" checked={approved} disabled={disabled||busy||info===undefined||!state.documents.length}
      onChange={event=>setApproval(event.target.checked?state:null)}/> I approve storing the actual private PDFs, filenames, native text and saved work on this browser.</label>
    <button type="button" className="chat-button" disabled={disabled||busy||!approved||info===undefined||!state.documents.length} onClick={()=>void act('save')}>
      {info?'Replace existing local checkpoint':'Save local collection checkpoint'}</button>
    {!!info&&<>
      <button type="button" className="chat-button" disabled={disabled||busy} onClick={()=>void act('restore')}>Prepare local checkpoint restore</button>
      <p className="chat-muted">Restoration re-fingerprints and re-extracts every PDF. No current work is changed until you apply the complete preview.</p>
      <label className="chat-checkbox"><input type="checkbox" checked={deleteApproval===info.revision} disabled={disabled||busy}
        onChange={event=>setDeleteApproval(event.target.checked?info.revision:null)}/> Delete stored checkpoint and its private files</label>
      <button type="button" className="chat-button" disabled={disabled||busy||deleteApproval!==info.revision}
        onClick={()=>void act('delete')}>Delete local collection checkpoint</button>
    </>}
    {busy&&<button type="button" className="chat-button" onClick={()=>controller.current?.abort()}>Cancel local checkpoint operation</button>}
    {progress&&<p role="status">Re-extracted {progress.completed} of {progress.total} saved PDF(s).</p>}
    {pending&&<section className="chat-note" aria-label="Local checkpoint restore preview">
      <h4>Exact native extraction and workspace replay matched</h4>
      <p>{pending.state.documents.length} PDF(s), {pending.state.turns.length} question turn(s), {pending.state.reviews.length} personal annotation(s).</p>
      <p>Applying replaces the current attached PDFs, draft question, conversation and review notebook. The checkpoint remains stored.</p>
      {!pendingFresh&&<p>Current work or checkpoint changed. Prepare the restore again.</p>}
      <button type="button" className="chat-button" disabled={disabled||busy||!pendingFresh} onClick={()=>{
        if(!pendingFresh)return;onRestore(pending.state);setPending(null);setFeedback('Local collection checkpoint restored.');
      }}>Apply verified local checkpoint</button>
      <button type="button" className="chat-button" onClick={()=>setPending(null)}>Discard local checkpoint preview</button>
    </section>}
    {feedback&&<p role="status">{feedback}</p>}{error&&<p role="alert" className="chat-error">{error}</p>}
  </details>;
}
