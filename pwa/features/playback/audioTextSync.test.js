import test from 'node:test';
import assert from 'node:assert/strict';
import { computeSpeechAnchors, createAudioTextSync, revealedCharCount } from './audioTextSync.js';

function fakeNode(text) {
  const children = [];
  return {
    textContent: text,
    innerHTML: '',
    dataset: {},
    replaceChildren(...els) {
      children.length = 0;
      children.push(...els);
      this.rendered = children.map(c => ({ cls: c.className, text: c.textContent }));
    },
  };
}

function fakeCoordinator() {
  const listeners = new Set();
  return {
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    emit(event) {
      for (const fn of listeners) fn(event);
    },
  };
}

test('computeSpeechAnchors weights Chinese punctuation heavier and advances monotonically', () => {
  const { chars, anchors } = computeSpeechAnchors('你好，世界。下一句');
  assert.equal(anchors.length, chars.length);
  assert.equal(anchors.at(-1), 1);
  // 句号处的权重增量应大于普通汉字。
  const commaStep = anchors[2] - anchors[1];
  const periodStep = anchors[5] - anchors[4];
  const plainStep = anchors[1] - anchors[0];
  assert.ok(commaStep > plainStep);
  assert.ok(periodStep > commaStep);
  assert.equal(revealedCharCount(anchors, 0), 0);
  assert.equal(revealedCharCount(anchors, 1), chars.length);
  assert.ok(revealedCharCount(anchors, 0.5) > 0 && revealedCharCount(anchors, 0.5) < chars.length);
});

test('createAudioTextSync drives reveal from real audio clock with zero-reflow spans and cleans up on finish or stop', () => {
  const audio = { duration: 10, currentTime: 0 };
  const coordinator = fakeCoordinator();
  const node = fakeNode('今夜风很轻，慢慢听完这首歌。');
  const frameQueue = [];
  const doc = {
    createElement: () => ({ className: '', textContent: '', setAttribute() {} }),
  };
  const sync = createAudioTextSync({
    audio,
    coordinator,
    documentLike: doc,
    getTargetsForTask: task => task?.id === 't1' ? [[node]] : [],
    matchMedia: () => ({ matches: false }),
    requestFrame: fn => { frameQueue.push(fn); return frameQueue.length; },
    cancelFrame: () => { frameQueue.length = 0; },
  });

  const task1 = { id: 't1', token: 1, lane: 'foreground' };
  const queuedOther = { id: 't2', token: 2, lane: 'runtime' };

  coordinator.emit({ type: 'started', task: task1 });
  assert.equal(node.dataset.syncActive, '1');
  assert.equal(node.rendered[0].cls, 'sync-revealed');
  assert.equal(node.rendered[0].text, '');
  assert.equal(node.rendered[1].cls, 'sync-pending');
  assert.equal(node.rendered[1].text, '今夜风很轻，慢慢听完这首歌。');

  // 推进音频时钟到 50%：逐步揭示前半句，后半句保持占位。
  audio.currentTime = 5;
  frameQueue.shift()();
  assert.ok(node.rendered[0].text.length > 0 && node.rendered[0].text.length < '今夜风很轻，慢慢听完这首歌。'.length);
  assert.equal(node.rendered[0].text + node.rendered[1].text, '今夜风很轻，慢慢听完这首歌。');

  // 取消未激活的排队任务不能打断当前正在同步揭示的句子。
  coordinator.emit({ type: 'cancelled', task: queuedOther });
  assert.equal(node.dataset.syncActive, '1');

  // 播完后还原干净纯文本并移除 syncActive。
  coordinator.emit({ type: 'finished', task: task1 });
  assert.equal(node.dataset.syncActive, undefined);
  assert.equal(node.textContent, '今夜风很轻，慢慢听完这首歌。');
  sync.destroy();
});

test('createAudioTextSync skips animation under prefers-reduced-motion: reduce', () => {
  const audio = { duration: 10, currentTime: 0 };
  const coordinator = fakeCoordinator();
  const node = fakeNode('静静听一首。');
  const sync = createAudioTextSync({
    audio,
    coordinator,
    getTargetsForTask: () => [[node]],
    matchMedia: () => ({ matches: true }),
    requestFrame: () => { throw new Error('should not schedule rAF when reduced motion is enabled'); },
  });
  coordinator.emit({ type: 'started', task: { id: 't1', token: 1 } });
  assert.equal(node.textContent, '静静听一首。');
  assert.equal(node.dataset.syncActive, undefined);
  sync.destroy();
});

test('streamTurn reveals action blocks whole at speech boundaries while streaming speech char-by-char and survives DOM replacement', () => {
  const audio = { duration: 0, currentTime: 0 };
  const coordinator = fakeCoordinator();
  let clock = 1000;
  const frameQueue = [];
  const doc = { createElement: () => ({ className: '', textContent: '', setAttribute() {} }) };

  const mkAction = text => ({ ...fakeNode(text), isConnected: true, classList: { contains: c => c === 'chat-seg-action' } });
  const mkSpeech = text => ({ ...fakeNode(text), isConnected: true, classList: { contains: c => c === 'chat-seg-speech' } });

  let action1 = mkAction('（把手里的笔搁下）');
  let speech1 = mkSpeech('怎么办。你自己想办法。');
  let action2 = mkAction('（抬起眼看你）');
  let speech2 = mkSpeech('四点了。');

  const sync = createAudioTextSync({
    audio,
    coordinator,
    documentLike: doc,
    getTargetsForTask: () => [],
    matchMedia: () => ({ matches: false }),
    requestFrame: fn => { frameQueue.push(fn); return frameQueue.length; },
    cancelFrame: () => { frameQueue.length = 0; },
  });

  sync.streamTurn({
    key: 'turn_rp_stream',
    getNodes: () => [action1, speech1, action2, speech2],
    nowMs: () => clock,
    msPerChar: 40,
    minDurationMs: 1000,
    maxDurationMs: 2000,
  });

  // t=0：开场动作整块立即出现，不拆字；台词与后续动作保持占位隐藏。
  assert.equal(action1.rendered[0].text, '（把手里的笔搁下）');
  assert.equal(action1.rendered[1].text, '');
  assert.equal(speech1.rendered[0].text, '');
  assert.equal(action2.rendered[0].text, '');
  assert.equal(speech2.rendered[0].text, '');

  // t=20%：只对第一句台词逐字揭示，第二段动作和台词仍保持隐藏。
  clock += 200;
  frameQueue.shift()();
  assert.equal(action1.rendered[0].text, '（把手里的笔搁下）');
  assert.ok(speech1.rendered[0].text.length > 0 && speech1.rendered[1].text.length > 0);
  assert.equal(action2.rendered[0].text, '');
  assert.equal(speech2.rendered[0].text, '');

  // 模拟 loadTranscript 重排替换 DOM 节点（旧节点 isConnected=false）：下一帧自动重绑新节点继续平滑输出。
  action1.isConnected = false;
  speech1.isConnected = false;
  action2.isConnected = false;
  speech2.isConnected = false;
  action1 = mkAction('（把手里的笔搁下）');
  speech1 = mkSpeech('怎么办。你自己想办法。');
  action2 = mkAction('（抬起眼看你）');
  speech2 = mkSpeech('四点了。');

  // 推进到第一句结束以后：action2 整块显现（绝不半截出现），开始逐字揭示 speech2。
  clock += 650;
  frameQueue.shift()();
  assert.equal(action1.rendered[0].text, '（把手里的笔搁下）');
  assert.equal(speech1.rendered[0].text, '怎么办。你自己想办法。');
  assert.equal(action2.rendered[0].text, '（抬起眼看你）');
  assert.equal(action2.rendered[1].text, '');
  assert.ok(speech2.rendered[0].text.length > 0);

  // 到达结束时间：自动清场并把完整纯文本落回最新节点。
  clock += 2000;
  frameQueue.shift()();
  assert.equal(action1.dataset.syncActive, undefined);
  assert.equal(speech2.textContent, '四点了。');
  sync.destroy();
});

test('createAudioTextSync times speech strictly against audio clock and reveals standalone parenthetical actions whole', () => {
  const audio = { duration: 10, currentTime: 0 };
  const coordinator = fakeCoordinator();
  const frameQueue = [];
  const doc = { createElement: () => ({ className: '', textContent: '', setAttribute() {} }) };

  const action1 = fakeNode('（把沙发上的靠垫往你那边推了推）');
  const speech1 = fakeNode('今晚就听歌，好不好。');
  const action2 = fakeNode('（抬手把耳边的碎发别到耳后）');
  const speech2 = fakeNode('别急，慢慢来。');

  const sync = createAudioTextSync({
    audio,
    coordinator,
    documentLike: doc,
    getTargetsForTask: () => [[action1, speech1, action2, speech2]],
    matchMedia: () => ({ matches: false }),
    requestFrame: fn => { frameQueue.push(fn); return frameQueue.length; },
    cancelFrame: () => { frameQueue.length = 0; },
  });

  coordinator.emit({ type: 'started', task: { id: 't_mixed', token: 1, lane: 'foreground' } });
  // 开头括号动作立即整块显现；两句台词与中间动作等待语音推进。
  assert.equal(action1.rendered[0].text, '（把沙发上的靠垫往你那边推了推）');
  assert.equal(speech1.rendered[0].text, '');
  assert.equal(action2.rendered[0].text, '');

  // 音频推进到 30%：正在念 speech1，action2 仍完整隐藏，绝不出现半截括号。
  audio.currentTime = 3;
  frameQueue.shift()();
  assert.ok(speech1.rendered[0].text.length > 0 && speech1.rendered[1].text.length > 0);
  assert.equal(action2.rendered[0].text, '');

  // 音频推进到 80%：speech1 已播完，action2 整块出现，speech2 同步推进。
  audio.currentTime = 8;
  frameQueue.shift()();
  assert.equal(speech1.rendered[0].text, '今晚就听歌，好不好。');
  assert.equal(action2.rendered[0].text, '（抬手把耳边的碎发别到耳后）');
  assert.equal(action2.rendered[1].text, '');
  assert.ok(speech2.rendered[0].text.length > 0);

  coordinator.emit({ type: 'finished', task: { id: 't_mixed', token: 1, lane: 'foreground' } });
  sync.destroy();
});

test('createAudioTextSync keeps roleplay-speech with parenthetical title as speech and tracks active beatIndex across beats including reduced-motion', () => {
  const audio = { duration: 10, currentTime: 0 };
  const coordinator = fakeCoordinator();
  const frameQueue = [];
  const doc = { createElement: () => ({ className: '', textContent: '', setAttribute() {} }) };
  const makeBubble = idx => {
    const classes = new Set();
    return {
      dataset: { beatIndex: String(idx) },
      classList: {
        add: name => classes.add(name),
        remove: name => classes.delete(name),
        contains: name => classes.has(name),
      },
    };
  };
  const b0 = makeBubble(0);
  const b1 = makeBubble(1);
  const action0 = { ...fakeNode('（推门进来）'), classList: { contains: c => c === 'roleplay-action' } };
  const speech0 = { ...fakeNode('（2007 Live）这版真不错。'), classList: { contains: c => c === 'roleplay-speech' } };
  const activeChanges = [];

  const sync = createAudioTextSync({
    audio,
    coordinator,
    documentLike: doc,
    getBeatBubbleForTask: (_task, { beatIndex }) => (beatIndex === 0 ? b0 : beatIndex === 1 ? b1 : null),
    onActiveBeatChange: payload => activeChanges.push(payload),
    getTargetsForTask: task => task?.meta?.beatIndex === 0 ? [[action0, speech0]] : [],
    matchMedia: () => ({ matches: false }),
    requestFrame: fn => { frameQueue.push(fn); return frameQueue.length; },
    cancelFrame: () => { frameQueue.length = 0; },
  });

  const t0 = { id: 'b0', token: 1, lane: 'foreground', meta: { sourceTurnId: 'turn_rp_1', beatIndex: 0 } };
  const t1 = { id: 'b1', token: 2, lane: 'foreground', meta: { sourceTurnId: 'turn_rp_1', beatIndex: 1 } };

  coordinator.emit({ type: 'started', task: t0 });
  assert.equal(b0.classList.contains('is-speaking'), true);
  assert.equal(b0.dataset.speaking, '1');
  assert.equal(speech0.rendered[0].text, '', 'roleplay-speech 不被误判成括号动作');

  audio.currentTime = 5;
  frameQueue.shift()();
  assert.ok(speech0.rendered[0].text.length > 0);

  coordinator.emit({ type: 'finished', task: t0 });
  assert.equal(b0.classList.contains('is-speaking'), false);
  assert.equal(b0.dataset.speaking, undefined);

  coordinator.emit({ type: 'started', task: t1 });
  assert.equal(b1.classList.contains('is-speaking'), true);
  assert.equal(b1.dataset.speaking, '1');

  coordinator.emit({ type: 'cancelled', task: t1 });
  assert.equal(b1.classList.contains('is-speaking'), false);
  assert.deepEqual(activeChanges.map(item => [item.turnId, item.beatIndex, item.active]), [
    ['turn_rp_1', 0, true],
    [null, null, false],
    ['turn_rp_1', 1, true],
    [null, null, false],
  ]);
  sync.destroy();

  // reduced-motion 下仍同步当前发声拍高亮，但跳过逐字动画
  const rmSync = createAudioTextSync({
    audio,
    coordinator,
    getBeatBubbleForTask: () => b0,
    getTargetsForTask: () => [[speech0]],
    matchMedia: () => ({ matches: true }),
    requestFrame: () => { throw new Error('no rAF under reduced motion'); },
  });
  coordinator.emit({ type: 'started', task: t0 });
  assert.equal(b0.classList.contains('is-speaking'), true);
  coordinator.emit({ type: 'finished', task: t0 });
  assert.equal(b0.classList.contains('is-speaking'), false);
  rmSync.destroy();
});
