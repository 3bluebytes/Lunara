// Separate persisted policy: never part of the music/model settings draft.
const ENDPOINT='/api/web-access/settings';
const controls=[['enabled','#web-access-toggle'],['allowDegoogFallback','#web-access-fallback']];
export function createWebAccessSetting({apiClient,documentLike=globalThis.document,showToast=()=>{}}={}){
  const $=selector=>documentLike?.querySelector?.(selector);let confirmed=null,busy=false,generation=0;
  const cleanups=[];
  const status=text=>{const node=$('#web-access-status');if(node)node.textContent=text;};
  function render(){for(const[key,selector]of controls){const input=$(selector);if(!input)continue;
    input.checked=confirmed?.[key]===true;input.disabled=!confirmed||(key==='allowDegoogFallback'&&!confirmed.enabled);
    input.setAttribute('aria-busy',String(busy));}}
  async function refresh(){if(busy)return;const own=++generation;
    try{const value=await apiClient.get(ENDPOINT);if(own!==generation)return;
      if(value?.ok===false||typeof value?.enabled!=='boolean')throw Error('invalid policy');
      confirmed=value;status(value.enabled?'已开启：伙伴可以自动查询公开问题。':'未开启：伙伴不会使用这些联网工具。');
    }catch{if(own===generation)status('暂时读不到联网设置，重新打开设置可重试。');}render();}
  async function set(key,next){if(busy||!confirmed||!controls.some(([name])=>name===key)){render();return;}
    busy=true;++generation;status('正在保存…');render();
    try{const value=await apiClient.patch(ENDPOINT,{[key]:next===true});
      if(value?.ok===false||typeof value?.enabled!=='boolean')throw Error('write rejected');confirmed=value;
      status(value.enabled?'已保存，伙伴可以自动查询公开问题。':'已关闭，已停止在途联网；此前已发送给第三方的数据无法撤回。');
      showToast('success','联网设置已保存',key==='allowDegoogFallback'
        ? (value.allowDegoogFallback?'Exa 不可用时会用匿名 degoog 公共实例；同样不转收费服务。':'已关闭 degoog 备用；Exa 不可用时就不联网。')
        : (value.enabled
          ? '伙伴遇到公开问题会直接搜索；后台反思、续播与主动开口不联网。'
          : '已停止后续联网；此前已发送给第三方的数据无法撤回。'),{curated:true});
    }catch{status(`未保存，仍按此前${confirmed.enabled?'开启':'关闭'}的状态运行。可以重试。`);}
    finally{busy=false;render();}}
  for(const[key,selector]of controls){const input=$(selector);const listener=()=>void set(key,input.checked);
    input?.addEventListener('change',listener);cleanups.push(()=>input?.removeEventListener('change',listener));}
  render();return Object.freeze({refresh,set,destroy:()=>{++generation;cleanups.forEach(fn=>fn());}});
}
