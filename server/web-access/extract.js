import { Worker } from 'node:worker_threads';
import { abortable } from './safety.js';
import { fail } from './errors.js';
export async function extractPage(response,signal) {
  if (response.status===401 || response.status===403 || response.status===202) fail('WEB_CONTENT_UNREADABLE');
  if (response.status<200 || response.status>=300) fail('WEB_UNAVAILABLE');
  const type=String(response.headers['content-type'] || '').split(';')[0].toLowerCase();
  if (response.headers['content-disposition']?.toLowerCase().includes('attachment')) fail('WEB_CONTENT_UNSUPPORTED');
  if (type==='text/plain') {
    if (!response.text.trim()) fail('WEB_CONTENT_UNREADABLE');
    return {title:new URL(response.url).hostname,text:response.text};
  }
  if(type!=='text/html') fail('WEB_CONTENT_UNSUPPORTED');
  const worker=new Worker(new URL('./extractWorker.js',import.meta.url),{execArgv:[],workerData:{html:response.text},
    resourceLimits:{maxOldGenerationSizeMb:64,maxYoungGenerationSizeMb:16}});
  try {
    const result=await abortable(new Promise((resolve,reject)=>{
      worker.once('message',resolve);worker.once('error',()=>reject(new Error('page extraction unavailable')));
      worker.once('exit',()=>reject(new Error('page extraction stopped')));
    }),signal);
    if(result.unavailable) fail('WEB_CONTENT_UNREADABLE'); return result;
  } finally { await worker.terminate(); }
}
