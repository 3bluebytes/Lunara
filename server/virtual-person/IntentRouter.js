import { MUSIC_CAPABILITY } from '../program/musicSelectionRequest.js';
import { createToolOutcome, ToolOutcomeKind } from './VirtualPersonTypes.js';

const CADENCE_TOOL = 'set_familiar_artist_cadence';
const MUSIC_SELECTION_TOOL = 'select_music';
const MUSIC_COMMIT_TOOL = 'commit_music_selection';
// 选歌是两步：select_music 给候选，commit_music_selection 才提交；两者都受偏好写入顺序约束。
const CADENCE_DEPENDENT_TOOLS = new Set([MUSIC_SELECTION_TOOL, MUSIC_COMMIT_TOOL]);
const SEARCH_TOOLS = new Set(['search_music', 'search_library']);
// 这些结果说明再调一轮模型也不会有进展：直接用工具复核过的文案收尾。
const STOP_CODES = new Set(['NO_FRESH_MUSIC_REQUEST', 'WEB_READ_ONLY_TURN', 'PREFERENCE_WRITE_REQUIRED']);

const MUSIC_INTENT_GUIDANCE = `## 意图路由与音乐动作
先在这一次模型响应中判断本轮是普通对话、明确反馈、音乐动作，还是反馈加音乐动作；用可用的 typed tool 表达需要执行的动作。普通对话不必调用工具，不要输出内部意图标签，也不要先做第二次意图识别请求。
用户浏览聊天不代表要切换音乐，普通聊天保持原音乐来源。只回复当前用户输入；“？”等追问不是重试播放或重新记反馈的授权。前一轮失败时应如实解释，等用户再次明确要求才操作。
用户明确纠正熟悉歌手与陌生歌手的推荐频率时，用 set_familiar_artist_cadence 保存本轮原话；只有工具成功后才确认。若同一句还要求立即推荐或换歌，同时调用选歌工具；反馈先写入再选歌。只反馈时不要改队列。
用户说某艺人的歌不对胃口时，换歌应排除该艺人，不要把该艺人写成必选；不要把你猜测的气氛写成用户提出的硬标签条件。
选歌分两步：select_music 返回候选 offer（不是已经播放）；随后从候选里选 1 起始序号调用 commit_music_selection 提交，交付方式沿用那一次请求，不能在提交时改写。候选之外没有可放的歌，也不能用关键词去猜别的歌。
用户要求你推歌来听、放歌或一起听时，用 replace_now 立即播放本聊天的新队列，不等待其他聊天的歌曲结束；提交成功只表示已经安排，实际出声还要等串词和媒体确认。
若本聊天已有合适队列，要求一起听可用 control_listening 的 listen。只有明确要求等这首结束才用 after_current；只加入稍后队列才用 append；只推荐而不播放才用 recommend_only（候选与提交都不会播放）。`;

/** One first-call routing hook: prompt guidance plus ordering of model-proposed typed actions. */
export class IntentRouter {
  extendSystemPrompt(systemPrompt, { capabilities = [] } = {}) {
    const base = String(systemPrompt || '').trim();
    return Array.isArray(capabilities) && capabilities.includes(MUSIC_CAPABILITY)
      ? [base, MUSIC_INTENT_GUIDANCE].filter(Boolean).join('\n\n') : base;
  }

  /** `run` 是同一次 AgentLoop 运行共享的记录，跨轮累计连续选歌落空的次数。 */
  plan(toolCalls = [], run = {}) {
    // 偏好写入照旧排到最前；选歌与候选提交排在其它动作之后：精确点歌提交即终止，
    // 不能抢先结束本轮而跳过同批的记忆写入；候选提交也不能抢在候选查询之前执行。
    const rank = call => {
      const name = String(call?.function?.name || '');
      if (name === CADENCE_TOOL) return 0;
      if (name === MUSIC_SELECTION_TOOL) return 2;
      if (name === MUSIC_COMMIT_TOOL) return 3;
      return 1;
    };
    const calls = [...toolCalls].sort((a, b) => rank(a) - rank(b));
    let cadenceFailed = false;
    let noProgress = null;
    // 同批任一搜索找到新候选就不按「无进展」收尾，与执行顺序无关。
    let batchFoundCandidates = false;
    return {
      calls,
      blockedOutcome(call) {
        // 偏好没写成功时，选歌与提交都不能按该偏好进行。
        if (!cadenceFailed || !CADENCE_DEPENDENT_TOOLS.has(call?.function?.name)) return null;
        return createToolOutcome({
          kind: ToolOutcomeKind.BUSINESS_FAILURE,
          code: 'PREFERENCE_WRITE_REQUIRED',
          modelContext: '本轮明确的频率偏好没有保存成功，不能按该偏好继续选歌或提交。',
          presentation: { displayText: '这条偏好还没保存成功，所以我没有按它换歌。', speak: false },
        });
      },
      observe(call, outcome) {
        const name = call?.function?.name;
        if (name === CADENCE_TOOL && !outcome?.ok) cadenceFailed = true;
        if (outcome?.ok && SEARCH_TOOLS.has(name)
          && (Number(outcome.facts?.total) > 0 || outcome.facts?.tracks?.length > 0)) {
          run.noMatchSelections = 0;
          batchFoundCandidates = true;
          if (noProgress?.code === 'NO_MATCHING_CANDIDATES') noProgress = null;
        }
        if (name === MUSIC_SELECTION_TOOL && outcome?.code === 'NO_MATCHING_CANDIDATES') {
          run.noMatchSelections = (run.noMatchSelections || 0) + 1;
          if (run.noMatchSelections >= 2 && !batchFoundCandidates) noProgress = outcome;
        }
        if (STOP_CODES.has(outcome?.code)) noProgress = outcome;
      },
      noProgressOutcome() {
        return noProgress;
      },
    };
  }
}
