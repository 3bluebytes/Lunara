// sw.js — 极简壳缓存
// HTML 永远走网络（避免新版 JS/CSS 引用被旧 HTML 截胡）。
// CSS/JS 带版本号 query，浏览器侧自己 cache 即可，SW 不再代缓存。
// 这版主要作用：清理掉以前积累的旧 cache。

const SHELL = 'lunara-shell-v17';

self.addEventListener('install', e => {
  // 不预缓存任何东西 —— 让浏览器与版本号自己处理新鲜度
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== SHELL).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// 不拦截 fetch —— 让所有请求直接走网络。
// （原来的 cache-first 策略对 HTML 太黏，导致版本号 bump 也吃不到。）
