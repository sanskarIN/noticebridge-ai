/* NoticeBridge review workbench — offline validation and review state. Apache-2.0 */
(function (root) {
  'use strict';
  const MAX_BYTES = 1_000_000, MAX_PDF = 10 * 1024 * 1024, MAX_PAGES = 80, MAX_CASES = 500, MAX_PAIRS = 500, MAX_OCR_PAGES = 12;
  const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
  const SHA = /^[a-f0-9]{64}$/;
  const SOURCE_KINDS = new Set(['fictional', 'public_notice', 'consented']);
  const fields = ['id', 'source_kind', 'original', 'revised', 'original_sha256', 'revised_sha256'];
  const optional = ['issuer_group', 'event_group', 'original_ocr_pages', 'revised_ocr_pages'];
  const enc = new TextEncoder();
  const fail = message => { throw new Error(message); };
  const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const isId = v => typeof v === 'string' && ID.test(v);
  const isSha = v => typeof v === 'string' && v.length === 64 && SHA.test(v);
  // Reject lone UTF-16 surrogates: Python's canonical UTF-8 manifest hashing
  // cannot encode them. Valid supplementary characters must remain intact.
  const scalarText = v => typeof v === 'string' && v.isWellFormed();
  // Python str.strip() differs from JavaScript trim() (e.g. NEL and BOM).
  // Match the whitespace used by the backend's nonempty quote check.
  const hasQuote = v => scalarText(v) && /[^\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/u.test(v);
  function decodeManifestBytes(bytes) {
    if (!(bytes instanceof ArrayBuffer) || bytes.byteLength > MAX_BYTES) fail('Manifest exceeds the 1 MB limit.');
    try { return new TextDecoder('utf-8', {fatal:true, ignoreBOM:true}).decode(bytes); }
    catch { fail('Manifest must be valid UTF-8.'); }
  }
  function pathOk(v) {
    return scalarText(v) && v.length > 0 && /\.pdf$/i.test(v) &&
      !/^[\/]|[\\:\u0000-\u001f\u007f]/.test(v) && !v.split('/').some(x => x === '..' || !x);
  }
  function ocrPages(v) {
    // Mirror the current backend selected-page budget.
    if (!Array.isArray(v) || v.length > MAX_OCR_PAGES || new Set(v).size !== v.length ||
        v.some(x => !Number.isInteger(x) || x < 1 || x > MAX_PAGES)) fail('Invalid OCR page selection.');
    return [...v].sort((a,b) => a-b);
  }
  function sourceOf(c) {
    if (!isObject(c) || !isId(c.id) || !SOURCE_KINDS.has(c.source_kind)) fail('Invalid case ID or source kind.');
    for (const role of ['original','revised']) {
      if (!pathOk(c[role]) || !isSha(c[role + '_sha256'])) fail(c.id + ': invalid PDF path or fingerprint.');
    }
    const source = Object.fromEntries(fields.map(k => [k,c[k]]));
    if (own(c,'issuer_group') !== own(c,'event_group')) fail(c.id + ': group identifiers must occur together.');
    for (const k of optional) if (own(c,k)) {
      if (k.endsWith('_pages')) source[k] = ocrPages(c[k]);
      else { if (!isId(c[k])) fail(c.id + ': invalid group identifier.'); source[k] = c[k]; }
    }
    return source;
  }
  // Check object keys on the original JSON, before JSON.parse can discard duplicates.
  // The bounded scanner validates grammar before JSON.parse, including nested objects.
  function strictJson(text) {
    if (typeof text !== 'string' || enc.encode(text).length > MAX_BYTES) fail('Manifest exceeds the 1 MB limit.');
    let pos = 0;
    const ws = () => { while (/[ \t\r\n]/.test(text[pos] || '')) pos++; };
    function string() {
      const start = pos++;
      while (pos < text.length) {
        const ch = text[pos++];
        if (ch === '\\') pos++;
        else if (ch === '"') {
          const decoded = JSON.parse(text.slice(start, pos));
          if (!scalarText(decoded)) fail('JSON contains an unpaired Unicode surrogate.');
          return decoded;
        }
      }
      fail('Invalid JSON string.');
    }
    function value(depth) {
      if (depth > 64) fail('JSON nesting exceeds limit.');
      ws(); const ch = text[pos];
      if (ch === '{' || ch === '[') {
        const object = ch === '{', close = object ? '}' : ']', keys = new Set();
        pos++; ws();
        if (text[pos] === close) { pos++; return; }
        while (true) {
          if (object) {
            if (text[pos] !== '"') fail('Invalid JSON object key.');
            const key = string();
            if (keys.has(key)) fail('Duplicate JSON field: ' + key);
            keys.add(key); ws(); if (text[pos++] !== ':') fail('Invalid JSON object.');
          }
          value(depth + 1); ws();
          if (text[pos] === close) { pos++; return; }
          if (text[pos++] !== ',') fail('Invalid JSON separator.');
          ws();
        }
      }
      if (ch === '"') { string(); return; }
      const token = /(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/y;
      token.lastIndex = pos; const match = token.exec(text);
      if (!match) fail('Invalid JSON value.');
      if (/^-?\d/.test(match[0]) && !Number.isFinite(Number(match[0]))) fail('Non-finite JSON number.');
      pos = token.lastIndex;
    }
    value(0); ws(); if (pos !== text.length) fail('Unexpected trailing JSON.');
    return JSON.parse(text);
  }
  function parse(text) {
    if (typeof text !== 'string' || enc.encode(text).length > MAX_BYTES) fail('Manifest exceeds the 1 MB limit.');
    const p = strictJson(text);
    if (!isObject(p) || p.version !== 2 || !Array.isArray(p.cases) || p.cases.length < 1 || p.cases.length > MAX_CASES) fail('Use a version-2 pinned manifest with 1–500 cases.');
    const seen = new Set();
    for (const c of p.cases) {
      const source = sourceOf(c);
      if (seen.has(source.id)) fail('Duplicate case ID: ' + source.id);
      seen.add(source.id);
    }
    return p.cases;
  }
  function pairOf(p) {
    if (!isObject(p)) fail('A passage pair must be an object.');
    const result = {};
    for (const role of ['original','revised']) {
      const page = p[role+'_page'], text = p[role+'_text'];
      if (!Number.isInteger(page) || page < 1 || page > MAX_PAGES) fail('Page must be an integer from 1 to 80.');
      if (!hasQuote(text) || [...text].length > 5000) fail('Enter an exact, nonempty quote of up to 5,000 characters.');
      result[role+'_page'] = page; result[role+'_text'] = text;
    }
    return result;
  }
  function blank(text) {
    return parse(text).map(c => {
      if (!['unreviewed','independent_human'].includes(c.label_method) || c.review_complete !== false ||
          !Array.isArray(c.expected_pairs) || c.expected_pairs.length !== 0) fail(c.id + ': load a blank, explicitly unfinished review manifest, not answer labels.');
      return {source: sourceOf(c), pairs: [], verified: {original:false,revised:false}, complete:false};
    });
  }
  function identity(source) { return JSON.stringify(sourceOf(source)); }
  function partialPair(p) {
    if (!isObject(p)) fail('A draft passage pair must be an object.');
    const result = {};
    for (const role of ['original','revised']) {
      const page = p[role+'_page'], text = p[role+'_text'];
      if (page !== null && (typeof page !== 'number' || !Number.isFinite(page))) fail('Invalid draft page.');
      if (!scalarText(text) || [...text].length > 5000) fail('Invalid draft quotation.');
      result[role+'_page'] = page; result[role+'_text'] = text;
    }
    return result;
  }
  // This format is deliberately not a backend v2 evaluation manifest.
  function saveDraft(cases) {
    if (!Array.isArray(cases) || !cases.length || cases.length > MAX_CASES) fail('No review cases loaded.');
    const output = {format:'noticebridge-review-draft',version:1,cases:cases.map(c=>{
      if (c.pairs.length > MAX_PAIRS) fail('Too many passage pairs.');
      return {...sourceOf(c.source),draft_pairs:c.pairs.map(partialPair)};
    })};
    const json = JSON.stringify(output,null,2)+'\n';
    if (enc.encode(json).length > MAX_BYTES) fail('Draft exceeds the 1 MB manifest limit.');
    return json;
  }
  function resume(cases,text) {
    const payload = strictJson(text);
    const local = isObject(payload) && payload.format === 'noticebridge-review-draft';
    const loaded = local ? payload.cases : parse(text);
    if (local && (payload.version !== 1 || !Array.isArray(loaded) || loaded.length < 1 || loaded.length > MAX_CASES)) fail('Invalid workbench draft.');
    const map = new Map();
    for (const entry of loaded) {
      const id = sourceOf(entry).id;
      if (map.has(id)) fail('Duplicate draft case ID: ' + id);
      map.set(id,entry);
    }
    if (map.size !== cases.length) fail('Draft does not cover the same case set.');
    return cases.map(c => {
      const draft = map.get(c.source.id);
      if (!draft || identity(draft) !== identity(c.source)) fail(c.source.id + ': draft source or metadata differs.');
      const pairs = local ? draft.draft_pairs : draft.expected_pairs;
      if ((!local && (draft.label_method !== 'independent_human' || typeof draft.review_complete !== 'boolean')) ||
          !Array.isArray(pairs) || pairs.length > MAX_PAIRS) fail(c.source.id + ': invalid draft labels.');
      // Reverification and fresh human completion are required in each browser session.
      return {source:c.source,pairs:pairs.map(local ? partialPair : pairOf),verified:{original:false,revised:false},complete:false};
    });
  }
  async function verifyPdf(file, expected, cryptoImpl) {
    if (!isSha(expected) || !file || typeof file.arrayBuffer !== 'function' ||
        !Number.isInteger(file.size) || file.size < 5 || file.size > MAX_PDF) fail('Choose a nonempty PDF of at most 10 MiB.');
    if (!cryptoImpl?.subtle) fail('SHA-256 is unavailable in this browser context. Use a modern browser or localhost.');
    const bytes = await file.arrayBuffer();
    if (bytes.byteLength !== file.size || bytes.byteLength > MAX_PDF ||
        new TextDecoder().decode(new Uint8Array(bytes,0,5)) !== '%PDF-') fail('Selected file lacks a valid PDF header.');
    const digest = [...new Uint8Array(await cryptoImpl.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');
    if (digest !== expected) fail('SHA-256 mismatch. Choose the exact pinned PDF.');
    return digest;
  }
  function nextIncomplete(cases, active) {
    for (let step=1; step<=cases.length; step++) {
      const index=(active+step)%cases.length;
      if (!cases[index].complete) return index;
    }
    return null;
  }
  function complete(c, affirmed) {
    if (affirmed !== true || !c.verified.original || !c.verified.revised) fail('Verify both PDFs and explicitly confirm human review.');
    if (c.pairs.length > MAX_PAIRS) fail('Too many passage pairs.');
    c.pairs.forEach(pairOf); c.complete = true;
  }
  function exportReview(cases,{final=false}={}) {
    if (!Array.isArray(cases) || !cases.length || cases.length > MAX_CASES) fail('No review cases loaded.');
    if (final && cases.some(c=>!c.complete)) fail('Complete every case before exporting a finished review.');
    const output = {version:2,cases:cases.map(c=>{
      if (c.pairs.length > MAX_PAIRS) fail('Too many passage pairs.');
      const done = c.complete === true && c.verified.original === true && c.verified.revised === true;
      if (final && !done) fail('Unverified source files cannot be marked complete.');
      return {...sourceOf(c.source),label_method:'independent_human',review_complete:done,expected_pairs:c.pairs.map(pairOf)};
    })};
    const json = JSON.stringify(output,null,2)+'\n';
    if (enc.encode(json).length > MAX_BYTES) fail('Review exceeds the 1 MB manifest limit.');
    return json;
  }
  const api = {MAX_BYTES,MAX_PDF,MAX_PAGES,MAX_PAIRS,blank,resume,pairOf,verifyPdf,complete,exportReview,saveDraft,sourceOf,decodeManifestBytes,nextIncomplete};
  if (typeof module === 'object' && module.exports) module.exports=api; else root.ReviewCore=api;
})(typeof globalThis === 'object' ? globalThis : this);
