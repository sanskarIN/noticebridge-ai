/** Explicit aligned table comparison. A known field key and normalized
 * printed category are candidate alignment keys, not semantic equivalence. */
import {collectionCitation,type CollectionDocument} from './pdfChatCollection';
import {collectionTableInventory,inspectCollectionTableSource,type CollectionTable} from './pdfChatCollectionLayout';
import {fieldDefinitions,type FieldId} from './pdfChatOverview';
import type {Passage} from './pdfChatCore';
import {serializeCollectionSnapshot} from './pdfChatCollectionReplay';
import {requestHash} from './pdfChatEmbeddingBridge';

export const MAX_TABLE_COMPARISON_SOURCES=6;
export const MAX_TABLE_COMPARISON_ROWS=240;
export const MAX_TABLE_COMPARISON_BYTES=4*1024*1024;
export const TABLE_COMPARISON_PAGE_SIZE=10;
export type TableChoice={documentId:string;key:string};
export type TableComparisonCell={
  documentId:string;tableKey:string;state:'present'|'missing_category'|'missing_field'|'missing_both';
  categoryHeader:Passage;fieldHeader:Passage|null;category:Passage|null;value:Passage|null;
};
export type TableComparisonState='same_text'|'different_text'|'missing';
export type TableComparisonRow={
  categoryKey:string;field:FieldId;cells:TableComparisonCell[];state:TableComparisonState;
  differentCategoryLabels:boolean;differentFieldLabels:boolean;
};
export type CollectionTableComparison={
  choices:TableChoice[];
  tables:CollectionTable[];
  rows:TableComparisonRow[];
  counts:Record<TableComparisonState,number>;
  limited:boolean;
};
function invalid():never{throw new Error('Invalid or mismatched collection table comparison.');}
function categoryKey(value:string){
  // Keep the complete printed category, including a category suffix.
  // Only case, Unicode compatibility and whitespace are normalized.
  return value.normalize('NFKC').trim().replace(/\s+/g,' ').toLowerCase();
}
function pickTables(documents:readonly CollectionDocument[],choices:readonly TableChoice[]){
  if(!Array.isArray(choices)||choices.length<2||choices.length>MAX_TABLE_COMPARISON_SOURCES||
      new Set(choices.map(row=>row.documentId)).size!==choices.length)invalid();
  const sides=collectionTableInventory(documents,choices.map(row=>row.documentId));
  const tables=choices.map((choice,index)=>{
    const row=sides[index].tables.find(table=>table.key===choice.key);
    if(!row||row.documentId!==choice.documentId)invalid();
    for(const source of [...row.table.headers,...row.table.rows.flat()])collectionCitation(documents,row.documentId,source);
    return row;
  });
  return {tables,limited:sides.some(side=>side.limited||side.skippedPages.length>0)||
    choices.some(choice=>{const doc=documents.find(row=>row.id===choice.documentId)!;
      return doc.corpus.limited||doc.corpus.missingPages.length>0;})};
}
export function compareCollectionTables(documents:readonly CollectionDocument[],choices:readonly TableChoice[]):CollectionTableComparison{
  const {tables,limited}=pickTables(documents,choices);
  const indexed=tables.map(row=>{
    const categories=new Map<string,Passage[]>();
    for(const cells of row.table.rows){
      const key=categoryKey(cells[0].text);
      if(!key||categories.has(key))invalid();
      categories.set(key,cells);
    }
    return {row,categories};
  });
  const categoryKeys=[...new Set(indexed.flatMap(row=>[...row.categories.keys()]))];
  if(categoryKeys.length>MAX_TABLE_COMPARISON_ROWS)invalid();
  const fields=fieldDefinitions.map(field=>field.id).filter(field=>tables.some(row=>row.table.fields.includes(field)));
  const rows:TableComparisonRow[]=[];
  const counts:Record<TableComparisonState,number>={same_text:0,different_text:0,missing:0};
  for(const category of categoryKeys)for(const field of fields){
    const cells:TableComparisonCell[]=indexed.map(({row,categories})=>{
      const line=categories.get(category),column=row.table.fields.indexOf(field)+1;
      return {documentId:row.documentId,tableKey:row.key,
        state:line&&column?'present':line?'missing_field':column?'missing_category':'missing_both',
        categoryHeader:row.table.headers[0],fieldHeader:column?row.table.headers[column]:null,
        category:line?.[0]??null,value:line&&column?line[column]:null};
    });
    // Only display combinations that have at least one actual cell.
    if(!cells.some(cell=>cell.value))continue;
    const state=cells.some(cell=>!cell.value)?'missing':
      new Set(cells.map(cell=>cell.value!.text)).size===1?'same_text':'different_text';
    if(rows.length>=MAX_TABLE_COMPARISON_ROWS)invalid();
    counts[state]++;
    rows.push({categoryKey:category,field,cells,state,
      differentCategoryLabels:new Set(cells.flatMap(cell=>cell.category?[cell.category.text]:[])).size>1,
      differentFieldLabels:new Set(cells.flatMap(cell=>cell.fieldHeader?[cell.fieldHeader.text]:[])).size>1});
  }
  return {choices:choices.map(choice=>({...choice})),tables,rows,counts,limited};
}
export type TableComparisonFilter={state:TableComparisonState|'all';field:FieldId|'all';category:string};
export function filterTableComparison(result:CollectionTableComparison,filter:TableComparisonFilter){
  if(!['all','same_text','different_text','missing'].includes(filter.state)||
      filter.field!=='all'&&!fieldDefinitions.some(field=>field.id===filter.field)||
      typeof filter.category!=='string'||filter.category.length>100)invalid();
  const query=categoryKey(filter.category);
  return result.rows.filter(row=>(filter.state==='all'||row.state===filter.state)&&
    (filter.field==='all'||row.field===filter.field)&&(!query||row.categoryKey.includes(query)));
}
export function tableComparisonPage(rows:readonly TableComparisonRow[],page:number){
  const pages=Math.max(1,Math.ceil(rows.length/TABLE_COMPARISON_PAGE_SIZE));
  if(!Number.isSafeInteger(page)||page<1||page>pages)invalid();
  const offset=(page-1)*TABLE_COMPARISON_PAGE_SIZE;
  return {pages,rows:rows.slice(offset,offset+TABLE_COMPARISON_PAGE_SIZE),first:rows.length?offset+1:0,
    last:Math.min(rows.length,offset+TABLE_COMPARISON_PAGE_SIZE)};
}
export function inspectTableComparisonCell(documents:readonly CollectionDocument[],result:CollectionTableComparison,
  row:TableComparisonRow,cell:TableComparisonCell,source:Passage){
  if(!result.rows.includes(row)||!row.cells.includes(cell)||
      ![cell.categoryHeader,cell.fieldHeader,cell.category,cell.value].includes(source))invalid();
  return inspectCollectionTableSource(documents,cell.documentId,cell.tableKey,source).source;
}
const FORMAT='noticebridge-collection-table-comparison';
const POLICY='Explicit aligned native table candidates; not verified equivalence, changes or applicability.';
function encode(value:unknown){
  const text=JSON.stringify(value,null,2)+'\n';
  if(new TextEncoder().encode(text).byteLength>MAX_TABLE_COMPARISON_BYTES)invalid();
  return text;
}
function quote(source:Passage|null){
  return source?{page:source.page,ordinal:source.ordinal,text:source.text}:null;
}
export async function serializeTableComparison(documents:readonly CollectionDocument[],choices:readonly TableChoice[],
  consent:boolean,signal?:AbortSignal){
  if(consent!==true)invalid();
  signal?.throwIfAborted();
  const result=compareCollectionTables(documents,choices);
  const snapshot_sha256=await requestHash(serializeCollectionSnapshot(documents));
  signal?.throwIfAborted();
  return encode({format:FORMAT,version:1,policy:POLICY,authority_verified:false,snapshot_sha256,
    choices:result.choices,counts:result.counts,limited:result.limited,
    rows:result.rows.map(row=>({category_key:row.categoryKey,field:row.field,state:row.state,
      different_category_labels:row.differentCategoryLabels,different_field_labels:row.differentFieldLabels,
      cells:row.cells.map(cell=>({document_id:cell.documentId,table_key:cell.tableKey,state:cell.state,
        category_header:quote(cell.categoryHeader),field_header:quote(cell.fieldHeader),
        category:quote(cell.category),value:quote(cell.value)}))}))});
}
export async function verifyTableComparison(text:string,documents:readonly CollectionDocument[],signal?:AbortSignal){
  signal?.throwIfAborted();
  if(!text||text.length>MAX_TABLE_COMPARISON_BYTES||new TextEncoder().encode(text).byteLength>MAX_TABLE_COMPARISON_BYTES)invalid();
  let raw:unknown;
  try{raw=JSON.parse(text);}catch{return invalid();}
  if(!raw||typeof raw!=='object'||Array.isArray(raw))invalid();
  const row=raw as Record<string,unknown>;
  if(row.format!==FORMAT||row.version!==1||row.policy!==POLICY||row.authority_verified!==false||!Array.isArray(row.choices))invalid();
  const choices:TableChoice[]=row.choices.map(value=>{
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==2||
        typeof value.documentId!=='string'||typeof value.key!=='string')invalid();
    return {documentId:value.documentId,key:value.key};
  });
  if(await serializeTableComparison(documents,choices,true,signal)!==text)invalid();
  return compareCollectionTables(documents,choices);
}
export async function readTableComparison(file:File,signal:AbortSignal){
  signal.throwIfAborted();
  if(!file.size||file.size>MAX_TABLE_COMPARISON_BYTES)invalid();
  const data=await file.arrayBuffer();signal.throwIfAborted();
  if(data.byteLength!==file.size)invalid();
  return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(data);
}
