import {expect,test} from '@playwright/test';
import {locateNativeFragment,nativeLocationForViewport} from '../src/pdfChatNativeLocator';
import type {Passage} from '../src/pdfChatCore';
const signal=()=>new AbortController().signal;
const source:Passage={role:'original',page:1,ordinal:1,text:'Application fee: INR 500',position:{x0:20,x1:140,y:100,height:10}};
const item={str:source.text,transform:[10,0,0,10,20,100],width:120,height:10,hasEOL:true};
const viewport={width:200,height:200,convertToViewportPoint:(x:number,y:number)=>[x,200-y]};
function page(items:unknown[],pageNumber=1){
  let read=0,cancel=0,release=0;
  return {pageNumber,streamTextContent:()=>({getReader:()=>({
    read:async()=>read++===0?{done:false,value:{items}}:{done:true},
    cancel:async()=>{cancel++;},releaseLock:()=>{release++;},
  })}),counts:()=>({read,cancel,release})};
}
test('native location requires exact ordinal, text and geometry from a fresh page stream',async()=>{
  const p=page([item]);
  const result=await locateNativeFragment(p,viewport,source,signal());
  expect(result.status).toBe('located');
  if(result.status==='located'){
    expect(result.location.left).toBe(10);
    expect(result.location.top).toBe(45);
    expect(result.location.width).toBe(60);
    expect(result.location.height).toBe(6.5);
  }
  expect(p.counts()).toEqual({read:2,cancel:1,release:1});
  for(const changed of [{...source,text:'Different'}, {...source,ordinal:2},
    {...source,position:{...source.position!,x1:141}}]){
    expect(await locateNativeFragment(page([item]),viewport,changed,signal())).toMatchObject({status:'unavailable',reason:'fragment'});
  }
});
test('missing geometry or incorrect physical page does not read page text',async()=>{
  const p=page([item],2);
  expect(await locateNativeFragment(p,viewport,source,signal())).toMatchObject({reason:'page'});
  expect(p.counts().read).toBe(0);
  const a=page([item]);
  expect(await locateNativeFragment(a,viewport,{...source,position:undefined},signal())).toMatchObject({reason:'geometry'});
  expect(a.counts().read).toBe(0);
});
test('viewport mapping handles rotation, scale and translated crop origin',()=>{
  const mapped=nativeLocationForViewport(source.position!,{
    width:400,height:400,convertToViewportPoint:(x,y)=>[(y-10)*2,(x-10)*2],
  });
  expect(mapped).toEqual({status:'located',location:{left:43.5,top:5,width:6.5,height:60}});
  expect(nativeLocationForViewport(source.position!,{...viewport,convertToViewportPoint:()=>[NaN,0]})).toMatchObject({reason:'transform'});
  expect(nativeLocationForViewport({...source.position!,x0:300,x1:400},viewport)).toMatchObject({reason:'transform'});
  expect(nativeLocationForViewport(source.position!,{...viewport,width:0})).toMatchObject({reason:'geometry'});
});
test('unsupported rotated text geometry does not create a line marker',async()=>{
  const p=page([{...item,transform:[0,10,-10,0,20,100]}]);
  expect(await locateNativeFragment(p,viewport,source,signal())).toMatchObject({status:'unavailable'});
});
test('cancellation before or during stream reading never returns a location',async()=>{
  const controller=new AbortController();controller.abort();
  const p=page([item]);
  await expect(locateNativeFragment(p,viewport,source,controller.signal)).rejects.toThrow();
  expect(p.counts().read).toBe(0);
  const active=new AbortController();
  let cancelled=0,released=0;
  const slow={pageNumber:1,streamTextContent:()=>({getReader:()=>({
    read:async()=>{active.abort();return {done:false,value:{items:[item]}};},
    cancel:async()=>{cancelled++;},releaseLock:()=>{released++;},
  })})};
  await expect(locateNativeFragment(slow,viewport,source,active.signal)).rejects.toThrow();
  expect(cancelled).toBe(1);expect(released).toBe(1);
});
