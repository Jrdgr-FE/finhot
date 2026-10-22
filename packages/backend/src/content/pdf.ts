import { Worker } from "node:worker_threads";

/** Bound CPU time and parser memory separately from the main worker. Never execute document scripts. */
export function extractPdfFragment(data: Uint8Array):Promise<{text:string;scope:string}> {
  if(data.byteLength>6*1024*1024)return Promise.reject(new Error('PDF exceeds 6 MB limit'));
  return new Promise((resolve,reject)=>{
    const worker=new Worker(new URL('./pdf-worker.ts',import.meta.url),{workerData:data,resourceLimits:{maxOldGenerationSizeMb:128}});
    let received=false;
    const timer=setTimeout(()=>{reject(new Error('PDF extraction timed out'));void worker.terminate();},20000);
    const finish=()=>clearTimeout(timer);
    worker.once('message',value=>{received=true;finish();resolve(value);});
    worker.once('error',error=>{finish();reject(error);});
    worker.once('exit',code=>{finish();if(!received)reject(new Error(`PDF worker exited ${code} before returning text`));});
  });
}
