/** Native PDF.js geometry is a line-location hint, not glyph-level proof.
 * Replay the exact fragment and its extraction coordinates on the current
 * rendered page before presenting any location marker. */
import type {Passage,TextPosition} from './pdfChatCore';
import {NativePageAssembler,MAX_NATIVE_DOCUMENT_CHARS,MAX_NATIVE_DOCUMENT_PASSAGES,MAX_NATIVE_PAGE_ITEMS} from './pdfChatNativeText';

export const NATIVE_LOCATOR_TIMEOUT_MS=5000;
export type NativeLocation={left:number;top:number;width:number;height:number};
export type NativeLocationResult=
  | {status:'located';location:NativeLocation}
  | {status:'unavailable';reason:'geometry'|'page'|'fragment'|'budget'|'transform'};
type Viewport={width:number;height:number;convertToViewportPoint:(x:number,y:number)=>number[]};
type NativeTextStream={items:unknown[]};
type NativeReader={
  read:()=>Promise<{done:boolean;value?:NativeTextStream}>;
  cancel:()=>Promise<unknown>;
  releaseLock:()=>void;
};
type NativePage={pageNumber:number;streamTextContent:()=>{getReader:()=>NativeReader}};
function unavailable(reason:Extract<NativeLocationResult,{status:'unavailable'}>['reason']):NativeLocationResult{
  return {status:'unavailable',reason};
}
function validPosition(position:TextPosition|undefined):position is TextPosition{
  return !!position&&[position.x0,position.x1,position.y,position.height].every(value=>
    Number.isFinite(value)&&Math.abs(value)<=1e9)&&position.x1>position.x0&&position.height>=1;
}
function samePosition(left:TextPosition,right:TextPosition){
  // The same PDF.js version and assembler should produce identical numbers.
  // Do not repair or approximate a mismatch in persisted native coordinates.
  return left.x0===right.x0&&left.x1===right.x1&&left.y===right.y&&left.height===right.height;
}
export function nativeLocationForViewport(position:TextPosition,viewport:Viewport):NativeLocationResult{
  if(!validPosition(position)||!Number.isFinite(viewport.width)||!Number.isFinite(viewport.height)||
      viewport.width<=0||viewport.height<=0)return unavailable('geometry');
  const {x0,x1,y,height}=position;
  // A baseline and reported height do not specify ascent/descent. Use a
  // conservative line-area cue, explicitly not a bounding box of glyphs.
  const points=[[x0,y-height*.3],[x1,y-height*.3],[x0,y+height],[x1,y+height]]
    .map(([x,y])=>viewport.convertToViewportPoint(x,y));
  if(points.some(point=>point.length!==2||!point.every(Number.isFinite)))return unavailable('transform');
  const xs=points.map(point=>point[0]),ys=points.map(point=>point[1]);
  const left=Math.min(...xs),right=Math.max(...xs),top=Math.min(...ys),bottom=Math.max(...ys);
  if(right<=left||bottom<=top)return unavailable('transform');
  // Clip only slight ascent/descent extension near a page edge. Reject
  // locations substantially outside the actual rendered viewport.
  const tolerance=Math.max(2,Math.min(12,Math.max(right-left,bottom-top)*.05));
  if(left< -tolerance||top< -tolerance||right>viewport.width+tolerance||
      bottom>viewport.height+tolerance)return unavailable('transform');
  const a=Math.max(0,left),b=Math.max(0,top),c=Math.min(viewport.width,right),d=Math.min(viewport.height,bottom);
  if(c<=a||d<=b)return unavailable('transform');
  return {status:'located',location:{left:100*a/viewport.width,top:100*b/viewport.height,
    width:100*(c-a)/viewport.width,height:100*(d-b)/viewport.height}};
}
/** Independently stream the physical page using the exact native assembler.
 * Abort cancellation is separate from the renderer's life cycle. */
export async function locateNativeFragment(page:NativePage,viewport:Viewport,source:Passage,
  signal:AbortSignal):Promise<NativeLocationResult>{
  signal.throwIfAborted();
  if(source.page!==page.pageNumber||source.page<1||source.page>80)return unavailable('page');
  if(!validPosition(source.position))return unavailable('geometry');
  const assembler=new NativePageAssembler(source.role,source.page,{
    chars:MAX_NATIVE_DOCUMENT_CHARS,passages:MAX_NATIVE_DOCUMENT_PASSAGES,items:MAX_NATIVE_PAGE_ITEMS,
  });
  const reader=page.streamTextContent().getReader();
  let timedOut=false,complete=false;
  let cancelPromise:Promise<unknown>|undefined;
  const cancel=()=>{
    if(!cancelPromise)cancelPromise=reader.cancel().catch(()=>{});
    return cancelPromise;
  };
  const onAbort=()=>{void cancel();};
  signal.addEventListener('abort',onAbort,{once:true});
  const timer=setTimeout(()=>{timedOut=true;void cancel();},NATIVE_LOCATOR_TIMEOUT_MS);
  try{
    reading:for(;;){
      signal.throwIfAborted();
      if(timedOut)break;
      const result=await reader.read();
      signal.throwIfAborted();
      if(timedOut)break;
      if(result.done){complete=true;break;}
      if(!result.value||!Array.isArray(result.value.items))return unavailable('fragment');
      for(const item of result.value.items){
        if(!assembler.push(item))break reading;
      }
    }
    signal.throwIfAborted();
    const fresh=assembler.finish(complete);
    if(timedOut)return unavailable('budget');
    const match=fresh.passages.find(row=>row.ordinal===source.ordinal);
    if(!match)return unavailable(fresh.limited?'budget':'fragment');
    if(match.text!==source.text||!validPosition(match.position)||!samePosition(match.position,source.position))
      return unavailable('fragment');
    return nativeLocationForViewport(match.position,viewport);
  }catch(error){
    if(signal.aborted)throw error;
    return unavailable(timedOut?'budget':'fragment');
  }finally{
    clearTimeout(timer);
    signal.removeEventListener('abort',onAbort);
    await cancel();
    reader.releaseLock();
  }
}
