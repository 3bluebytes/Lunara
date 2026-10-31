// likeHydration.js — 排歌之后把整批曲目的远端「喜欢」状态对齐一次。
//
// 为什么要在排歌时做，而不是等界面逐首去问：界面上喜欢只有一处真相，但它需要
// 云端事实。逐首在读的时候问会变成「切一首打一次远端」，而且第一帧可能是空心的
// —— 一首本来就在用户收藏里的歌会先显示成没喜欢。排歌是天然的批处理点：网易云
// 一次 likelist 拿全量 id，QQ 一次 IsSongFanByMid 批量问。
//
// 三条约束：
//   1. 尽力而为：读失败只放弃这一批，不改已有意图、不阻塞提交、不抛错。
//   2. 每份节目只水合一次（用 programId/requestId 去重，有上限的窗口）。
//   3. 这里是**触发**，不是判定：谁说了算由 TrackLikeService.hydrate 的
//      origin 规则决定（用户表达过的以本地为准，采纳来的跟随远端）。

export function createLikeHydration({ maxPrograms = 200 } = {}) {
  let service = null;
  let seen = new Set();

  return Object.freeze({
    attach(next) { service = next || null; },

    /** 记下这份节目的曲目并异步水合一次；同一份节目重复提交不会重复打远端。 */
    request(program) {
      if (!service) return false;
      const tracks = Array.isArray(program?.tracks) ? program.tracks : [];
      if (!tracks.length) return false;
      const key = String(program?.programId || program?.requestId || '').trim();
      if (key) {
        if (seen.has(key)) return false;
        seen.add(key);
        if (seen.size > maxPrograms) seen = new Set([...seen].slice(-Math.floor(maxPrograms / 2)));
      }
      void service.hydrate({ tracks }).catch(() => {});
      return true;
    },
  });
}
