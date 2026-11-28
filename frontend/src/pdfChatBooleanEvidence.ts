/** Bounded boolean search over individual native fragments.
 * This is literal evidence inspection, not natural-language interpretation.
 * No regex input, implicit operators, fuzzy matching or cross-fragment joins. */
import {collectionCitation,type CollectionDocument} from './pdfChatCollection';
import {selectedCollectionDocuments,type CollectionCoverage} from './pdfChatCollectionTools';
import {literalRanges,type TextRange} from './pdfChatEvidenceExplorer';
import {pageCoverage,type Passage} from './pdfChatCore';

export const MAX_BOOLEAN_QUERY=400;
export const MAX_BOOLEAN_PHRASES=12;
export const MAX_BOOLEAN_DEPTH=6;
export const MAX_BOOLEAN_PHRASE_LENGTH=120;
export const BOOLEAN_PAGE_SIZE=10;
type Phrase={kind:'phrase';value:string;id:number};
export type BooleanExpression=Phrase|{kind:'not';child:BooleanExpression}|
  {kind:'and'|'or';left:BooleanExpression;right:BooleanExpression};
type Token={kind:'phrase';value:string}|{kind:'and'|'or'|'not'|'open'|'close'|'end'};
export type ParsedBooleanQuery={expression:BooleanExpression;phrases:string[]};
function invalid():never{throw new Error('Invalid boolean evidence expression.');}
function tokenize(query:string):Token[]{
  if(typeof query!=='string'||!query.trim()||query.length>MAX_BOOLEAN_QUERY||
      /[\u0000-\u0008\u000b-\u001f\u007f\uD800-\uDFFF]/u.test(query))invalid();
  const tokens:Token[]=[];
  let at=0,phrases=0;
  while(at<query.length){
    const char=query[at];
    if(/\s/.test(char)){at++;continue;}
    if(char==='('||char===')'){tokens.push({kind:char==='('?'open':'close'});at++;continue;}
    if(char==='"'){
      let phrase='',closed=false;at++;
      while(at<query.length){
        const c=query[at++];
        if(c==='"'){closed=true;break;}
        if(c==='\\'){
          const escaped=query[at++];
          if(escaped!=='"'&&escaped!=='\\')invalid();
          phrase+=escaped;
        }else phrase+=c;
      }
      if(!closed||!phrase.trim()||phrase.length>MAX_BOOLEAN_PHRASE_LENGTH||++phrases>MAX_BOOLEAN_PHRASES)invalid();
      tokens.push({kind:'phrase',value:phrase});continue;
    }
    const match=/^(AND|OR|NOT)(?![\p{L}\p{N}_])/u.exec(query.slice(at));
    if(!match)invalid();
    tokens.push({kind:match[1].toLowerCase() as 'and'|'or'|'not'});
    at+=match[1].length;
  }
  tokens.push({kind:'end'});
  if(tokens.length>64)invalid();
  return tokens;
}
/** Standard precedence: NOT, then AND, then OR. Require a positive literal
 * in every satisfiable branch; pure negative queries cannot return a whole
 * PDF just because a word is absent. The syntactic guard is conservative. */
export function parseBooleanEvidenceQuery(query:string):ParsedBooleanQuery{
  const tokens=tokenize(query),phrases:string[]=[];
  let at=0;
  const current=()=>tokens[at];
  function primary(depth:number):BooleanExpression{
    if(depth>MAX_BOOLEAN_DEPTH)invalid();
    const token=current();
    if(token.kind==='phrase'){
      at++;let id=phrases.indexOf(token.value);
      if(id<0){id=phrases.length;phrases.push(token.value);}
      return {kind:'phrase',value:token.value,id};
    }
    if(token.kind==='open'){
      at++;const child=or(depth+1);
      if(current().kind!=='close')invalid();
      at++;return child;
    }
    invalid();
  }
  function unary(depth:number):BooleanExpression{
    if(depth>MAX_BOOLEAN_DEPTH)invalid();
    if(current().kind==='not'){at++;return {kind:'not',child:unary(depth+1)};}
    return primary(depth);
  }
  function and(depth:number):BooleanExpression{
    let left=unary(depth);
    while(current().kind==='and'){at++;left={kind:'and',left,right:unary(depth)};}
    return left;
  }
  function or(depth:number):BooleanExpression{
    let left=and(depth);
    while(current().kind==='or'){at++;left={kind:'or',left,right:and(depth)};}
    return left;
  }
  const expression=or(0);
  if(current().kind!=='end'||!phrases.length||!positiveAnchor(expression,false))invalid();
  return {expression,phrases};
}
function positiveAnchor(expr:BooleanExpression,negative:boolean):boolean{
  if(expr.kind==='phrase')return !negative;
  if(expr.kind==='not')return positiveAnchor(expr.child,!negative);
  // Under negation De Morgan swaps AND and OR.
  const both=negative?expr.kind==='and':expr.kind==='or';
  return both?positiveAnchor(expr.left,negative)&&positiveAnchor(expr.right,negative):
    positiveAnchor(expr.left,negative)||positiveAnchor(expr.right,negative);
}
type Evaluation={matches:boolean;positive:Set<number>};
function evaluate(expr:BooleanExpression,found:readonly TextRange[][],negative=false):Evaluation{
  if(expr.kind==='phrase'){
    const present=found[expr.id].length>0;
    return {matches:negative?!present:present,positive:new Set(!negative&&present?[expr.id]:[])};
  }
  if(expr.kind==='not')return evaluate(expr.child,found,!negative);
  const left=evaluate(expr.left,found,negative),right=evaluate(expr.right,found,negative);
  const conjunctive=negative?expr.kind==='or':expr.kind==='and';
  const matches=conjunctive?left.matches&&right.matches:left.matches||right.matches;
  const positive=new Set<number>();
  if(matches){
    if(left.matches)left.positive.forEach(id=>positive.add(id));
    if(right.matches)right.positive.forEach(id=>positive.add(id));
  }
  return {matches,positive};
}
export type BooleanHit={source:Passage;matchedPhrases:string[];ranges:TextRange[]};
export type BooleanSearchQuery={expression:string;documentIds:string[];page?:number;ignoreAsciiCase:boolean};
export type BooleanSearchSide={documentId:string;hits:BooleanHit[];coverage:CollectionCoverage;examined:number};
export type BooleanSearchResult={query:BooleanSearchQuery;phrases:string[];sides:BooleanSearchSide[];total:number};
function mergedRanges(ranges:TextRange[]):TextRange[]{
  const merged:TextRange[]=[];
  ranges.sort((a,b)=>a.start-b.start||a.end-b.end);
  for(const range of ranges){
    const last=merged.at(-1);
    if(last&&range.start<=last.end)last.end=Math.max(last.end,range.end);
    else merged.push({...range});
  }
  return merged.slice(0,24);
}
export function searchBooleanEvidence(documents:readonly CollectionDocument[],query:BooleanSearchQuery):BooleanSearchResult{
  if(!query||typeof query.ignoreAsciiCase!=='boolean'||query.page!==undefined&&
      (!Number.isSafeInteger(query.page)||query.page<1||query.page>80))invalid();
  const selected=selectedCollectionDocuments(documents,query.documentIds);
  const parsed=parseBooleanEvidenceQuery(query.expression);
  const sides: BooleanSearchSide[]=selected.map(doc=>{
    const hits:BooleanHit[]=[];
    let examined=0;
    for(const source of doc.corpus.passages){
      if(query.page!==undefined&&source.page!==query.page)continue;
      examined++;
      const found=parsed.phrases.map(phrase=>literalRanges(source.text,phrase,query.ignoreAsciiCase));
      const outcome=evaluate(parsed.expression,found);
      if(!outcome.matches)continue;
      const ids=[...outcome.positive].sort((a,b)=>a-b);
      if(!ids.length)invalid();
      hits.push({source,matchedPhrases:ids.map(id=>parsed.phrases[id]),
        ranges:mergedRanges(ids.flatMap(id=>found[id]))});
    }
    const {pageCount,processedPages,limitedPages,missingPages,limited}=doc.corpus;
    return {documentId:doc.id,hits,examined,coverage:{pageCount,processedPages,limitedPages:[...limitedPages],
      missingPages:[...missingPages],limited,...(query.page===undefined?{}:{pageState:pageCoverage(doc.corpus,query.page)})}};
  });
  return {query:{...query,documentIds:[...query.documentIds]},phrases:parsed.phrases,sides,total:sides.reduce((sum,row)=>sum+row.hits.length,0)};
}
export function booleanResultPage(hits:readonly BooleanHit[],page:number){
  const pages=Math.max(1,Math.ceil(hits.length/BOOLEAN_PAGE_SIZE));
  if(!Number.isSafeInteger(page)||page<1||page>pages)invalid();
  const offset=(page-1)*BOOLEAN_PAGE_SIZE;
  return {pages,hits:hits.slice(offset,offset+BOOLEAN_PAGE_SIZE),first:hits.length?offset+1:0,last:Math.min(hits.length,offset+BOOLEAN_PAGE_SIZE)};
}
export function inspectBooleanHit(documents:readonly CollectionDocument[],result:BooleanSearchResult,documentId:string,hit:BooleanHit){
  if(!result.sides.find(side=>side.documentId===documentId)?.hits.includes(hit))invalid();
  return collectionCitation(documents,documentId,hit.source).source;
}
