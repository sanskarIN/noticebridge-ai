const test=require('node:test'), assert=require('node:assert/strict'), {webcrypto,createHash}=require('node:crypto');
const C=require('./core.js');
const pdf=Buffer.from('%PDF-1.4\nfictional fixture'), hash=createHash('sha256').update(pdf).digest('hex');
const source={id:'case-1',source_kind:'fictional',original:'a.pdf',revised:'b.pdf',original_sha256:hash,revised_sha256:hash,issuer_group:'board',event_group:'event',original_ocr_pages:[3,1],label_method:'unreviewed',review_complete:false,expected_pairs:[]};
const manifest=(c=source)=>JSON.stringify({version:2,cases:[c]});
const pair={original_page:1,original_text:'Deadline: 13 December 2026',revised_page:1,revised_text:'Deadline: 19 December 2026'};
const reviewed=()=>{const [c]=C.blank(manifest());c.verified={original:true,revised:true};return c;};
test('blank strips hidden metadata and preserves sorted OCR pages and group identifiers',()=>{const [c]=C.blank(manifest({...source,hidden_predictions:['secret']}));assert.deepEqual(c.source.original_ocr_pages,[1,3]);assert.equal(c.source.issuer_group,'board');assert(!('hidden_predictions' in c.source));});
test('reject existing labels, unmarked cases and unsupported provenance',()=>{for(const change of [{expected_pairs:[pair]},{review_complete:true},{label_method:'synthetic'},{review_complete:undefined}])assert.throws(()=>C.blank(manifest({...source,...change})));});
test('reject bad SHA, paths, group pair and OCR budget',()=>{for(const change of [{original_sha256:'invalid'},{original:'../a.pdf'},{original:'C:/a.pdf'},{event_group:undefined},{original_ocr_pages:[1,1]},{original_ocr_pages:Array.from({length:13},(_,i)=>i+1)}])assert.throws(()=>C.blank(manifest({...source,...change})));});
test('reject duplicate IDs and wrong version',()=>{assert.throws(()=>C.blank(JSON.stringify({version:2,cases:[source,source]})));assert.throws(()=>C.blank(JSON.stringify({version:1,cases:[source]})));});
test('verify exact fingerprint from local file',async()=>{assert.equal(await C.verifyPdf(new Blob([pdf]),hash,webcrypto),hash);});
test('reject altered bytes and invalid header',async()=>{await assert.rejects(C.verifyPdf(new Blob([pdf,'altered']),hash,webcrypto),/mismatch/);await assert.rejects(C.verifyPdf(new Blob(['not a PDF']),hash,webcrypto),/header/);});
test('missing crypto fails closed',async()=>{await assert.rejects(C.verifyPdf(new Blob([pdf]),hash,{}),/unavailable/);});
test('completion requires both fingerprints and human affirmation',()=>{const [c]=C.blank(manifest());assert.throws(()=>C.complete(c,true));c.verified={original:true,revised:true};assert.throws(()=>C.complete(c,false));C.complete(c,true);assert(c.complete);});
test('valid negative case has explicit complete marker and empty labels',()=>{const c=reviewed();C.complete(c,true);const out=JSON.parse(C.exportReview([c],{final:true})).cases[0];assert.equal(out.review_complete,true);assert.deepEqual(out.expected_pairs,[]);assert.equal(out.label_method,'independent_human');});
test('validate integer pages, quotes, and Unicode length',()=>{for(const change of [{original_page:0},{original_page:1.5},{revised_page:81},{original_text:' '},{revised_text:'x'.repeat(5001)}])assert.throws(()=>C.pairOf({...pair,...change}));assert.equal(C.pairOf({...pair,original_text:'  exact quote  '}).original_text,'  exact quote  ');});
test('unfinished cannot export final; draft keeps false marker',()=>{const c=reviewed();c.pairs=[pair];assert.throws(()=>C.exportReview([c],{final:true}));const out=JSON.parse(C.exportReview([c])).cases[0];assert.equal(out.review_complete,false);assert.deepEqual(out.expected_pairs,[pair]);});
test('resume retains labels but resets verification and completion',()=>{const c=reviewed();c.pairs=[pair];C.complete(c,true);const [r]=C.resume(C.blank(manifest()),C.exportReview([c],{final:true}));assert.deepEqual(r.pairs,[pair]);assert(!r.complete);assert(!r.verified.original&&!r.verified.revised);});
test('resume rejects source path, hash, or group changes',()=>{const c=reviewed();const base=JSON.parse(C.exportReview([c]));for(const change of [{original:'other.pdf'},{original_sha256:'a'.repeat(64)},{event_group:'another'}]){const draft={...base,cases:[{...base.cases[0],...change}]};assert.throws(()=>C.resume([c],JSON.stringify(draft)));}});
test('export strips extra pair metadata and blocks oversized output',()=>{const c=reviewed();c.pairs=[{...pair,confidence:99}];assert.deepEqual(JSON.parse(C.exportReview([c])).cases[0].expected_pairs,[pair]);c.pairs=Array.from({length:110},()=>({...pair,original_text:'x'.repeat(5000),revised_text:'y'.repeat(5000)}));assert.throws(()=>C.exportReview([c]),/1 MB/);});
test('completion retains live editor object identity',()=>{const c=reviewed();const p={...pair};c.pairs=[p];C.complete(c,true);assert.equal(c.pairs[0],p);});

test('strict JSON rejects duplicate keys including escaped names and nested keys',()=>{
  const good=manifest();
  for(const bad of [good.replace('"version":2','"version":1,"version":2'),good.replace('"id":"case-1"','"id":"wrong","\\u0069d":"case-1"'),good.replace('"expected_pairs":[]','"expected_pairs":[],"hidden":{"x":1,"x":2}')]) assert.throws(()=>C.blank(bad),/Duplicate JSON field/);
  assert.equal(C.blank(manifest({...source,hidden:{text:'{ "id": \\"quoted\\" }'}})).length,1);
});
test('strict JSON rejects overflow numbers, malformed values, and excess nesting',()=>{
  for(const value of ['1e999','01','[1,]','{"x":1,}', '['.repeat(65)+'0'+']'.repeat(65)]) assert.throws(()=>C.blank(manifest().replace('"version":2','"version":2,"hidden":'+value)));
});
test('draft preserves partial work without producing scoreable labels',()=>{
  const c=reviewed();c.pairs=[{...pair,original_page:null,revised_page:1.5,revised_text:''}];
  const json=C.saveDraft([c]);const raw=JSON.parse(json);
  assert.equal(raw.format,'noticebridge-review-draft');assert.equal(raw.version,1);
  assert(!('expected_pairs' in raw.cases[0]));assert(!('review_complete' in raw.cases[0]));
  assert.throws(()=>C.blank(json));
  const [resumed]=C.resume(C.blank(manifest()),json);assert.deepEqual(resumed.pairs,c.pairs);assert.equal(resumed.complete,false);assert.equal(resumed.verified.original,false);
  resumed.verified={original:true,revised:true};assert.throws(()=>C.complete(resumed,true));
});
test('draft from completed review never carries completion and restores labels',()=>{
  const c=reviewed();c.pairs=[pair];C.complete(c,true);
  const [r]=C.resume(C.blank(manifest()),C.saveDraft([c]));assert.deepEqual(r.pairs,[pair]);assert.equal(r.complete,false);
});
test('draft rejects duplicate cases, changed source, invalid partial values and excess pairs',()=>{
  const c=reviewed();c.pairs=[pair];const raw=JSON.parse(C.saveDraft([c]));
  assert.throws(()=>C.resume([c],JSON.stringify({...raw,cases:[raw.cases[0],raw.cases[0]]})),/Duplicate/);
  assert.throws(()=>C.resume([c],JSON.stringify({...raw,cases:[{...raw.cases[0],event_group:'other'}]})),/metadata differs/);
  for(const change of [{original_page:'1'},{original_text:null},{revised_text:'x'.repeat(5001)}]){c.pairs=[{...pair,...change}];assert.throws(()=>C.saveDraft([c]));}
  c.pairs=Array.from({length:501},()=>pair);assert.throws(()=>C.saveDraft([c]),/Too many/);
});

test('case IDs and fingerprints reject trailing newline and other delimiters',()=>{
  for(const change of [{id:'case-1\n'},{issuer_group:'board\r'},{original_sha256:hash+'\n'},{original:'a.pdf\n'}]) assert.throws(()=>C.blank(manifest({...source,...change})));
});
test('strict manifest decoder rejects malformed UTF-8 and preserves explicit BOM for rejection',()=>{
  const bad=new Uint8Array([0x7b,0xff,0x7d]);assert.throws(()=>C.decodeManifestBytes(bad.buffer),/UTF-8/);
  const good=new TextEncoder().encode(manifest());assert.equal(C.blank(C.decodeManifestBytes(good.buffer)).length,1);
  const bom=new TextEncoder().encode('\ufeff'+manifest());assert.throws(()=>C.blank(C.decodeManifestBytes(bom.buffer)));
});
test('lone Unicode surrogates cannot enter source metadata or exported quotations',()=>{
  for(const change of [{original:'bad\ud800.pdf'},{hidden:'\udc00'}])assert.throws(()=>C.blank(manifest({...source,...change})),/surrogate/);
  assert.throws(()=>C.pairOf({...pair,original_text:'\ud800'}));
  const c=reviewed();c.pairs=[{...pair,revised_text:'\udc00'}];assert.throws(()=>C.saveDraft([c]));
  assert.equal(C.pairOf({...pair,original_text:'Example 🧪'}).original_text,'Example 🧪');
});
test('quote whitespace validation mirrors Python rather than JS trim',()=>{
  for(const v of ['\u0085','\u001c','\u3000','\u00a0'])assert.throws(()=>C.pairOf({...pair,original_text:v}));
  assert.equal(C.pairOf({...pair,original_text:'\ufeff'}).original_text,'\ufeff');
});
test('next incomplete case wraps around and handles all complete and empty sets',()=>{
  const pending={complete:false},done={complete:true};
  assert.equal(C.nextIncomplete([done,pending,done,pending],1),3);
  assert.equal(C.nextIncomplete([done,pending,done,pending],3),1);
  assert.equal(C.nextIncomplete([pending],0),0);
  assert.equal(C.nextIncomplete([done,done],0),null);
  assert.equal(C.nextIncomplete([],0),null);
});
