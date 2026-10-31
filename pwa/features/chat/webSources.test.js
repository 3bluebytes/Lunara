import test from 'node:test';
import assert from 'node:assert/strict';
import { webSourcesHtml } from './webSources.js';
test('sources are escaped, safe external links with readable evidence labels',()=>{
 const html=webSourcesHtml([{sourceId:'web_safe',title:'<script>unsafe</script>',url:'https://example.org/article',provider:'exa',contentKind:'search_snippet',retrievedAt:'2026-10-21T10:00:00Z'}]);
 assert.ok(html.includes('&lt;script&gt;'));assert.ok(!html.includes('<script>'));
 assert.ok(html.includes('noopener noreferrer'));assert.ok(html.includes('搜索摘要'));assert.ok(!html.includes('<img'));assert.ok(!html.includes('prefetch'));
});
test('source list ignores malformed and unsafe URLs and is empty without host sources',()=>{
 for(const url of ['javascript:alert(1)','http://127.0.0.1','http://2130706433','https://user:pass@example.org','file:///etc/passwd'])
   assert.equal(webSourcesHtml([{sourceId:'web_safe',url,title:'bad'}]),'');
 assert.equal(webSourcesHtml(null),'');
});
