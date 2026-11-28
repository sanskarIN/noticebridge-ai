import {expect,test} from '@playwright/test';
import {COLLECTION_TOOLS,collectionToolAnchor,collectionToolSearch,collectionToolAvailability,
  type CollectionToolState} from '../src/pdfChatCollectionNavigation';
const empty:CollectionToolState={documents:0,selected:0,turns:0,preview:false,busy:false};
const full:CollectionToolState={documents:3,selected:2,turns:1,preview:true,busy:false};
test('workspace catalog has unique stable destinations and explicit availability',()=>{
  expect(new Set(COLLECTION_TOOLS.map(tool=>collectionToolAnchor(tool.id))).size).toBe(COLLECTION_TOOLS.length);
  const available=collectionToolSearch('','all',empty,true).map(row=>row.tool.id);
  expect(available).toEqual(['sources','question','replay']);
  expect(collectionToolSearch('','all',full,true)).toHaveLength(COLLECTION_TOOLS.length);
  expect(()=>collectionToolAnchor('unknown' as never)).toThrow();
});
test('tool search supports group, prefix, multi-term and case-insensitive filters',()=>{
  expect(collectionToolSearch('OCR','all',full)[0].tool.id).toBe('ocr');
  expect(collectionToolSearch('retrieval regress','experiments',full)[0].tool.id).toBe('evaluation');
  expect(collectionToolSearch('timeline','inspect',full)[0].tool.id).toBe('dates');
  expect(collectionToolSearch('ocr','exchange',full)).toEqual([]);
  expect(collectionToolSearch('ＱＵＥＲＹ','all',full)[0].tool.id).toBe('question');
  expect(collectionToolSearch('unrecognizedword','all',full)).toEqual([]);
  expect(()=>collectionToolSearch('x'.repeat(101),'all',full)).toThrow();
});
test('indexing blocks only tools that unmount while indexing',()=>{
  const busy={...full,busy:true};
  const available=collectionToolSearch('','all',busy,true).map(row=>row.tool.id);
  expect(available).toContain('sources');
  expect(available).toContain('results');
  expect(available).not.toContain('ocr');
  expect(collectionToolAvailability(COLLECTION_TOOLS.find(tool=>tool.id==='ocr')!,busy)).toContain('indexing');
});
