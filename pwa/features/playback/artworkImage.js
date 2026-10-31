// artworkImage.js — 封面 <img> 的唯一写入方式。
//
// 两种「没有封面」必须都落到兜底图，而不是留一张空白/破图：
//   1. 元数据里没有封面 URL（兜底在写入时就替换）；
//   2. 有 URL 但加载失败（CDN 404、离线、http 图被混合内容拦掉）。
// 失败兜底只做一次：兜底图自己也加载不了时不进入重试循环。

export const COVER_FALLBACK = '/cover-fallback.jpg';
export const APP_ICON = '/icon.png';

const bound = new WeakSet();

export function applyArtwork(image, src, { fallback = COVER_FALLBACK } = {}) {
  if (!image) return;
  if (!bound.has(image)) {
    bound.add(image);
    image.addEventListener?.('error', () => {
      if (image.dataset?.coverFallback === '1') return;
      if (image.dataset) image.dataset.coverFallback = '1';
      image.src = fallback;
    });
  }
  const target = String(src || '').trim() || fallback;
  // 没有封面与加载失败都标 coverFallback，主题可据此换画法（夜场用歌名首字方块）。
  if (image.dataset) {
    if (target === fallback) image.dataset.coverFallback = '1';
    else delete image.dataset.coverFallback;
  }
  image.src = target;
}
