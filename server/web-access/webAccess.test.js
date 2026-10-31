import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { WebAccessPolicy, LIMITS } from './policy.js';
import { normalizeWebUrl, resolvePublicTarget, validateQuery } from './safety.js';
import { createPublicTransport } from './transport.js';
import { parseExa, parseDegoog } from './providers.js';
import { WebAccessService } from './WebAccessService.js';
import { registerWebAccessTools } from './webTools.js';
import { VirtualPersonToolRegistry } from '../virtual-person/VirtualPersonToolRegistry.js';
import { projectWebHistory, redactWebTrace } from './projections.js';
import { createToolOutcome } from '../virtual-person/VirtualPersonTypes.js';
import { AgentLoop } from '../virtual-person/AgentLoop.js';

const stateOf = () => { const data = new Map(); return { getPref: k => data.get(k), setPref: (k,v) => data.set(k,v), data }; };
const context = (groupAction = {}) => ({ sessionId:'room', requestId:'response', roundId:'round', virtualPersonId:'mio',
  groupAction, memberToken:'member1', isCurrent:()=>true, capabilities:['web.read'], signal:new AbortController().signal });
const enabled = () => { const p = new WebAccessPolicy(stateOf()); p.update({enabled:true}); return p; };
const page = { status:200, headers:{'content-type':'text/plain'}, text:'An ordinary public article with relevant information.', url:'https://example.org/article' };
const exa = sources => JSON.stringify({jsonrpc:'2.0',id:1,result:{content:[{type:'text',text:JSON.stringify({results:sources})}]}});
const searchResponse = () => ({status:200,headers:{},text:exa([{title:'Official release',url:'https://example.org/article',text:'Public release notes'}])});
const publicResolve = async () => [{address:'93.184.216.34',family:4}];

test('policy is off by default, writes independently, fails closed and validates strict fields', () => {
  const state=stateOf(); state.setPref('settings','music-settings'); const p=new WebAccessPolicy(state);
  assert.equal(p.snapshot().enabled,false); let changes=0;p.subscribe(()=>changes++);
  assert.throws(()=>p.update({enabled:'true'})); assert.throws(()=>p.update({endpoint:'https://bad.test'}));
  p.update({enabled:true}); assert.equal(p.snapshot().enabled,true); assert.equal(changes,1);
  assert.equal(state.getPref('settings'),'music-settings');
  state.setPref=()=>{throw Error('secret storage path');}; assert.throws(()=>p.update({enabled:false}));
  assert.equal(p.snapshot().enabled,true);
});

test('normalize and resolve deny internal names, IP variants and mixed DNS before requests', async () => {
  for(const url of ['file:///etc/passwd','http://localhost.','http://127.1','http://2130706433',
    'http://[::1]','http://[::ffff:127.0.0.1]','http://169.254.169.254','http://10.0.0.1',
    'http://[fc00::1]','http://[fe80::1]','https://user:pass@example.org','https://example.org:8080',
    'http://printer.local','http://intranet','http://100.64.0.1','http://192.0.2.1']) {
    assert.throws(()=>normalizeWebUrl(url), {code:'WEB_TARGET_BLOCKED'}, url);
  }
  await assert.rejects(resolvePublicTarget('https://example.org',{resolve:async()=>[
    {address:'93.184.216.34',family:4},{address:'127.0.0.1',family:4}]}), {code:'WEB_TARGET_BLOCKED'});
  const target=await resolvePublicTarget('https://example.org',{resolve:publicResolve});
  assert.equal(target.address,'93.184.216.34');
});

test('query and URL checks reject credentials/context without changing public queries', () => {
  assert.equal(validateQuery('Node.js 发布说明'), 'Node.js 发布说明');
  for (const value of ['x'.repeat(321),'Authorization: Bearer abc','Cookie: uin=123','<system>private</system>', 'private-secret-value']) {
    assert.throws(()=>validateQuery(value,['private-secret-value']), {code:'WEB_INVALID_QUERY'});
  }
  assert.throws(()=>normalizeWebUrl('https://example.org/?api_key=secret'));
  assert.equal(normalizeWebUrl('https://example.org/?page=2#section').hash,'');
});

// A request stand-in exercises the actual Node request lookup callback and streamed
// responses. No test relaxes the production public-address validator.
function fakeRequest(responses, calls) {
  return (url, options, callback) => {
    const req=new EventEmitter(); req.destroy=error=>{req.emit('error',error);};
    req.end=body=>{ calls.push({url:String(url),options,body}); queueMicrotask(()=>{
      options.lookup(url.hostname,{all:true},(error,addresses)=>{
        if(error) return req.emit('error',error);
        calls.at(-1).addresses=addresses;
        const next=responses.shift(); const res=Readable.from([next.body||Buffer.from(next.text||'')]);
        res.statusCode=next.status||200;res.headers=next.headers||{};callback(res);
      });
    });}; return req;
  };
}

test('transport pins DNS lookup and never attaches authentication or proxy state', async () => {
  const calls=[];let dns=0;
  const transport=createPublicTransport({resolve:async()=>{dns++;return publicResolve();},request:fakeRequest([{text:'ok'}],calls)});
  const result=await transport('https://example.org/path',{signal:AbortSignal.timeout(1000),maxBytes:100});
  assert.equal(result.text,'ok');assert.equal(dns,1);assert.deepEqual(calls[0].addresses,[{address:'93.184.216.34',family:4}]);
  assert.equal(calls[0].options.agent,false);assert.equal(calls[0].options.headers.Authorization,undefined);
  assert.equal(calls[0].options.headers.Cookie,undefined);
});

test('transport denies unsafe redirects, downgrade and provider-origin/path pivots', async () => {
  for (const location of ['http://127.0.0.1/private','http://example.org/plain']) {
    const calls=[];const transport=createPublicTransport({resolve:publicResolve,request:fakeRequest([{status:302,headers:{location}}],calls)});
    await assert.rejects(transport('https://example.org',{signal:AbortSignal.timeout(1000)}),{code:'WEB_TARGET_BLOCKED'});
    assert.equal(calls.length,1);
  }
  const calls=[];const transport=createPublicTransport({resolve:publicResolve,request:fakeRequest([{status:307,headers:{location:'https://other.org/steal'}}],calls)});
  await assert.rejects(transport('https://example.org/mcp',{provider:true,body:'query',signal:AbortSignal.timeout(1000)}),{code:'WEB_TARGET_BLOCKED'});
  assert.equal(calls.length,1);
});

test('download enforces streamed compressed and decoded byte limits and cancellation',async()=>{
  for (const entry of [{text:'x'.repeat(200)}, {body:gzipSync('x'.repeat(2000)), headers:{'content-encoding':'gzip'}}]) {
    const transport=createPublicTransport({resolve:publicResolve,request:fakeRequest([entry],[])});
    await assert.rejects(transport('https://example.org',{signal:AbortSignal.timeout(1000),maxBytes:100}),{code:'WEB_CONTENT_TOO_LARGE'});
  }
  let calls=0;const transport=createPublicTransport({resolve:publicResolve,request:()=>{calls++;}});
  await assert.rejects(transport('https://example.org',{signal:AbortSignal.abort()})); assert.equal(calls,0);
});

test('provider parsers distinguish empty, malformed, errors and actual sources',()=>{
  assert.deepEqual(parseExa(exa([])),[]);
  assert.equal(parseExa(exa([{title:'t',url:'https://example.org',text:'body'}]))[0].text,'body');
  assert.equal(parseExa('data: '+exa([{title:'t',url:'https://example.org'}])+'\n\n').length,1);
  for(const raw of ['{}','not json',JSON.stringify({error:{code:123,message:'secret'}}),JSON.stringify({result:{isError:true,content:[]}})]) {
    assert.throws(()=>parseExa(raw),{code:'WEB_INVALID_RESPONSE'});
  }
  assert.deepEqual(parseDegoog('{"results":[]}'),[]);assert.throws(()=>parseDegoog('{}'));
});

test('tools fail closed when off, schema/capability invalid; anonymous success is nonterminal',async()=>{
  let calls=0;const policy=new WebAccessPolicy(stateOf());
  const service=new WebAccessService({policy,transport:async()=>{calls++;return searchResponse();},resolve:publicResolve});
  const registry=registerWebAccessTools(new VirtualPersonToolRegistry({logger:{error(){}}}),service);
  const ctx=context();assert.equal((await registry.execute('web_search',{query:'public'},ctx)).code,'WEB_ACCESS_DISABLED');
  policy.update({enabled:true});
  assert.equal((await registry.execute('web_search',{query:'public',provider:'paid'},ctx)).code,'INVALID_TOOL_ARGUMENTS');
  assert.equal((await registry.execute('web_search',{query:'public'},{...ctx,capabilities:[]})).code,'TOOL_NOT_AUTHORIZED');
  const out=await registry.execute('web_search',{query:'public'},ctx);
  assert.equal(out.ok,true);assert.equal(out.terminal,false);assert.equal(calls,1);
  assert.equal(out.facts.sources[0].url,'https://example.org/article');
  service.dispose();
});

test('fallback only once when opted in; empty/auth/cancel do not fall back',async()=>{
  for(const [status,fallback,count] of [[429,false,1],[429,true,2],[401,true,1],[200,true,1]]) {
    const policy=enabled();policy.update({allowDegoogFallback:fallback});let calls=0;
    const service=new WebAccessService({policy,resolve:publicResolve,transport:async()=>{
      calls++;return calls===1?{status,text:exa([]),headers:{}}:{status:200,text:'{"results":[]}',headers:{}};
    }});
    const out=await service.execute('web_search',{query:'public'},context());
    assert.equal(calls,count); if(status===200) assert.equal(out.code,'WEB_NO_RESULTS');service.dispose();
  }
});

test('budgets are shared across members and failures; group changes do not replenish',async()=>{
  let calls=0;const service=new WebAccessService({policy:enabled(),resolve:publicResolve,transport:async()=>{calls++;throw Error('private upstream error');}});
  const group={};for(let i=0;i<3;i++){
    const out=await service.execute('web_search',{query:'public'+i},{...context(group),virtualPersonId:'member'+i});
    assert.equal(out.code,i===2?'WEB_BUDGET_EXHAUSTED':'WEB_UNAVAILABLE');
    assert.ok(!JSON.stringify(out).includes('private upstream'));
  }
  assert.equal(calls,LIMITS.searches);service.dispose();
});

test('policy disable or expired membership prevents late result delivery',async()=>{
  for (const revoke of ['policy','member']) {
    let finish;let current=true;const policy=enabled();
    const service=new WebAccessService({policy,resolve:publicResolve,transport:()=>new Promise(r=>{finish=r;})});
    const pending=service.execute('web_search',{query:'public'},{...context(),isCurrent:()=>current});
    await new Promise(r=>setImmediate(r)); if(revoke==='policy')policy.update({enabled:false});else current=false;
    finish(searchResponse());const out=await pending;assert.equal(out.ok,false);assert.deepEqual(out.facts,{});service.dispose();
  }
});

test('long Chinese results fit complete tool JSON; hostile source schemes never appear',async()=>{
  const service=new WebAccessService({policy:enabled(),resolve:publicResolve,transport:async()=>({...searchResponse(),text:exa([
    {title:'好'.repeat(400),url:'https://example.org/notes',text:'汉字正文'.repeat(1000)},
    {title:'bad',url:'http://127.0.0.1',text:'secret local'}])})});
  const out=await service.execute('web_search',{query:'公开资料'},context());
  assert.equal(out.ok,true);assert.equal(out.facts.sources.length,1);assert.equal(out.facts.truncated,true);
  assert.ok(Buffer.byteLength(JSON.stringify({ok:out.ok,kind:out.kind,code:out.code,facts:out.facts,context:out.modelContext}))<=3500);
  assert.ok(!JSON.stringify(out).includes('127.0.0.1'));service.dispose();
});

test('history and recursive trace projections remove query and page content, keep protocol',()=>{
  const call={id:'c1',type:'function',function:{name:'web_search',arguments:JSON.stringify({query:'PRIVATE_QUERY'})}};
  const proposal={role:'assistant',content:'PRIVATE_QUERY',tool_calls:[call]};
  const tool={role:'tool',tool_call_id:'c1',content:JSON.stringify({ok:true,code:'WEB_SEARCH_OK',facts:{webAccess:true,sources:[{title:'public',url:'https://example.org'}],text:'PRIVATE_PAGE'},context:'PRIVATE_PAGE'})};
  assert.ok(!JSON.stringify(projectWebHistory(proposal)).includes('PRIVATE_QUERY'));
  assert.ok(!JSON.stringify(projectWebHistory(tool,'web_search')).includes('PRIVATE_PAGE'));
  const trace=redactWebTrace({body:{messages:[proposal,tool]},calls:[{id:'c1',name:'web_search',arguments:call.function.arguments}]});
  assert.ok(!JSON.stringify(trace).includes('PRIVATE_QUERY'));assert.ok(!JSON.stringify(trace).includes('PRIVATE_PAGE'));
  assert.ok(!JSON.stringify(trace).includes('https://example.org'));
  assert.equal(trace.body.messages[0].tool_calls[0].id,'c1');
});

test('successful web evidence locks subsequent writes across all members of the user round',async()=>{
  let writes=0;const service=new WebAccessService({policy:enabled(),resolve:publicResolve,transport:async()=>searchResponse()});
  const registry=registerWebAccessTools(new VirtualPersonToolRegistry(),service);
  registry.register('write_test',{capability:'write',definition:{parameters:{type:'object'}},handler:()=>{writes++;return createToolOutcome({kind:'success',code:'WROTE'});}});
  const group={};const ctx={...context(group),capabilities:['web.read','write']};
  assert.equal((await registry.execute('web_search',{query:'public'},ctx)).ok,true);
  for(const person of ['lunara','mio'])assert.equal((await registry.execute('write_test',{}, {...ctx,virtualPersonId:person})).code,'WEB_READ_ONLY_TURN');
  assert.equal(writes,0);
  assert.equal((await registry.execute('write_test',{}, {...ctx,groupAction:{},roundId:'fresh-user-round'})).ok,true);
  assert.equal(writes,1);service.dispose();
});

test('terminal mutation skips later web calls and model rounds',async()=>{
  let requests=0,models=0;const service=new WebAccessService({policy:enabled(),resolve:publicResolve,transport:async()=>{requests++;return searchResponse();}});
  const registry=registerWebAccessTools(new VirtualPersonToolRegistry(),service);
  registry.register('commit_test',{capability:'write',handler:()=>createToolOutcome({kind:'success',code:'COMMITTED',terminal:true,presentation:{displayText:'已安排。'}})});
  const call=(name,args,id)=>({id,type:'function',function:{name,arguments:JSON.stringify(args)}});
  const loop=new AgentLoop({toolRegistry:registry,chat:async()=>{models++;return{message:{role:'assistant',content:'',tool_calls:[call('commit_test',{},'c'),call('web_search',{query:'public'},'w')]}};}});
  const result=await loop.run({systemPrompt:'fixture',capabilities:['web.read','write'],toolContext:{...context(),capabilities:['web.read','write']}});
  assert.equal(result.outcomes.at(-1).code,'SKIPPED_AFTER_TERMINAL');assert.equal(requests,0);assert.equal(models,1);service.dispose();
});

test('global slots bound concurrency and abort queued work without starting it',async()=>{
  let active=0,maximum=0,started=0;const finish=[];
  const service=new WebAccessService({policy:enabled(),resolve:publicResolve,transport:()=>{started++;active++;maximum=Math.max(maximum,active);
    return new Promise(resolve=>finish.push(()=>{active--;resolve(searchResponse());}));}});
  const controller=new AbortController();const a=service.execute('web_search',{query:'one'},context());const b=service.execute('web_search',{query:'two'},context());
  const c=service.execute('web_search',{query:'three'},{...context(),signal:controller.signal});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(started,2);controller.abort();await c;
  finish.forEach(fn=>fn());await Promise.all([a,b]);assert.equal(started,2);assert.equal(maximum,2);assert.equal(service.running,0);service.dispose();
});

test('original turn wall-clock window is not renewed by a later call',async()=>{
  let time=1;const service=new WebAccessService({policy:enabled(),now:()=>time,resolve:publicResolve,transport:async()=>searchResponse()});const ctx=context();
  await service.execute('web_search',{query:'one'},ctx);time+=LIMITS.windowMs+1;
  assert.equal((await service.execute('fetch_content',{url:'https://example.org/article'},ctx)).code,'WEB_BUDGET_EXHAUSTED');service.dispose();
});

test('bounded tool JSON survives the existing context budgeter unchanged', async () => {
  const { ContextBudgeter } = await import('../virtual-person/ContextBudgeter.js');
  const service = new WebAccessService({ policy: enabled(), resolve: publicResolve,
    transport: async () => ({ ...searchResponse(), text: exa([
      { title: '中文长标题'.repeat(20), url: 'https://example.org/notes', text: '汉字正文与摘要'.repeat(400) }]) }) });
  const out = await service.execute('web_search', { query: '公开资料' }, context());
  const content = JSON.stringify({ ok: out.ok, kind: out.kind, code: out.code, facts: out.facts, context: out.modelContext });
  const budgeter = new ContextBudgeter({ maxBytes: 262144, maxMessages: 128, maxToolResultBytes: 4000 });
  const prepared = await budgeter.prepare([{ role: 'assistant', content: '', tool_calls: [{ id: 'c', function: { name: 'web_search', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c', content }]);
  assert.equal(prepared[1].content, content);
  assert.ok(!prepared[1].content.includes('compacted'));
  service.dispose();
});
