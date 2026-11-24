// audioTextSync.js — 基于真实 <audio> 播放时钟的渐进文字揭示（零重排占位 + 中文标点停顿权重）。

const FULL_STOP_RE = /[。！？!?…\n]/u;
const CLAUSE_STOP_RE = /[，,；;：:、—–]/u;
const SPACE_RE = /\s/u;
const ASCII_ALNUM_RE = /[A-Za-z0-9]/;
const STANDALONE_ACTION_RE = /^(?:[（(][^()（）\n]{2,500}[）)]|\*[^*\n]{1,500}\*)$/u;

function isActionNode(node, text) {
  if (node?.classList?.contains?.('roleplay-speech') || node?.classList?.contains?.('chat-seg-speech')) return false;
  if (node?.classList?.contains?.('roleplay-action') || node?.classList?.contains?.('chat-seg-action')) return true;
  return STANDALONE_ACTION_RE.test(String(text || '').trim());
}

export function charTimingWeight(ch) {
  if (!ch) return 0;
  if (FULL_STOP_RE.test(ch)) return 4.5;
  if (CLAUSE_STOP_RE.test(ch)) return 2.5;
  if (SPACE_RE.test(ch)) return 0.25;
  if (ASCII_ALNUM_RE.test(ch)) return 0.55;
  return 1.0;
}

/**
 * 为字符序列预计算归一化时间锚点 [0..1]；末尾标点与换行获得更长停顿配额。
 */
export function computeSpeechAnchors(text) {
  const chars = [...String(text ?? '')];
  const n = chars.length;
  if (n === 0) return { chars, anchors: [] };
  const weights = new Array(n);
  let total = 0;
  for (let i = 0; i < n; i += 1) {
    const w = charTimingWeight(chars[i]);
    weights[i] = w;
    total += w;
  }
  const anchors = new Array(n);
  let acc = 0;
  for (let i = 0; i < n; i += 1) {
    acc += weights[i];
    anchors[i] = total > 0 ? acc / total : (i + 1) / n;
  }
  return { chars, anchors };
}

/** 根据归一化播放进度 [0..1] 二分查找应当显示的码点数。 */
export function revealedCharCount(anchors, progress) {
  const n = anchors?.length || 0;
  if (n === 0) return 0;
  const p = Number(progress);
  if (!Number.isFinite(p) || p <= 0) return 0;
  if (p >= 1) return n;
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (anchors[mid] <= p) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function defaultMatchMedia(query) {
  return globalThis.matchMedia?.(query) || { matches: false };
}

function escapeText(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function renderSplitNode(node, chars, localCount, doc) {
  const revealed = chars.slice(0, localCount).join('');
  const pending = chars.slice(localCount).join('');
  if (typeof node.replaceChildren === 'function' && doc?.createElement) {
    const s1 = doc.createElement('span');
    s1.className = 'sync-revealed';
    s1.textContent = revealed;
    const s2 = doc.createElement('span');
    s2.className = 'sync-pending';
    if (typeof s2.setAttribute === 'function') s2.setAttribute('aria-hidden', 'true');
    s2.textContent = pending;
    node.replaceChildren(s1, s2);
    return;
  }
  if ('innerHTML' in node) {
    node.innerHTML = `<span class="sync-revealed">${escapeText(revealed)}</span><span class="sync-pending" aria-hidden="true">${escapeText(pending)}</span>`;
  }
}

export function createAudioTextSync({
  audio,
  coordinator,
  getTargetsForTask,
  getBeatBubbleForTask = null,
  onActiveBeatChange = null,
  documentLike = globalThis.document,
  matchMedia = defaultMatchMedia,
  requestFrame = globalThis.requestAnimationFrame?.bind(globalThis) || (fn => setTimeout(() => fn(Date.now()), 16)),
  cancelFrame = globalThis.cancelAnimationFrame?.bind(globalThis) || (id => clearTimeout(id)),
} = {}) {
  if (!audio || !coordinator?.subscribe || typeof getTargetsForTask !== 'function') {
    throw new TypeError('audioTextSync requires audio, coordinator, and getTargetsForTask');
  }

  let rafHandle = null;
  let activeSession = null;
  let streamRafHandle = null;
  let streamSession = null;
  let activeBeatState = null;
  let destroyed = false;

  function clearActiveBeat() {
    if (!activeBeatState) return;
    const prev = activeBeatState;
    activeBeatState = null;
    try {
      prev.bubble?.classList?.remove?.('is-speaking');
      if (prev.bubble?.dataset) delete prev.bubble.dataset.speaking;
    } catch {
      // 节点可能已在切换聊天时被卸载
    }
    onActiveBeatChange?.({ turnId: null, beatIndex: null, active: false, previousTurnId: prev.turnId });
  }

  function applyActiveBeat(task) {
    clearActiveBeat();
    if (destroyed || !task) return;
    const turnId = task?.meta?.sourceTurnId || task?.meta?.item?.sourceTurnId || null;
    const rawIdx = task?.meta?.beatIndex ?? task?.meta?.item?.beatIndex;
    const beatIndex = Number.isInteger(rawIdx) ? rawIdx : null;
    if (turnId == null && beatIndex == null) return;
    const bubble = typeof getBeatBubbleForTask === 'function'
      ? getBeatBubbleForTask(task, { turnId, beatIndex })
      : null;
    if (bubble) {
      bubble.classList?.add?.('is-speaking');
      if (bubble.dataset) bubble.dataset.speaking = '1';
    }
    activeBeatState = { token: task?.token ?? null, turnId, beatIndex, bubble };
    onActiveBeatChange?.({ turnId, beatIndex, active: true, task });
  }

  function prefersReducedMotion() {
    try {
      return Boolean(matchMedia?.('(prefers-reduced-motion: reduce)')?.matches);
    } catch {
      return false;
    }
  }

  function buildTargetGroups(rawTargets) {
    const groups = [];
    for (const item of rawTargets || []) {
      const list = Array.isArray(item) ? item : [item];
      const entries = [];
      let speechOffset = 0;
      for (const node of list) {
        const text = String(node?.textContent || '').trim();
        if (!text) continue;
        const chars = [...text];
        const isAction = isActionNode(node, text);
        if (node.dataset) node.dataset.syncActive = '1';
        entries.push({ node, text, chars, isAction, revealAtChar: speechOffset });
        if (!isAction) speechOffset += chars.length;
      }
      if (entries.length) groups.push(entries);
    }
    return groups;
  }

  function restoreSessionNodes(session) {
    if (!session) return;
    rebindDetachedGroups(session);
    for (const entry of session.entries) {
      try {
        if (entry.node.dataset) delete entry.node.dataset.syncActive;
        entry.node.textContent = entry.text;
      } catch {
        // 节点可能已在切换聊天时被卸载
      }
    }
  }

  function rebindDetachedGroups(session) {
    if (!session?.resolveRawTargets) return false;
    const detached = session.entries.some(entry => 'isConnected' in entry.node && entry.node.isConnected === false);
    if (!detached) return false;
    const fresh = buildTargetGroups(session.resolveRawTargets());
    if (!fresh.length) return false;
    if (fresh[0].map(e => e.text).join('') !== session.allText) return false;
    session.groups = fresh;
    session.entries = fresh.flat();
    session.lastCount = -1;
    return true;
  }

  function renderSessionAtCount(session, count) {
    session.lastCount = count;
    for (const group of session.groups) {
      let remaining = count;
      for (const entry of group) {
        if (entry.isAction) {
          // 动作/神态段整块出现，不拆字渲染，也不占台词的语音时间轴。
          const localCount = count >= entry.revealAtChar ? entry.chars.length : 0;
          renderSplitNode(entry.node, entry.chars, localCount, documentLike);
        } else {
          const localCount = Math.max(0, Math.min(entry.chars.length, remaining));
          remaining -= localCount;
          renderSplitNode(entry.node, entry.chars, localCount, documentLike);
        }
      }
    }
  }

  function applySessionProgress(session, progress) {
    if (!session) return;
    rebindDetachedGroups(session);
    const count = revealedCharCount(session.anchors, progress);
    if (count === session.lastCount) return;
    renderSessionAtCount(session, count);
  }

  function clearStream() {
    if (streamRafHandle != null) {
      cancelFrame(streamRafHandle);
      streamRafHandle = null;
    }
    if (!streamSession) return;
    restoreSessionNodes(streamSession);
    streamSession = null;
  }

  function clearSession() {
    if (rafHandle != null) {
      cancelFrame(rafHandle);
      rafHandle = null;
    }
    if (!activeSession) return;
    restoreSessionNodes(activeSession);
    activeSession = null;
  }

  function resolveEffectiveDuration() {
    const native = Number(audio.duration);
    if (Number.isFinite(native) && native > 0) return native;
    const hintMs = Number(activeSession?.durationMs);
    if (Number.isFinite(hintMs) && hintMs > 0) return hintMs / 1000;
    return Math.max(1, (activeSession?.charCount || 1) / 4.2);
  }

  function step() {
    if (destroyed || !activeSession) return;
    const duration = resolveEffectiveDuration();
    const current = Number(audio.currentTime);
    if (Number.isFinite(duration) && duration > 0 && Number.isFinite(current) && current >= 0) {
      applySessionProgress(activeSession, current / duration);
    }
    rafHandle = requestFrame(step);
  }

  function startSession(task) {
    clearStream();
    clearSession();
    if (destroyed || prefersReducedMotion()) return;
    const resolveRawTargets = () => getTargetsForTask(task);
    const groups = buildTargetGroups(resolveRawTargets());
    if (!groups.length) return;

    // 主群组使用第一组节点计算锚点，仅对真正开口的台词计算时间轴；动作段在对应台词边界整块出现。
    const primary = groups[0];
    const allText = primary.map(e => e.text).join('');
    const speechText = primary.filter(e => !e.isAction).map(e => e.text).join('');
    const charCount = [...speechText].length;
    if (charCount === 0) {
      for (const entry of groups.flat()) {
        if (entry.node.dataset) delete entry.node.dataset.syncActive;
      }
      return;
    }
    const { anchors } = computeSpeechAnchors(speechText);
    const allEntries = groups.flat();
    activeSession = {
      taskId: task?.id || null,
      token: task?.token ?? null,
      durationMs: task?.meta?.durationMs ?? task?.meta?.item?.durationMs ?? null,
      charCount,
      allText,
      resolveRawTargets,
      groups,
      entries: allEntries,
      anchors,
      lastCount: -1,
    };

    const duration = resolveEffectiveDuration();
    const current = Number(audio.currentTime);
    const initialProgress = Number.isFinite(duration) && duration > 0 && Number.isFinite(current) && current >= 0
      ? current / duration
      : 0;
    applySessionProgress(activeSession, initialProgress);
    rafHandle = requestFrame(step);
  }

  /** 对未自动出声的新到达回复（如私语模式）按自然顺序揭示：台词逐字推进，动作段整块出现。 */
  function streamTurn({
    key = null,
    getNodes,
    nowMs = () => globalThis.performance?.now?.() ?? Date.now(),
    msPerChar = 16,
    minDurationMs = 700,
    maxDurationMs = 3800,
  } = {}) {
    clearStream();
    if (destroyed || activeSession || prefersReducedMotion() || typeof getNodes !== 'function') return;
    const resolveRawTargets = () => {
      const nodes = getNodes();
      return Array.isArray(nodes) && nodes.length ? [nodes] : [];
    };
    const groups = buildTargetGroups(resolveRawTargets());
    if (!groups.length) return;

    const allText = groups[0].map(e => e.text).join('');
    const speechText = groups[0].filter(e => !e.isAction).map(e => e.text).join('');
    const charCount = [...speechText].length;
    if (charCount === 0) {
      for (const entry of groups.flat()) {
        if (entry.node.dataset) delete entry.node.dataset.syncActive;
      }
      return;
    }
    const { anchors } = computeSpeechAnchors(speechText);
    const durationMs = Math.max(minDurationMs, Math.min(maxDurationMs, charCount * msPerChar));
    const startedAt = nowMs();

    streamSession = {
      key,
      allText,
      resolveRawTargets,
      groups,
      entries: groups.flat(),
      anchors,
      startedAt,
      durationMs,
      lastCount: -1,
    };

    const tick = () => {
      if (destroyed || !streamSession) return;
      const progress = Math.max(0, Math.min(1, (nowMs() - streamSession.startedAt) / streamSession.durationMs));
      if (progress >= 1) {
        clearStream();
        return;
      }
      applySessionProgress(streamSession, progress);
      streamRafHandle = requestFrame(tick);
    };

    applySessionProgress(streamSession, 0);
    streamRafHandle = requestFrame(tick);
  }

  const unsubscribe = coordinator.subscribe(event => {
    if (destroyed) return;
    const type = event?.type;
    const token = event?.task?.token ?? null;
    if (type === 'started' || type === 'runtime-audible') {
      applyActiveBeat(event.task);
      if (activeSession && token != null && activeSession.token === token) return;
      startSession(event.task);
    } else if (type === 'finished' || type === 'cancelled' || type === 'error') {
      if (activeBeatState && (token == null || activeBeatState.token === token)) clearActiveBeat();
      if (activeSession && (token == null || activeSession.token === token)) clearSession();
    }
  });

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    unsubscribe();
    clearActiveBeat();
    clearStream();
    clearSession();
  }

  return Object.freeze({ destroy, clear: clearSession, streamTurn, clearStream });
}
