/** A question-centred overview of native collection answers. Never infer
 * version order, equivalent values or the applicability of printed fields. */
import {collectionCitation,runCollectionStep,type CollectionDocument,type CollectionTurn,type CollectionPart} from './pdfChatCollection';
import {directFieldAnswer,type DirectSide} from './pdfChatDirectAnswer';
import type {FieldDefinition} from './pdfChatOverview';
import type {Passage} from './pdfChatCore';

export type CollectionAnswerCell={
  documentId:string;
  part:CollectionPart;
  direct:DirectSide|null;
};
export type CollectionAnswerRow={
  question:string;
  page?:number;
  cells:CollectionAnswerCell[];
  field:FieldDefinition|null;
  matchingDocuments:number;
  limitedDocuments:number;
  state:'all'|'some'|'none';
  printedState:'not_recognized'|'missing'|'multiple'|'single'|'same_text'|'different_text';
};
export type CollectionAnswerSummary={
  rows:CollectionAnswerRow[];
  documents:number;
  searches:number;
  matchingSearches:number;
  limitedSearches:number;
};
function invalid():never{throw new Error('Collection answer overview does not match the current sources.');}
function identity(source:Passage){return source.page+':'+source.ordinal;}
export function collectionAnswerSummary(documents:readonly CollectionDocument[],turn:CollectionTurn):CollectionAnswerSummary{
  const fresh=runCollectionStep(documents,turn.step);
  const rows:CollectionAnswerRow[]=[];
  const parts=fresh.results[0]?.parts??[];
  for(let part=0;part<parts.length;part++){
    const question=parts[part].answer.question,page=parts[part].answer.pageFilter;
    let field:FieldDefinition|null=null;
    const cells:CollectionAnswerCell[]=fresh.results.map(result=>{
      const doc=documents.find(row=>row.id===result.documentId);
      const value=result.parts[part];
      if(!doc||!value||value.answer.question!==question||value.answer.pageFilter!==page)invalid();
      for(const source of value.answer.citations)collectionCitation(documents,doc.id,source);
      const direct=directFieldAnswer(doc.index,value.answer);
      if(direct){
        if(direct.sides.length!==1||direct.sides[0].role!=='original'||field&&field.id!==direct.field.id)invalid();
        field=direct.field;
        for(const group of direct.sides[0].values)
          for(const source of group.sources)collectionCitation(documents,doc.id,source.source);
        for(const row of direct.sides[0].reviewPassages)collectionCitation(documents,doc.id,row.source);
      }
      return {documentId:doc.id,part:value,direct:direct?.sides[0]??null};
    });
    const matchingDocuments=cells.filter(cell=>cell.part.answer.kind!=='insufficient').length;
    const limitedDocuments=cells.filter(cell=>cell.part.coverage!=='some_text').length;
    const state=matchingDocuments===0?'none':matchingDocuments===cells.length?'all':'some';
    let printedState:CollectionAnswerRow['printedState']='not_recognized';
    if(field){
      if(cells.some(cell=>(cell.direct?.distinctValues??0)>1))printedState='multiple';
      else if(cells.some(cell=>!cell.direct?.distinctValues))printedState='missing';
      else if(cells.length===1)printedState='single';
      else printedState=new Set(cells.map(cell=>cell.direct!.values[0].value)).size===1?'same_text':'different_text';
    }
    rows.push({question,page,cells,field,matchingDocuments,limitedDocuments,state,printedState});
  }
  return {rows,documents:fresh.results.length,searches:rows.reduce((sum,row)=>sum+row.cells.length,0),
    matchingSearches:rows.reduce((sum,row)=>sum+row.matchingDocuments,0),
    limitedSearches:rows.reduce((sum,row)=>sum+row.limitedDocuments,0)};
}
export type SummaryFilter='all'|'review'|'no_match'|'printed';
export function filterCollectionAnswerRows(summary:CollectionAnswerSummary,filter:SummaryFilter){
  if(!['all','review','no_match','printed'].includes(filter))invalid();
  return summary.rows.filter(row=>filter==='all'||filter==='no_match'&&row.state==='none'||
    filter==='printed'&&row.field!==null||filter==='review'&&(
      row.state!=='all'||row.limitedDocuments>0||['missing','multiple','different_text'].includes(row.printedState)||
      row.cells.some(cell=>!!cell.direct?.reviewPassages.length)));
}
/** Resolve exact shared quotations independently of search rank. The same
 * text in one PDF more than once is still only one supporting document. */
export type SharedCollectionQuote={text:string;documents:{documentId:string;sources:Passage[]}[]};
export function collectionSharedAnswerQuotes(documents:readonly CollectionDocument[],row:CollectionAnswerRow):SharedCollectionQuote[]{
  const groups=new Map<string,Map<string,Passage[]>>();
  for(const cell of row.cells){
    const seen=new Set<string>();
    for(const source of cell.part.answer.citations){
      collectionCitation(documents,cell.documentId,source);
      if(seen.has(identity(source)))invalid();
      seen.add(identity(source));
      const group=groups.get(source.text)??new Map<string,Passage[]>();
      const list=group.get(cell.documentId)??[];
      list.push(source);group.set(cell.documentId,list);groups.set(source.text,group);
    }
  }
  return [...groups].filter(([,group])=>group.size>1).map(([text,group])=>({
    text,documents:[...group].map(([documentId,sources])=>({documentId,sources})),
  }));
}
