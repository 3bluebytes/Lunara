import assert from 'node:assert/strict';
import test from 'node:test';
import { createDesktopTrayBridge } from './desktopTrayBridge.js';

function fakeDesktop() {
  const published = [];
  let listener = null;
  return {
    published,
    emit(command) { listener?.(command); },
    subscribed: () => listener !== null,
    desktopLike: {
      tray: {
        isAvailable: true,
        publishState(state) { published.push(state); },
        onCommand(next) { listener = next; return () => { listener = null; }; },
      },
    },
  };
}

test('a browser without the desktop bridge simply gets no tray', () => {
  assert.equal(createDesktopTrayBridge({}), null);
  assert.equal(createDesktopTrayBridge({ desktopLike: {} }), null);
  assert.equal(createDesktopTrayBridge({ desktopLike: { tray: { publishState() {} } } }), null,
    '缺 onCommand 的半截桥也不当成可用');
});

test('tray commands land on the same transport functions as the buttons', () => {
  const desktop = fakeDesktop();
  const calls = [];
  createDesktopTrayBridge({
    desktopLike: desktop.desktopLike,
    handlers: { toggle: () => calls.push('toggle'), previous: () => calls.push('previous'), next: () => calls.push('next') },
  });
  desktop.emit('toggle');
  desktop.emit('previous');
  desktop.emit('next');
  desktop.emit('unknown-command');
  assert.deepEqual(calls, ['toggle', 'previous', 'next'], '未知命令丢弃，不猜动作');
});

test('publishing is deduplicated and stops after destroy', () => {
  const desktop = fakeDesktop();
  const bridge = createDesktopTrayBridge({ desktopLike: desktop.desktopLike, handlers: {} });
  assert.equal(bridge.publish({ title: 'A', artist: 'B', playing: true, canPrevious: false }), true);
  assert.equal(bridge.publish({ title: 'A', artist: 'B', playing: true, canPrevious: false }), false,
    '同一状态不重复过线');
  assert.equal(bridge.publish({ title: 'A', artist: 'B', playing: false, canPrevious: false }), true,
    '播放/暂停变化要过线');
  assert.equal(bridge.publish({ title: 'A', artist: 'B', playing: false, canPrevious: true }), true,
    '能否上一首变化要过线');
  assert.equal(desktop.published.length, 3);
  bridge.destroy();
  assert.equal(desktop.subscribed(), false, '销毁后取消订阅，迟到的托盘命令不再生效');
  bridge.destroy(); // 幂等
});

test('a throwing bridge never breaks playback', () => {
  const bridge = createDesktopTrayBridge({
    desktopLike: { tray: { publishState() { throw new Error('ipc gone'); }, onCommand: () => () => {} } },
    handlers: {},
  });
  assert.equal(bridge.publish({ title: 'A' }), false);
});

test('the lyric line and the text mode are part of what the tray receives', () => {
  const desktop = fakeDesktop();
  const bridge = createDesktopTrayBridge({ desktopLike: desktop.desktopLike, handlers: {} });
  const base = { title: 'Forever Love', artist: '王力宏', playing: true, canPrevious: false };
  assert.equal(bridge.publish({ ...base, textMode: 'lyrics', subtitle: '第一句' }), true);
  assert.equal(bridge.publish({ ...base, textMode: 'lyrics', subtitle: '第一句' }), false, '同状态去重');
  assert.equal(bridge.publish({ ...base, textMode: 'lyrics', subtitle: '第二句' }), true,
    '歌词换行必须过线，否则菜单栏会停在上一句');
  assert.equal(bridge.publish({ ...base, textMode: 'title', subtitle: '第二句' }), true,
    '切回曲名必须过线');
  assert.equal(desktop.published.length, 3);
  // 扫色进度：按 2 位小数去重，同一进度不重发，涨了才过线
  assert.equal(bridge.publish({ ...base, textMode: 'lyrics', subtitle: '第二句', subtitleProgress: 0.1, subtitleSpanMs: 4000 }), true);
  assert.equal(bridge.publish({ ...base, textMode: 'lyrics', subtitle: '第二句', subtitleProgress: 0.104, subtitleSpanMs: 4000 }), false);
  assert.equal(bridge.publish({ ...base, textMode: 'lyrics', subtitle: '第二句', subtitleProgress: 0.2, subtitleSpanMs: 4000 }), true,
    '进度前进要过线，否则扫色会停在旧位置');
  assert.equal(desktop.published.length, 5);
});
