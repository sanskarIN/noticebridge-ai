/** Explain strict collection retrieval without promoting additional
 * candidates into the saved answer. Scores are local ranking weights. */
import {knownQuestionField,queryTerms,pageScopedIndex,rankedMatchDetails,matchTermScores,
  type Passage,type RankedMatch,type MatchTermScore,type SearchIndex} from './pdfChatCore';
import {parseSearchQuestion} from './pdfChatInsights';
import {runCollectionStep,collectionCitation,type CollectionDocument,type CollectionPart} from './pdfChatCollection';
import {selectedCollectionDocuments} from './pdfChatCollectionTools';
export const COLLECTION_RANK_PAGE_SIZE=8;
export type RankingMatchMode='lexical'|'field'|'lexical_and_field';
export type CollectionRankingRow=RankedMatch&{
  rank:number;displayed:boolean;mode:RankingMatchMode;
};
export type CollectionRankingTrace={
  documentId:string;question:string;physicalPage:number|undefined;
  terms:string[];field:ReturnType<typeof knownQuestionField>;
  indexedFragments:number;scopedFragments:number;averageTokenLength:number;
  strictMatches:number;collapsedDuplicates:number;shownStrictMatches:number;
  state:'ranked'|'contextual'|'no_match'|'no_terms'|'term_limit';
  rows:CollectionRankingRow[];index:SearchIndex;
  context:Passage[][];
};
export type CollectionRankingFilter={mode:RankingMatchMode|'all';display:'all'|'shown'|'omitted';query:string};
function invalid():never{throw new Error('Invalid or mismatched collection ranking trace.');}

export function explainCollectionRanking(documents:readonly CollectionDocument[],documentId:string,part:CollectionPart,
  includeContext:boolean):CollectionRankingTrace{
  const [doc]=selectedCollectionDocuments(documents,[documentId]);
  if(typeof includeContext!=='boolean'||part.answer.scope!=='original')invalid();
  const parsed=parseSearchQuestion(part.answer.question);
  if(parsed.page!==part.answer.pageFilter)invalid();
  // Re-execute the saved question part before explaining it. A caller may
  // not attach a forged citation or omit a displayed fragment.
  const replay=runCollectionStep(documents,{question:part.answer.question,documentIds:[documentId],includeContext});
  const fresh=replay.results[0]?.parts[0];
  if(replay.results[0]?.parts.length!==1||!fresh||fresh.coverage!==part.coverage||
      JSON.stringify(fresh.answer)!==JSON.stringify(part.answer))invalid();
  const terms=queryTerms(parsed.content);
  const field=knownQuestionField(terms);
  const index=parsed.page===undefined?doc.index:pageScopedIndex(doc.index,parsed.page);
  const ranked=terms.length&&terms.length<=16?rankedMatchDetails(index,terms,'original',field):[];
  const displayed=new Set(fresh.answer.citations);
  const rows=ranked.map((row,i):CollectionRankingRow=>{
    collectionCitation(documents,documentId,row.passage);
    return {...row,rank:i+1,displayed:displayed.has(row.passage),
      mode:row.lexical&&row.knownField?'lexical_and_field':row.lexical?'lexical':'field'};
  });
  const strictMatches=rows.length;
  const shownStrictMatches=rows.filter(row=>row.displayed).length;
  if(strictMatches!==fresh.answer.matchedCounts.original||shownStrictMatches!==Math.min(4,strictMatches))invalid();
  const context=fresh.answer.contextGroups.map(group=>group.citations.map(i=>{
    const source=fresh.answer.citations[i-1];
    if(!source)invalid();
    return collectionCitation(documents,documentId,source).source;
  }));
  const state:CollectionRankingTrace['state']=!terms.length?'no_terms':terms.length>16?'term_limit':
    rows.length?'ranked':context.length?'contextual':'no_match';
  return {documentId,question:part.answer.question,physicalPage:parsed.page,terms,field,
    indexedFragments:doc.index.corpusSize,scopedFragments:index.rows.length,averageTokenLength:doc.index.average,
    strictMatches,collapsedDuplicates:rows.reduce((sum,row)=>sum+row.duplicates,0),
    shownStrictMatches,state,rows,index,context};
}
export function filterCollectionRanking(trace:CollectionRankingTrace,filter:CollectionRankingFilter){
  if(!['all','lexical','field','lexical_and_field'].includes(filter.mode)||
      !['all','shown','omitted'].includes(filter.display)||typeof filter.query!=='string'||filter.query.length>100)invalid();
  const query=filter.query.trim().toLowerCase();
  return trace.rows.filter(row=>(filter.mode==='all'||row.mode===filter.mode)&&
    (filter.display==='all'||row.displayed===(filter.display==='shown'))&&
    (!query||row.passage.text.toLowerCase().includes(query)));
}
export function collectionRankingPage(rows:readonly CollectionRankingRow[],page:number){
  const pages=Math.max(1,Math.ceil(rows.length/COLLECTION_RANK_PAGE_SIZE));
  if(!Number.isSafeInteger(page)||page<1||page>pages)invalid();
  const offset=(page-1)*COLLECTION_RANK_PAGE_SIZE;
  return {pages,rows:rows.slice(offset,offset+COLLECTION_RANK_PAGE_SIZE),first:rows.length?offset+1:0,
    last:Math.min(rows.length,offset+COLLECTION_RANK_PAGE_SIZE)};
}
export function collectionRankingTermScores(trace:CollectionRankingTrace,row:CollectionRankingRow):MatchTermScore[]{
  if(!trace.rows.includes(row))invalid();
  const scores=matchTermScores(trace.index,row.passage,trace.terms);
  const sum=scores.reduce((total,term)=>total+term.contribution,0);
  if(sum!==row.score)invalid();
  return scores;
}
export function inspectCollectionRanking(documents:readonly CollectionDocument[],trace:CollectionRankingTrace,
  row:CollectionRankingRow){
  if(!trace.rows.includes(row))invalid();
  return collectionCitation(documents,trace.documentId,row.passage).source;
}
