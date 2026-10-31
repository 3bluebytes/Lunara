// 续播预算：这两个数字必须有明确关系，否则队列会被永久顶在阈值线上。
//
// - 提前量（look-ahead）：只决定“提前多久开始找”。当前曲目之后剩余已提交曲目数降到
//   该值时，runtime 就为这个边界提前发起一次续选（队列耗尽仍是兜底触发）。
// - 批量（batch）：决定“一次补几首 / 多久找一次”。补货 B 首后余量回到
//   `LOOKAHEAD + B`，此后每激活一首余量减 1，所以下一次触发恰好发生在 B 首之后。
//
// 不变量：批量必须严格大于提前量。B <= L 时（例如 L=3、B=2），补货只把队列顶回阈值
// 之上一点，缓冲永远长不起来，于是每一次换歌都在阈值处触发一次续选——复现过的
// “每播 2 首选一次、队列永远只剩 3~5 首、3 首点播提交后 1 秒就续选”就是这么来的。
function readCount(value, fallback, minimum) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= minimum ? parsed : fallback;
}

export const CONTINUATION_LOOKAHEAD = readCount(process.env.MUSIC_CONTINUATION_LOOKAHEAD, 1, 0);

/** 批量按构造抬到“提前量 + 1”以上：调参也不会退化回“每次换歌都续选”。 */
export const CONTINUATION_BATCH_SIZE = Math.max(
  readCount(process.env.MUSIC_CONTINUATION_BATCH, 3, 1),
  CONTINUATION_LOOKAHEAD + 1,
);
