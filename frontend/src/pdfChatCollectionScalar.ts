/** Guarded arithmetic on literal scalar candidates from a saved collection
 * question. No document order or notice amendment is inferred. */
import {collectionCitation,type CollectionDocument,type CollectionTurn} from './pdfChatCollection';
import {collectionAnswerSummary,type CollectionAnswerRow,type CollectionAnswerCell} from './pdfChatCollectionAnswerSummary';
import {parsePrintedMoney,parsePrintedDate,scalarFieldKind,formatMoneyMagnitude,
  type Money,type CivilDate,type Currency} from './pdfChatScalarComparison';
import type {ExtractedField,FieldId} from './pdfChatOverview';
export type ScalarUnavailable='coverage'|'missing_value'|'multiple_values'|'possible_conditions'|'unrecognized_value';
export type ScalarSide=
  {documentId:string;status:'unavailable';reason:ScalarUnavailable;values:ExtractedField[]}|
  {documentId:string;status:'available';kind:'money';value:Money;source:ExtractedField}|
  {documentId:string;status:'available';kind:'date';value:CivilDate;source:ExtractedField};
export type ScalarPair=
  {left:string;right:string;status:'unavailable';reason:'unavailable_value'|'different_currency'}|
  {left:string;right:string;status:'available';kind:'money';currency:Currency;difference:bigint}|
  {left:string;right:string;status:'available';kind:'date';difference:number};
export type CollectionScalarAnalysis={question:string;page?:number;field:FieldId;kind:'money'|'date';
  sides:ScalarSide[];pairs:ScalarPair[]};
function invalid():never{throw Error('Invalid collection scalar comparison.');}
function inspectCell(documents:readonly CollectionDocument[],cell:CollectionAnswerCell,field:FieldId,kind:'money'|'date'):ScalarSide{
  const {documentId,part,direct}=cell;
  const values=direct?.values.flatMap(value=>value.sources)??[];
  for(const value of values){
    collectionCitation(documents,documentId,value.source);
    if(value.definition.id!==field)invalid();
  }
  function unavailable(reason:ScalarUnavailable):ScalarSide{return {documentId,status:'unavailable',reason,values};}
  if(part.coverage!=='some_text')return unavailable('coverage');
  if(!direct||!direct.distinctValues)return unavailable('missing_value');
  if(direct.distinctValues!==1||direct.values.length!==1)return unavailable('multiple_values');
  if(direct.otherMatchingPassages||direct.nearbyPassages||direct.reviewPassages.length||part.answer.contextGroups.length)
    return unavailable('possible_conditions');
  const source=direct.values[0].sources[0];
  if(!source||source.value!==direct.values[0].value)return unavailable('unrecognized_value');
  if(kind==='money'){
    const value=parsePrintedMoney(source.value);
    return value?{documentId,status:'available',kind,value,source}:unavailable('unrecognized_value');
  }
  const value=parsePrintedDate(source.value);
  return value?{documentId,status:'available',kind,value,source}:unavailable('unrecognized_value');
}
export function collectionScalarAnalysis(documents:readonly CollectionDocument[],turn:CollectionTurn,partIndex:number):CollectionScalarAnalysis|null{
  const summary=collectionAnswerSummary(documents,turn);
  if(!Number.isSafeInteger(partIndex)||partIndex<0||partIndex>=summary.rows.length)invalid();
  const row=summary.rows[partIndex];
  if(!row.field||row.cells.length<2)return null;
  return analyzeScalarRow(documents,row);
}
function analyzeScalarRow(documents:readonly CollectionDocument[],row:CollectionAnswerRow):CollectionScalarAnalysis|null{
  if(!row.field)return null;
  const kind=scalarFieldKind(row.field.id);
  if(!kind)return null;
  const sides=row.cells.map(cell=>inspectCell(documents,cell,row.field!.id,kind));
  const pairs:ScalarPair[]=[];
  for(let i=0;i<sides.length;i++)for(let j=i+1;j<sides.length;j++){
    const a=sides[i],b=sides[j],ids={left:a.documentId,right:b.documentId};
    if(a.status!=='available'||b.status!=='available'){
      pairs.push({...ids,status:'unavailable',reason:'unavailable_value'});continue;
    }
    if(a.kind==='money'&&b.kind==='money'){
      if(a.value.currency!==b.value.currency)pairs.push({...ids,status:'unavailable',reason:'different_currency'});
      else pairs.push({...ids,status:'available',kind:'money',currency:a.value.currency,difference:b.value.minor-a.value.minor});
    }else if(a.kind==='date'&&b.kind==='date'){
      pairs.push({...ids,status:'available',kind:'date',difference:b.value.serial-a.value.serial});
    }else invalid();
  }
  return {question:row.question,page:row.page,field:row.field.id,kind,sides,pairs};
}
/** Neutral direction is second selected printed value minus first.
 * No first/revised terminology or implication of chronological order. */
export function explainScalarPair(pair:ScalarPair):string{
  if(pair.status==='unavailable')return pair.reason==='different_currency'?
    'Printed currency notations differ; no currency conversion is performed.':'At least one selected printed value cannot be compared.';
  if(pair.kind==='money'){
    if(pair.difference===0n)return 'Both printed amounts denote the same numeric value in the same currency notation.';
    return 'Second selected printed amount is '+formatMoneyMagnitude(pair.difference,pair.currency)+
      (pair.difference>0n?' higher':' lower')+' than the first.';
  }
  if(pair.difference===0)return 'Both printed dates denote the same calendar day.';
  const count=Math.abs(pair.difference);
  return 'Second selected printed date is '+count+' calendar '+(count===1?'day':'days')+
    (pair.difference>0?' later':' earlier')+' than the first.';
}
export function inspectScalarSource(documents:readonly CollectionDocument[],analysis:CollectionScalarAnalysis,
  side:ScalarSide,source:ExtractedField){
  if(!analysis.sides.includes(side)||source.definition.id!==analysis.field||
    (side.status==='available'?side.source!==source:!side.values.includes(source)))invalid();
  return collectionCitation(documents,side.documentId,source.source).source;
}
