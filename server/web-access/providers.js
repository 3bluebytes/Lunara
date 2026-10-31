// Protocol reference: pi-web-access@0.44.0 exa.ts/degoog.ts. Implementation
// intentionally has no credential discovery, host SDK, provider auto-routing or LLM.
import { fail } from './errors.js';
export const EXA_ENDPOINT = 'https://mcp.exa.ai/mcp?tools=web_search_exa';
export const DEGOOG_ENDPOINT = 'https://degoog.org/api/search';
export function parseExa(raw) {
  let rpc;
  for (const candidate of [raw, ...raw.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trim())]) {
    try { const parsed=JSON.parse(candidate); if (parsed?.result || parsed?.error) { rpc=parsed;break; } } catch { /* next SSE item */ }
  }
  if (!rpc?.result || rpc.error || rpc.result.isError) fail('WEB_INVALID_RESPONSE');
  const text=rpc.result.content?.filter(item=>item.type==='text' && typeof item.text==='string').map(item=>item.text).join('\n');
  if (!text) fail('WEB_INVALID_RESPONSE');
  try { const data=JSON.parse(text); if (Array.isArray(data?.results)) return data.results; } catch { /* formatted response */ }
  if (/^\s*(?:No results found\.?|No search results found\.?)\s*$/i.test(text)) return [];
  const rows=text.split(/(?=^Title: )/m).flatMap(block=>{
    const title=block.match(/^Title: (.+)/m)?.[1]; const url=block.match(/^URL: (.+)/m)?.[1];
    if (!title || !url) return [];
    const body=block.match(/\n(?:Text|Highlights):\s*([\s\S]*)/)?.[1] || '';
    const publishedDate=block.match(/^Published Date: (.+)/m)?.[1];
    return [{title,url,text:body,...(publishedDate?{publishedDate}:{})}];
  });
  if (!rows.length) fail('WEB_INVALID_RESPONSE'); return rows;
}
export function parseDegoog(raw) {
  let data; try { data=JSON.parse(raw); } catch { fail('WEB_INVALID_RESPONSE'); }
  if (!Array.isArray(data?.results)) fail('WEB_INVALID_RESPONSE');
  return data.results.map(item=>({title:item.title,url:item.url,text:item.content || item.description || item.snippet || ''}));
}
export async function searchProvider(provider, query, limit, { transport, signal, secrets }) {
  const exa=provider==='exa';
  const body=exa ? {jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'web_search_exa',arguments:{query,numResults:limit}}}
    : {query,type:'web',page:1};
  const response=await transport(exa?EXA_ENDPOINT:DEGOOG_ENDPOINT,
    {provider:true,body:JSON.stringify(body),signal,secrets,maxBytes:512*1024});
  if (response.status===429) fail('WEB_RATE_LIMITED');
  if (response.status===401 || response.status===403) fail('WEB_AUTH_REQUIRED');
  if (response.status>=500) fail('WEB_UNAVAILABLE');
  if (response.status!==200) fail('WEB_INVALID_RESPONSE');
  return exa?parseExa(response.text):parseDegoog(response.text);
}
