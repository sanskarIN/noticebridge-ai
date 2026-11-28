/** One explicit checkpoint per browser origin. IndexedDB transactions
 * perform compare-and-swap so another tab cannot silently overwrite work. */
import {validateCheckpoint,checkpointInfo,type CollectionCheckpoint,type CheckpointInfo} from './pdfChatCollectionCheckpoint';
const DATABASE='noticebridge-private-collection-v1';
const STORE='checkpoint';
const KEY='local';
export type CheckpointStore={
  info:()=>Promise<CheckpointInfo|null>;
  load:()=>Promise<CollectionCheckpoint|null>;
  save:(checkpoint:CollectionCheckpoint,expected:string|null,signal:AbortSignal)=>Promise<void>;
  remove:(expected:string,signal:AbortSignal)=>Promise<void>;
};
function failure(){return new Error('Local checkpoint storage is unavailable or changed in another tab.');}
function open(factory:IDBFactory,name:string):Promise<IDBDatabase>{
  return new Promise((resolve,reject)=>{
    let settled=false;
    const request=factory.open(name,1);
    request.onupgradeneeded=()=>{
      if(!request.result.objectStoreNames.contains(STORE))request.result.createObjectStore(STORE);
    };
    request.onblocked=()=>{settled=true;reject(failure());};
    request.onerror=()=>{settled=true;reject(failure());};
    request.onsuccess=()=>{
      const db=request.result;
      if(settled){db.close();return;}
      settled=true;db.onversionchange=()=>db.close();resolve(db);
    };
  });
}
async function read(factory:IDBFactory,name:string):Promise<CollectionCheckpoint|null>{
  const db=await open(factory,name);
  try{
    return await new Promise((resolve,reject)=>{
      const tx=db.transaction(STORE,'readonly'),request=tx.objectStore(STORE).get(KEY);
      tx.onabort=()=>reject(failure());
      tx.onerror=()=>reject(failure());
      tx.oncomplete=()=>{
        try{resolve(request.result===undefined?null:validateCheckpoint(request.result));}
        catch{reject(failure());}
      };
    });
  }finally{db.close();}
}
async function mutate(factory:IDBFactory,name:string,expected:string|null,next:CollectionCheckpoint|null,signal:AbortSignal){
  signal.throwIfAborted();
  const db=await open(factory,name);
  try{
    signal.throwIfAborted();
    await new Promise<void>((resolve,reject)=>{
      const tx=db.transaction(STORE,'readwrite'),store=tx.objectStore(STORE);
      const abort=()=>{try{tx.abort();}catch{/* already complete */}};
      const clean=()=>signal.removeEventListener('abort',abort);
      signal.addEventListener('abort',abort,{once:true});
      tx.onabort=()=>{clean();reject(failure());};
      tx.onerror=()=>{clean();reject(failure());};
      tx.oncomplete=()=>{clean();resolve();};
      const request=store.get(KEY);
      request.onsuccess=()=>{
        try{
          signal.throwIfAborted();
          const current=request.result===undefined?null:validateCheckpoint(request.result);
          if((current?.revision??null)!==expected)throw failure();
          if(next){if(next.revision===expected)throw failure();store.put(next,KEY);}
          else store.delete(KEY);
        }catch{abort();}
      };
      if(signal.aborted)abort();
    });
  }finally{db.close();}
}
export function createCheckpointStore(factory:IDBFactory=globalThis.indexedDB,name=DATABASE):CheckpointStore{
  if(!factory||typeof name!=='string'||!name)throw failure();
  return {
    async info(){const current=await read(factory,name);return current?checkpointInfo(current):null;},
    load:()=>read(factory,name),
    async save(checkpoint,expected,signal){await mutate(factory,name,expected,validateCheckpoint(checkpoint),signal);},
    async remove(expected,signal){if(!expected)throw failure();await mutate(factory,name,expected,null,signal);},
  };
}
