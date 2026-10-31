import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import express from 'express';
import { createVirtualPersonRuntimeComposition } from '../virtual-person/createVirtualPersonRuntimeComposition.js';
import { sanitizeTraceValue } from '../sessionTraceStore.js';
import { WebAccessPolicy } from './policy.js';
import { WebAccessService } from './WebAccessService.js';
import { registerWebAccessRoutes } from '../http/routes/webAccessRoutes.js';
import { requireLocalHost, requireJsonForStateChange } from '../http/requestBoundary.js';
import { createPublicTransport } from './transport.js';
import { extractPage } from './extract.js';

const state=()=>{const data=new Map();return{getPref:k=>data.get(k),setPref:(k,v)=>data.set(k,v)};};
const call=(name,args,id='web_call')=>({id,type:'function',function:{name,arguments:JSON.stringify(args)}});

test('production composition: all ordinary identities get web tools, live context gets result, disk does not',async()=>{
 const root=mkdtempSync(join(tmpdir(),'lunara-web-composition-'));const policy=new WebAccessPolicy(state());policy.update({enabled:true});
 const query='PRIVATE_QUERY_SENTINEL';const body='PRIVATE_PAGE_SENTINEL';let requests=0;let models=0;const traces=[];
 const service=new WebAccessService({policy,resolve:async()=>[{address:'93.184.216.34',family:4}],transport:async()=>{
  requests++;return{status:200,headers:{},text:JSON.stringify({result:{content:[{type:'text',text:JSON.stringify({results:[{title:'Release notes',url:'https://example.org/article',text:body}]})}]}})};
 }});
 const c=createVirtualPersonRuntimeComposition({dbPath:join(root,'state.db'),webAccess:service,
  publish(){},queueService:{snapshot:()=>({}),publishSnapshot(){}},playbackRuntime:{snapshot:()=>({phase:'playing',version:1})},
  sessionTrace:{record:(_ctx,event)=>traces.push(sanitizeTraceValue(event))},
  chat:async(messages,tools,options)=>{models++;
   assert.equal(options.traceContent,false);
   assert.ok(tools.some(tool=>tool.function.name==='web_search'));
   if(models===1)return{message:{role:'assistant',content:'',tool_calls:[call('web_search',{query})]}};
   assert.ok(JSON.stringify(messages).includes(body),'live loop retains evidence');
   return{message:{role:'assistant',content:'据搜索摘要，来源提到了版本信息。 https://fabricated.example/fake'}};
  },logger:{warn(){},error(){}}});
 try{
  c.runtime.initialize();
  for(const entity of [{id:'lunara',kind:'root'},{id:'mio',kind:'radiohost'}]){
   assert.ok(c.runtime.capabilityResolver(entity,{musicOwnerId:'other'}).includes('web.read'));
  }
  for(const capability of ['presence.ambient','presence','narration','reflection'])
   assert.ok(!c.toolRegistry.definitions({capabilities:[capability]}).some(tool=>['web_search','fetch_content'].includes(tool.function.name)));
  const response=await c.runtime.handleTurn({sessionId:'web-room',requestId:'web-request',userText:'请查公开的 Node.js 发布消息',speak:false});
  const item=response.responses?.[0] || response;assert.equal(item.ok,true);assert.equal(item.webSources.length,1);assert.equal(requests,1);
  assert.equal(item.webSources[0].url,'https://example.org/article');assert.ok(!JSON.stringify(item.webSources).includes('fabricated'));
  const turns=c.conversationStore.listTurns('web-room',{limit:100,includeInternal:true});
  const rows=c.conversationStore.db.prepare('SELECT message_json FROM conversation_turns WHERE session_id=?').all('web-room');
  const disk=JSON.stringify(rows);assert.ok(!disk.includes(query));assert.ok(!disk.includes(body));
  assert.ok(turns.length>0);assert.ok(!JSON.stringify(traces).includes(query));assert.ok(!JSON.stringify(traces).includes(body));
  assert.equal(c.runtime.capabilityResolver({id:'lunara',kind:'root'},{musicOwnerId:'other'}).includes('web.read'),true);
  policy.update({enabled:false});assert.equal(c.runtime.capabilityResolver({id:'lunara',kind:'root'},{musicOwnerId:'other'}).includes('web.read'),false);
 }finally{service.dispose();c.runtime.shutdown();c.conversationStore.close();c.registry.close();rmSync(root,{recursive:true,force:true});}
});

test('real local HTTP settings obey JSON/Host/Origin, do not fetch, persist independently',async()=>{
 const policy=new WebAccessPolicy(state());const app=express();app.use(requireLocalHost());app.use(requireJsonForStateChange());app.use(express.json());
 registerWebAccessRoutes(app,{webAccess:{policy}});app.use((error,_req,res,_next)=>res.status(error.statusCode||500).json({ok:false}));
 const server=app.listen(0,'127.0.0.1');await once(server,'listening');const url=`http://127.0.0.1:${server.address().port}/api/web-access/settings`;
 try{
  assert.equal((await(await fetch(url)).json()).enabled,false);
  assert.equal((await fetch(url,{method:'PATCH',body:'enabled=true',headers:{'content-type':'text/plain'}})).status,415);
  assert.equal((await fetch(url,{method:'PATCH',body:'{"enabled":true}',headers:{'content-type':'application/json',origin:'https://evil.example'}})).status,403);
  const badHostStatus=await new Promise((resolve,reject)=>{const req=http.get(url,{headers:{host:'evil.example'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);});
  assert.equal(badHostStatus,403);
  assert.equal((await fetch(url,{method:'PATCH',body:'{"enabled":true,"endpoint":"https://evil.example"}',headers:{'content-type':'application/json'}})).status,400);
  assert.equal((await(await fetch(url,{method:'PATCH',body:'{"enabled":true}',headers:{'content-type':'application/json'}})).json()).enabled,true);
 }finally{await new Promise(resolve=>server.close(resolve));}
});

test('real Node request socket uses the supplied pin without doing a second DNS lookup',async()=>{
 // This test drives Node's real HTTP request and socket at a loopback fixture.
 // Only the network boundary factory is replaced; production URL validation
 // still checks a public DNS answer and supplies it to this boundary.
 const observed=[];const server=http.createServer((req,res)=>{observed.push(req.headers);res.end('fixture response');});
 server.listen(0,'127.0.0.1');await once(server,'listening');let dns=0,pinned;
 const transport=createPublicTransport({resolve:async()=>{dns++;return[{address:'93.184.216.34',family:4}];},request:(url,options,callback)=>{
  options.lookup(url.hostname,{all:true},(_error,addresses)=>{pinned=addresses;});
  // Test-only connector mapping, not an allow-private flag in production code.
  return http.request({host:'127.0.0.1',port:server.address().port,path:url.pathname,method:options.method,signal:options.signal,
   agent:options.agent,headers:{...options.headers,Host:url.host}},callback);
 }});
 try{const result=await transport('http://example.org/article',{signal:AbortSignal.timeout(1000)});
  assert.equal(result.text,'fixture response');assert.equal(dns,1);assert.deepEqual(pinned,[{address:'93.184.216.34',family:4}]);
  assert.equal(observed[0].host,'example.org');assert.equal(observed[0].cookie,undefined);
 }finally{await new Promise(resolve=>server.close(resolve));}
});

test('offline HTML worker removes scripts/resources and fails closed on login/PDF',async()=>{
 const response={status:200,url:'https://example.org/article',headers:{'content-type':'text/html'},text:'<!doctype html><html><head><title>Release notes</title></head><body><main><article><h1>Release notes</h1><p>'+('A public release has clear documentation. '.repeat(15))+'</p><script>FETCH_PRIVATE_SENTINEL</script><img src="http://127.0.0.1/private"></article></main></body></html>'};
 const page=await extractPage(response,AbortSignal.timeout(2000));assert.match(page.text,/clear documentation/);assert.ok(!page.text.includes('FETCH_PRIVATE_SENTINEL'));
 await assert.rejects(extractPage({...response,text:'<html><body><input type="password"></body></html>'},AbortSignal.timeout(2000)),{code:'WEB_CONTENT_UNREADABLE'});
 await assert.rejects(extractPage({...response,headers:{'content-type':'application/pdf'}},AbortSignal.timeout(2000)),{code:'WEB_CONTENT_UNSUPPORTED'});
});
