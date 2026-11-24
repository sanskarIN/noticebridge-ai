/* Browser controller. No network calls, storage, or automatic labels. */
'use strict';
const C = globalThis.ReviewCore;
const $ = id => document.getElementById(id);
let cases = [], active = 0, generation = 0, loadGeneration = 0;
let urls = [];
function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function message(text, error=false) { $('message').textContent=text; $('message').className=error?'error':''; }
function caseMessage(text,error=false) { $('case-status').textContent=text; $('case-status').className=error?'error':'muted'; }
function releaseUrls() { for (const url of urls) URL.revokeObjectURL(url); urls=[]; }
function refreshProgress() {
  const done = cases.filter(c=>c.complete).length;
  $('progress').textContent=`${done} / ${cases.length} complete`;
  $('export').disabled=!cases.length||done!==cases.length;
  $('next-pending').disabled=C.nextIncomplete(cases,active)===null;
  const c=cases[active];
  $('complete').disabled=!c || c.complete || !c.verified.original || !c.verified.revised || !$('attest').checked;
  for (const [i,option] of Array.from($('cases').options).entries()) option.textContent=`${cases[i].complete?'Complete — ':'Pending — '}${cases[i].source.id}`;
  $('add').disabled=!c || c.pairs.length>=C.MAX_PAIRS;
}
function invalidate(c) { c.complete=false; $('attest').checked=false; refreshProgress(); caseMessage('Changes require a new review confirmation.'); }
async function readJson(file) {
  if (!file || file.size>C.MAX_BYTES) throw new Error('Choose a JSON manifest of at most 1 MB.');
  return C.decodeManifestBytes(await file.arrayBuffer());
}
function load(newCases) {
  cases=newCases; active=0;
  $('cases').replaceChildren(...cases.map((c,i)=>{const o=el('option',c.source.id);o.value=String(i);return o;}));
  $('resume-wrap').hidden=false;$('workspace').hidden=false;
  renderCase();
}
$('manifest').addEventListener('change',async event=>{
  const file=event.target.files[0], token=++loadGeneration;
  if (!file) return;
  if (cases.some(c=>c.pairs.length || c.complete) && !window.confirm('Replace the loaded review? Save your draft first if needed.')) {event.target.value='';return;}
  try {const loaded=C.blank(await readJson(file)); if(token!==loadGeneration)return; load(loaded);message(`Loaded ${cases.length} blank review cases.`);}
  catch(e){if(token===loadGeneration)message(e.message,true);}
  finally{event.target.value='';}
});
$('resume').addEventListener('change',async event=>{
  const file=event.target.files[0], token=++loadGeneration;
  if (!file || !cases.length) return;
  if (!window.confirm('Resume only your own previously saved review. Existing work will be replaced. Continue?')) {event.target.value='';return;}
  try {const resumed=C.resume(cases,await readJson(file));if(token!==loadGeneration)return;load(resumed);message('Draft restored. Reverify both PDFs and reconfirm each case.');}
  catch(e){if(token===loadGeneration)message(e.message,true);}
  finally{event.target.value='';}
});
$('cases').addEventListener('change',e=>{active=Number(e.target.value);renderCase();});
$('next-pending').addEventListener('click',()=>{const index=C.nextIncomplete(cases,active);if(index!==null){active=index;renderCase();$('cases').focus();}});
function renderCase() {
  ++generation; releaseUrls();
  const c=cases[active]; $('cases').value=String(active); $('attest').checked=false;
  $('metadata').textContent=[c.source.source_kind,c.source.issuer_group,c.source.event_group].filter(Boolean).join(' · ');
  $('sources').replaceChildren(...['original','revised'].map(role=>sourcePanel(c,role)));
  renderPairs(); caseMessage(c.complete?'Case completed in this session. Editing resets completion.':'Verify both PDFs before confirming the review.'); refreshProgress();
}
function sourcePanel(c,role) {
  const box=el('div',undefined,'source'); box.append(el('h3',role==='original'?'Original PDF':'Revised PDF'));
  box.append(el('p',c.source[role]));
  const digest=el('code',c.source[role+'_sha256']);box.append(digest);
  if(c.source[role+'_ocr_pages']?.length)box.append(el('p','Selected OCR pages in manifest: '+c.source[role+'_ocr_pages'].join(', '),'muted'));
  const label=el('label','Choose the pinned '+role+' PDF');const input=el('input');input.type='file';input.accept='.pdf,application/pdf';label.append(input);box.append(label);
  const status=el('p',c.verified[role]?'Fingerprint verified earlier in this session. Select again to reopen.':'Not yet verified.','muted');status.setAttribute('role','status');box.append(status);
  const open=el('button','Open verified PDF');open.type='button';open.disabled=true;box.append(open);
  let url=null, attempt=0;
  input.addEventListener('change',async()=>{
    const token=++attempt, view=generation, file=input.files[0];
    if(url){URL.revokeObjectURL(url);urls=urls.filter(x=>x!==url);url=null;}
    open.disabled=true;c.verified[role]=false;invalidate(c);
    if(!file){status.textContent='No PDF selected.';return;}
    status.textContent='Checking SHA-256…';status.className='muted';
    try {
      await C.verifyPdf(file,c.source[role+'_sha256'],globalThis.crypto);
      if(view!==generation||token!==attempt)return;
      url=URL.createObjectURL(new Blob([file],{type:'application/pdf'}));urls.push(url);c.verified[role]=true;open.disabled=false;
      status.textContent='Exact SHA-256 fingerprint matched.';status.className='muted';refreshProgress();
    } catch(e){if(view===generation&&token===attempt){status.textContent=e.message;status.className='error';refreshProgress();}}
  });
  open.addEventListener('click',()=>{if(url)window.open(url,'_blank','noopener,noreferrer');});
  return box;
}
function renderPairs() {
  const c=cases[active], parent=$('pairs');parent.replaceChildren();
  if(!c.pairs.length)parent.append(el('p','No passage pairs recorded. A genuinely negative case is allowed.','muted'));
  c.pairs.forEach((p,i)=>{
    const card=el('div',undefined,'pair'), bar=el('div',undefined,'bar');bar.append(el('h3',`Passage pair ${i+1}`));
    const remove=el('button','Remove pair','secondary');remove.type='button';remove.setAttribute('aria-label',`Remove passage pair ${i+1}`);remove.addEventListener('click',()=>{c.pairs.splice(i,1);invalidate(c);renderPairs();});bar.append(remove);card.append(bar);
    const grid=el('div',undefined,'columns');
    for(const role of ['original','revised']){
      const column=el('div');const heading=el('h3',role==='original'?'Original passage':'Revised passage');column.append(heading);
      const pageLabel=el('label','PDF page number'),page=el('input');page.type='number';page.min='1';page.max=String(C.MAX_PAGES);page.step='1';page.value=String(p[role+'_page']??'');
      page.addEventListener('input',()=>{p[role+'_page']=page.value===''?null:Number(page.value);invalidate(c);});pageLabel.append(page);column.append(pageLabel);
      const quoteLabel=el('label','Exact source quotation'),quote=el('textarea');quote.maxLength=5000;quote.value=p[role+'_text']??'';
      quote.addEventListener('input',()=>{p[role+'_text']=quote.value;invalidate(c);});quoteLabel.append(quote);column.append(quoteLabel);grid.append(column);
    }
    card.append(grid);parent.append(card);
  });
}
$('add').addEventListener('click',()=>{const c=cases[active];if(c.pairs.length>=C.MAX_PAIRS)return;c.pairs.push({original_page:1,original_text:'',revised_page:1,revised_text:''});invalidate(c);renderPairs();$('pairs').lastElementChild?.querySelector('input')?.focus();});
$('attest').addEventListener('change',refreshProgress);
$('complete').addEventListener('click',()=>{
  try{C.complete(cases[active],$('attest').checked);caseMessage('Case completed. You can select the next case or export.');refreshProgress();}
  catch(e){caseMessage(e.message,true);}
});
function save(final){
  try{const data=final?C.exportReview(cases,{final:true}):C.saveDraft(cases);const url=URL.createObjectURL(new Blob([data],{type:'application/json'}));const a=el('a');a.href=url;a.download=final?'review-complete.json':'review-draft.json';document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);message(final?'Finished review export requested. Run the Python review checker next.':'Draft export requested.');}
  catch(e){caseMessage(e.message,true);$('case-status').scrollIntoView({block:'center'});}
}
$('draft').addEventListener('click',()=>save(false));$('export').addEventListener('click',()=>save(true));
window.addEventListener('pagehide',releaseUrls);
window.addEventListener('beforeunload',event=>{if(cases.some(c=>c.pairs.length||c.complete)){event.preventDefault();event.returnValue='';}});
