import { createRemoteAudioProxy, REMOTE_AUDIO_PREFIX } from '../../media/remoteAudioProxy.js';
import { trace } from '../../trace.js';

/**
 * 同源音频中继的 HTTP 入口。
 *
 * 为什么需要它：播放器为了画波形会把 <audio> 接进 Web Audio 图，而浏览器对跨源媒体
 * 元素的这一路径输出静音——元素照常前进，于是「进度条在走、没有声音、也不报错」。
 * 因此交给播放器的音频地址必须与应用同源；本地资产命中时走 /audio，缓存失败时走这里。
 *
 * 直链解析由组合根注入（`resolveAudioDirectUrl(provider, songId)`）：这一层不自己
 * import 供应商，免得把认证状态带进路由模块。
 */
export function registerMediaRelayRoutes(app, services = {}) {
  const resolveAudioDirectUrl = services.resolveAudioDirectUrl;
  // 没接源签名就不挂半套路由：宁可 404，也不要一个解析不出直链的中继。
  if (typeof resolveAudioDirectUrl !== 'function') return null;
  const proxy = createRemoteAudioProxy({
    resolveUrl: resolveAudioDirectUrl,
    trace: event => trace({ ...event, layer: 'media-relay' }),
  });
  app.get(`${REMOTE_AUDIO_PREFIX}:token`, proxy.handler);
  return proxy;
}
