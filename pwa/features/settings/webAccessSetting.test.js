import test from 'node:test';
import assert from 'node:assert/strict';
import { createWebAccessSetting } from './webAccessSetting.js';
function fixture(api){const elements=new Map(['web-access-toggle','web-access-fallback','web-access-status'].map(id=>[id,{checked:false,disabled:false,textContent:'',setAttribute(){},addEventListener(){},removeEventListener(){}}]));
 return {elements,view:createWebAccessSetting({apiClient:api,documentLike:{querySelector:s=>elements.get(s.slice(1))}})};}
test('web settings only load metadata; errors retain confirmed values and allow retry',async()=>{
 const calls=[];let fail=true; const f=fixture({get:async path=>{calls.push(path);return{enabled:false,allowDegoogFallback:false};},patch:async(path,body)=>{calls.push(body);if(fail)throw Error('private raw error');return{enabled:body.enabled,allowDegoogFallback:false};}});
 assert.equal(f.elements.get('web-access-toggle').disabled,true);await f.view.refresh();assert.equal(f.elements.get('web-access-toggle').checked,false);
 await f.view.set('enabled',true);assert.equal(f.elements.get('web-access-toggle').checked,false);assert.match(f.elements.get('web-access-status').textContent,/未保存/);
 fail=false;await f.view.set('enabled',true);assert.equal(f.elements.get('web-access-toggle').checked,true);assert.equal(f.elements.get('web-access-fallback').disabled,false);
 assert.equal(calls[0],'/api/web-access/settings');assert.ok(!JSON.stringify(f.elements.get('web-access-status')).includes('private raw'));
});
test('pending save does not claim enabled or issue another write',async()=>{
 let finish;let writes=0;const f=fixture({get:async()=>({enabled:false}),patch:()=>{writes++;return new Promise(r=>{finish=r;});}});
 await f.view.refresh();const saving=f.view.set('enabled',true);await f.view.set('enabled',true);
 assert.equal(f.elements.get('web-access-toggle').checked,false);assert.equal(writes,1);finish({enabled:true});await saving;assert.equal(f.elements.get('web-access-toggle').checked,true);
});
