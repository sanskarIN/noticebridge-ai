/** Stable navigation metadata for the local collection workspace.
 * Navigation only changes visibility/focus, never document scope or answers. */
export type CollectionToolGroup='ask'|'inspect'|'review'|'exchange'|'experiments';
export type CollectionToolId=
  'sources'|'question'|'batch'|'scoped-plan'|'history'|'models'|'results'|'fields'|'literal'|'boolean-search'|'references'|
  'dates'|'requirements'|'outline'|'tables'|'table-comparison'|'overlap'|'pages'|'preview'|'review'|'review-queue'|'workspace'|
  'ocr'|'evaluation'|'packet'|'replay'|'exchange';
export type CollectionToolState={documents:number;selected:number;turns:number;preview:boolean;busy:boolean};
export type CollectionTool={
  id:CollectionToolId;group:CollectionToolGroup;title:string;description:string;keywords:string[];
  requirement:'none'|'documents'|'selection'|'two-selected'|'turns'|'preview';blockedDuringIndexing:boolean;
};
export const COLLECTION_TOOL_SEARCH_LIMIT=100;
export const COLLECTION_TOOL_GROUPS:Record<CollectionToolGroup,string>={
  ask:'Ask and browse questions',inspect:'Inspect documents',review:'Review evidence',
  exchange:'Save and replay work',experiments:'Optional AI and evaluation',
};
export const COLLECTION_TOOLS:readonly CollectionTool[]=[
  {id:'sources',group:'ask',title:'Attached PDFs',description:'Add, select or remove local documents.',
    keywords:['upload','file','sha256','fingerprint'],requirement:'none',blockedDuringIndexing:false},
  {id:'question',group:'ask',title:'Ask a question',description:'Search selected PDFs independently.',
    keywords:['chat','query','answer','prompt'],requirement:'none',blockedDuringIndexing:false},
  {id:'batch',group:'ask',title:'Batch questions',description:'Stage multiple independent questions before appending.',
    keywords:['multiple','bulk','questions'],requirement:'documents',blockedDuringIndexing:true},
  {id:'scoped-plan',group:'ask',title:'Independently scoped question plan',description:'Prepare mixed document selections and context options per question.',
    keywords:['batch','plan','scope','multiple'],requirement:'documents',blockedDuringIndexing:true},
  {id:'history',group:'ask',title:'Question history',description:'Browse, edit or prepare a follow-up.',
    keywords:['conversation','previous','followup'],requirement:'turns',blockedDuringIndexing:false},
  {id:'results',group:'ask',title:'Current question evidence',description:'Inspect citations from the saved question.',
    keywords:['result','quote','answer','citation'],requirement:'turns',blockedDuringIndexing:false},
  {id:'fields',group:'inspect',title:'Printed fields',description:'Compare literal field candidates independently.',
    keywords:['fee','eligibility','deadline','amount','matrix'],requirement:'documents',blockedDuringIndexing:true},
  {id:'literal',group:'inspect',title:'Literal text search',description:'Find explicit text and reference candidates.',
    keywords:['find','reference','keyword','clause','search'],requirement:'documents',blockedDuringIndexing:true},
  {id:'boolean-search',group:'inspect',title:'Boolean phrase search',description:'Combine quoted literal phrases with explicit AND, OR and NOT.',
    keywords:['boolean','phrase','exclude','operator','search'],requirement:'selection',blockedDuringIndexing:true},
  {id:'references',group:'inspect',title:'Printed reference index',description:'Inspect leading clause candidates and inline mentions.',
    keywords:['clause','section','annexure','reference','trail'],requirement:'selection',blockedDuringIndexing:true},
  {id:'dates',group:'inspect',title:'Printed dates and times',description:'Inspect indexed date and time candidates.',
    keywords:['timeline','schedule','deadline','calendar'],requirement:'documents',blockedDuringIndexing:true},
  {id:'requirements',group:'inspect',title:'Requirement wording',description:'Inspect mandatory, prohibited and exception cues.',
    keywords:['rule','must','eligibility','condition'],requirement:'documents',blockedDuringIndexing:true},
  {id:'outline',group:'inspect',title:'Document structure',description:'Browse heading candidates and align selected sections.',
    keywords:['section','heading','outline','alignment'],requirement:'documents',blockedDuringIndexing:true},
  {id:'tables',group:'inspect',title:'Table candidates',description:'Inspect native rows and cell candidates.',
    keywords:['column','row','tabular','table'],requirement:'documents',blockedDuringIndexing:true},
  {id:'overlap',group:'inspect',title:'Literal text overlap',description:'Find exact repeated native fragments across selected PDFs.',
    keywords:['duplicate','shared','exclusive','identical','compare'],requirement:'two-selected',blockedDuringIndexing:true},
  {id:'table-comparison',group:'inspect',title:'Compare selected tables',description:'Align category and field cells from explicitly selected independent tables.',
    keywords:['table','compare','matrix','cell','category'],requirement:'two-selected',blockedDuringIndexing:true},
  {id:'pages',group:'inspect',title:'Page coverage',description:'Open physical pages and inspect native coverage.',
    keywords:['missing','page','native','coverage','viewer'],requirement:'documents',blockedDuringIndexing:true},
  {id:'preview',group:'review',title:'Open source inspection',description:'Return to the rendered page and selected quotation.',
    keywords:['pdf','preview','source','citation'],requirement:'preview',blockedDuringIndexing:false},
  {id:'review-queue',group:'review',title:'Question review queue',description:'Review unanswered, ambiguous and incomplete saved question searches.',
    keywords:['gap','unanswered','ambiguity','coverage','followup'],requirement:'turns',blockedDuringIndexing:true},
  {id:'review',group:'review',title:'Review notebook',description:'Manage personal annotations on saved native fragments.',
    keywords:['note','pin','saved','evidence'],requirement:'documents',blockedDuringIndexing:true},
  {id:'workspace',group:'exchange',title:'Editable workspace',description:'Export or restore questions and review annotations.',
    keywords:['restore','import','export','json'],requirement:'documents',blockedDuringIndexing:true},
  {id:'packet',group:'exchange',title:'Evidence review packet',description:'Export a canonical review or static reading copy.',
    keywords:['html','print','report','packet','download'],requirement:'documents',blockedDuringIndexing:true},
  {id:'replay',group:'exchange',title:'Independent source replay',description:'Check native snapshots against actual PDF bytes.',
    keywords:['verify','hash','snapshot','extraction'],requirement:'none',blockedDuringIndexing:true},
  {id:'exchange',group:'exchange',title:'Question plan and evidence export',description:'Replay saved standalone question steps.',
    keywords:['report','json','plan','verify'],requirement:'documents',blockedDuringIndexing:false},
  {id:'models',group:'experiments',title:'Independent local AI proposals',description:'Prepare or review scoped semantic model requests.',
    keywords:['embedding','extractive','ollama','preflight','model'],requirement:'turns',blockedDuringIndexing:false},
  {id:'ocr',group:'experiments',title:'Scanned PDF review',description:'Review optional OCR separately from native answers.',
    keywords:['image','scan','transcription','tesseract'],requirement:'documents',blockedDuringIndexing:true},
  {id:'evaluation',group:'experiments',title:'Retrieval evaluation',description:'Measure labelled evidence retrieval and regressions.',
    keywords:['precision','recall','benchmark','regression','labels'],requirement:'documents',blockedDuringIndexing:true},
];
const catalog=new Map(COLLECTION_TOOLS.map(tool=>[tool.id,tool]));
export function collectionToolAnchor(id:CollectionToolId):string{
  if(!catalog.has(id))throw new Error('Unknown collection workspace destination.');
  return 'collection-tool-'+id;
}
function words(value:string):string[]{
  return value.normalize('NFKC').toLowerCase().match(/[a-z0-9]+/g)??[];
}
export function collectionToolAvailability(tool:CollectionTool,state:CollectionToolState):string|null{
  if(tool.blockedDuringIndexing&&state.busy)return 'Available after indexing finishes.';
  if(tool.requirement==='documents'&&!state.documents)return 'Attach a PDF first.';
  if(tool.requirement==='selection'&&!state.selected)return 'Select at least one attached PDF.';
  if(tool.requirement==='two-selected'&&state.selected<2)return 'Select at least two attached PDFs.';
  if(tool.requirement==='turns'&&!state.turns)return 'Ask a collection question first.';
  if(tool.requirement==='preview'&&!state.preview)return 'Open a source or physical page first.';
  return null;
}
export function collectionToolSearch(query:string,group:CollectionToolGroup|'all',state:CollectionToolState,availableOnly=false){
  if(typeof query!=='string'||query.length>COLLECTION_TOOL_SEARCH_LIMIT||
      (group!=='all'&&!Object.hasOwn(COLLECTION_TOOL_GROUPS,group)))throw new Error('Invalid collection tool filter.');
  const terms=[...new Set(words(query))];
  const rows=COLLECTION_TOOLS.flatMap((tool,index)=>{
    if(group!=='all'&&group!==tool.group)return [];
    const unavailable=collectionToolAvailability(tool,state);
    if(availableOnly&&unavailable)return [];
    const title=words(tool.title),tags=tool.keywords.flatMap(words),detail=words(tool.description);
    let score=0;
    for(const term of terms){
      const match=(values:string[])=>values.some(word=>word.startsWith(term));
      const value=title.includes(term)?10:tags.includes(term)?7:match(title)?5:match(tags)?3:match(detail)?1:0;
      if(!value)return [];
      score+=value;
    }
    return [{tool,unavailable,score,index}];
  });
  return rows.sort((a,b)=>b.score-a.score||a.index-b.index);
}
