/** Conservative document-outline candidates and explicit exact-text
 * alignment between independently selected collection sections. */
import type { Corpus, Passage } from './pdfChatCore';
import { collectionCitation, type CollectionDocument } from './pdfChatCollection';
import { selectedCollectionDocuments } from './pdfChatCollectionTools';
import { buildOutline, searchSectionFragments, MAX_SECTION_COMPARISON_CHARS,
  MAX_SECTION_COMPARISON_FRAGMENTS, MAX_SECTION_FILTER_CHARS, type OutlineSide,
  type OutlineSection, type OutlineHeading } from './pdfChatStructure';

const cache = new WeakMap<Corpus, OutlineSide>();
export const COLLECTION_OUTLINE_PAGE_SIZE = 12;
export const COLLECTION_SECTION_PAGE_SIZE = 16;
export type CollectionSection = { documentId: string; key: string; section: OutlineSection };
export type CollectionOutlineSide = { documentId: string; outline: OutlineSide; sections: CollectionSection[] };
export type CollectionOutlineFilter = { keyword: string; kind: OutlineHeading['kind'] | 'all'; sharedOnly: boolean };
export type CollectionOutlineRow = CollectionSection & { counterpartDocuments: string[]; repeatedHere: number };
function invalid(): never { throw new Error('Invalid collection section selection.'); }

export function collectionOutline(documents: readonly CollectionDocument[], selection: readonly string[]): CollectionOutlineSide[] {
  return selectedCollectionDocuments(documents, selection).map(doc => {
    let outline = cache.get(doc.corpus);
    if (!outline) {
      outline = buildOutline({ original: doc.corpus }).original!;
      cache.set(doc.corpus, outline);
    }
    return { documentId: doc.id, outline, sections: outline.sections.map(section => ({
      documentId: doc.id, key: doc.id + ':' + section.id, section,
    })) };
  });
}
export function filterCollectionOutline(sides: readonly CollectionOutlineSide[], filter: CollectionOutlineFilter): CollectionOutlineRow[] {
  if (!filter || typeof filter.keyword !== 'string' || filter.keyword.length > MAX_SECTION_FILTER_CHARS ||
      !['all','reference','numbered','named'].includes(filter.kind) || typeof filter.sharedOnly !== 'boolean') invalid();
  const groups = new Map<string, Map<string, number>>();
  for (const side of sides) for (const row of side.sections) {
    const key = row.section.heading.key;
    const counts = groups.get(key) ?? new Map<string, number>();
    counts.set(side.documentId, (counts.get(side.documentId) ?? 0) + 1);
    groups.set(key, counts);
  }
  const query = filter.keyword.trim().toLowerCase();
  return sides.flatMap(side => side.sections.flatMap(row => {
    const counts = groups.get(row.section.heading.key)!;
    const counterpartDocuments = sides.filter(other => other.documentId !== row.documentId && counts.has(other.documentId))
      .map(other => other.documentId);
    if (filter.kind !== 'all' && row.section.heading.kind !== filter.kind ||
        query && !row.section.source.text.toLowerCase().includes(query) ||
        filter.sharedOnly && !counterpartDocuments.length) return [];
    return [{ ...row, counterpartDocuments, repeatedHere: counts.get(row.documentId)! }];
  }));
}
export function collectionOutlinePage<T>(rows: readonly T[], page: number, size = COLLECTION_OUTLINE_PAGE_SIZE) {
  if (![COLLECTION_OUTLINE_PAGE_SIZE,COLLECTION_SECTION_PAGE_SIZE].includes(size)) invalid();
  const pages = Math.max(1,Math.ceil(rows.length/size));
  if (!Number.isSafeInteger(page)||page<1||page>pages) invalid();
  const start=(page-1)*size, items=rows.slice(start,start+size);
  return {items,pages,first:items.length?start+1:0,last:start+items.length};
}
export function findCollectionSection(documents: readonly CollectionDocument[], documentId: string, key: string): CollectionSection {
  const side = collectionOutline(documents,[documentId])[0];
  const row = side.sections.find(item=>item.key===key);
  if (!row) invalid();
  return row;
}
export function collectionSectionFragments(documents: readonly CollectionDocument[], documentId: string,
  key: string, keyword: string): Passage[] {
  const row = findCollectionSection(documents,documentId,key);
  return searchSectionFragments(row.section,keyword);
}
export function collectionSectionSource(documents: readonly CollectionDocument[], documentId: string, key: string,
  source: Passage): Passage {
  const row = findCollectionSection(documents,documentId,key);
  if (source!==row.section.source&&!row.section.fragments.includes(source)) invalid();
  return collectionCitation(documents,documentId,source).source;
}
export type SectionAlignmentRow =
  | {kind:'same';left:Passage;right:Passage}
  | {kind:'left_only';left:Passage}
  | {kind:'right_only';right:Passage};
export type CollectionSectionAlignment = {
  left:CollectionSection;right:CollectionSection;rows:SectionAlignmentRow[];
  matched:number;leftUnpaired:number;rightUnpaired:number;repeatedText:boolean;coverageLimited:boolean;
};
/** Compare explicitly selected sections with the same candidate heading
 * key. Alignment is exact sequence matching, not semantic diff or
 * identification of revisions. Never infer a correspondence from title alone. */
export function alignCollectionSections(documents:readonly CollectionDocument[], leftId:string,leftKey:string,
  rightId:string,rightKey:string):CollectionSectionAlignment {
  if(leftId===rightId)invalid();
  const left=findCollectionSection(documents,leftId,leftKey),right=findCollectionSection(documents,rightId,rightKey);
  if(left.section.heading.key!==right.section.heading.key)invalid();
  const a=[left.section.source,...left.section.fragments],b=[right.section.source,...right.section.fragments];
  if(a.length>MAX_SECTION_COMPARISON_FRAGMENTS||b.length>MAX_SECTION_COMPARISON_FRAGMENTS||
      [...a,...b].reduce((total,row)=>total+row.text.length,0)>MAX_SECTION_COMPARISON_CHARS)
    throw new Error('Selected collection sections exceed the bounded alignment budget.');
  const width=b.length+1,dp=new Uint16Array((a.length+1)*width);
  for(let i=a.length-1;i>=0;i--)for(let j=b.length-1;j>=0;j--)
    dp[i*width+j]=a[i].text===b[j].text?1+dp[(i+1)*width+j+1]:
      Math.max(dp[(i+1)*width+j],dp[i*width+j+1]);
  let i=0,j=0,matched=0;
  const rows:SectionAlignmentRow[]=[];
  while(i<a.length||j<b.length){
    if(i<a.length&&j<b.length&&a[i].text===b[j].text){rows.push({kind:'same',left:a[i++],right:b[j++]});matched++;}
    else if(i<a.length&&(j>=b.length||dp[(i+1)*width+j]>=dp[i*width+j+1]))rows.push({kind:'left_only',left:a[i++]});
    else rows.push({kind:'right_only',right:b[j++]});
  }
  return {left,right,rows,matched,leftUnpaired:a.length-matched,rightUnpaired:b.length-matched,
    repeatedText:new Set(a.map(row=>row.text)).size!==a.length||new Set(b.map(row=>row.text)).size!==b.length,
    coverageLimited:collectionOutline(documents,[leftId,rightId]).some(side=>side.outline.limited)||
      [left.section,right.section].some(section=>section.ordinalGaps>0||section.uncertainPages.length>0)};
}
