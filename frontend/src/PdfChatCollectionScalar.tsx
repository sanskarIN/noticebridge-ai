import {useMemo,useState} from 'react';
import type {CollectionDocument,CollectionTurn} from './pdfChatCollection';
import type {Passage} from './pdfChatCore';
import {scalarFieldKind} from './pdfChatScalarComparison';
import {collectionScalarAnalysis,explainScalarPair,inspectScalarSource,type ScalarUnavailable} from './pdfChatCollectionScalar';
import type {FieldId} from './pdfChatOverview';
const reason:Record<ScalarUnavailable,string>={
  coverage:'Native coverage is incomplete or unavailable.',
  missing_value:'No recognized printed value was found.',
  multiple_values:'Multiple distinct printed values were found.',
  possible_conditions:'Additional matching or nearby text may contain qualifications.',
  unrecognized_value:'Printed value is not a supported exact amount or calendar date.',
};
export default function PdfChatCollectionScalar({documents,turn,partIndex,field,names,onInspect}:{
  documents:readonly CollectionDocument[];turn:CollectionTurn;partIndex:number;field:FieldId;
  names:Map<string,string>;onInspect:(id:string,source:Passage,target:HTMLElement)=>void;
}){
  const [open,setOpen]=useState(false);
  const result=useMemo(()=>open?collectionScalarAnalysis(documents,turn,partIndex):null,[open,documents,turn,partIndex]);
  if(turn.step.documentIds.length<2||!scalarFieldKind(field))return null;
  return <details className="chat-collection-inspection" aria-label="Guarded printed scalar comparison" onToggle={event=>setOpen(event.currentTarget.open)}>
    <summary>Compare exact printed amounts or calendar dates</summary>
    <p className="chat-note">Arithmetic is limited to supported unambiguous literal values. Document order is the saved selection
      order, not a chronology or authority ranking. Even a reproducible difference does not establish a change in rules.</p>
    {result&&<>
      <div className="chat-collection-matrix">
        {result.sides.map(side=><article className="chat-overview-side" key={side.documentId}>
          <h5>{names.get(side.documentId)}</h5>
          {side.status==='available'?<div className="chat-citation">
            <p>Printed value: {side.source.value}</p>
            <button type="button" className="chat-button" onClick={event=>onInspect(side.documentId,
              inspectScalarSource(documents,result,side,side.source),event.currentTarget)}>Inspect scalar source {side.source.source.page}:{side.source.source.ordinal}</button>
          </div>:<>
            <p>{reason[side.reason]} Arithmetic withheld for this PDF.</p>
            {side.values.map(value=><div className="chat-citation" key={value.source.page+':'+value.source.ordinal}>
              <p>{value.label}: {value.value}</p>
              <button type="button" className="chat-button" onClick={event=>onInspect(side.documentId,
                inspectScalarSource(documents,result,side,value),event.currentTarget)}>Inspect withheld scalar candidate {value.source.page}:{value.source.ordinal}</button>
            </div>)}
          </>}
        </article>)}
      </div>
      <h5>Pairwise arithmetic in selection order</h5>
      {result.pairs.map(pair=><article className="chat-citation" key={pair.left+':'+pair.right}>
        <p><strong>{names.get(pair.left)} / {names.get(pair.right)}</strong></p><p>{explainScalarPair(pair)}</p>
      </article>)}
      <p className="chat-muted">No exchange rate, inclusive day count, timezone, deadline extension or applicant-specific result is inferred.</p>
    </>}
  </details>;
}
