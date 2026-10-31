// Only host-provided metadata is linked; model prose remains escaped plain text.
const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
function safeUrl(value){try{const url=new URL(value);const host=url.hostname.replace(/\.$/,'').toLowerCase();
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.port||value.length>2048)return null;
  if(host.includes(':')||!host.includes('.')||/(?:^|\.)(?:localhost|local|internal|lan|test|invalid)$/.test(host))return null;
  if(/^\d+(?:\.\d+){3}$/.test(host)){const[a,b]=host.split('.').map(Number);
    if(a===0||a===10||a===127||a>=224||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&b===168)||(a===100&&b>=64&&b<=127))return null;}
  if([...url.searchParams.keys()].some(key=>/key|token|secret|signature|auth|cookie|password/i.test(key)))return null;
  return url.href;}catch{return null;}}
export function webSourcesHtml(sources){if(!Array.isArray(sources))return'';
  const rows=sources.slice(0,5).flatMap(source=>{const url=typeof source?.url==='string'?safeUrl(source.url):null;
    if(!url||!/^web_[\w-]+$/.test(source.sourceId||''))return[];
    const kind=source.contentKind==='page_text'?'已读取正文':'搜索摘要';
    const date=typeof source.retrievedAt==='string'&&!Number.isNaN(Date.parse(source.retrievedAt))?new Date(source.retrievedAt).toLocaleDateString('zh-CN'):'';
    return[`<li><a href="${escape(url)}" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">${escape(String(source.title||new URL(url).hostname).slice(0,160))}</a><span>${kind}${date?` · 检索于 ${escape(date)}`:''}</span></li>`];});
  return rows.length?`<details class="chat-web-sources"><summary>参考来源 · ${rows.length}</summary><ul>${rows.join('')}</ul></details>`:'';
}
