import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pwaRoot = resolve(here, '..');
const THEME_IDS = ['moonlight', 'modernist', 'nocturne'];
// 合并后的月色 = 共享舞台版式 + 月色覆盖；保留共享 DOM 的既有合同。
async function cikeStageCss() {
  return (await readFile(resolve(pwaRoot, 'features/shell/stage.css'), 'utf8'))
    + '\n' + await readFile(resolve(pwaRoot, 'themes/moonlight/overrides.css'), 'utf8');
}

// 主题 token 块已拆进 pwa/themes/<id>/tokens.css；需要“整站样式”的断言把它们接在 styles.css 后面读。
async function readStylesWithThemes() {
  let css = await readFile(resolve(pwaRoot, 'styles.css'), 'utf8');
  for (const id of THEME_IDS) css += '\n' + await readFile(resolve(pwaRoot, `themes/${id}/tokens.css`), 'utf8');
  return css;
}

const REQUIRED_DOM_IDS = [
  'app', 'status', 'thinking', 'chat-scroll', 'chat-list',
  'compose-input', 'compose-send', 'audio', 'audioMusic',
  'sb-queue', 'conversation-sidebar', 'sidebar-close', 'room-list', 'settings-panel', 'cast-overlay',
  'player-cover', 'np-title', 'np-sub', 'np-album', 'player-line-text', 'player-line-next', 'waveform',
  'player-volume', 'np-duration',
  'toast-stack', 'recording-review-open', 'recording-review-panel',
];

test('conversation shell exposes the chat and persistent player controls', async () => {
  const html = await readFile(resolve(pwaRoot, 'index.html'), 'utf8');
  for (const id of REQUIRED_DOM_IDS) {
    assert.match(html, new RegExp(`id=["']${id}["']`), `missing #${id}`);
  }
  assert.doesNotMatch(html, /id=["']player-detail["']/, 'legacy lyrics/detail dialog must stay removed');
  assert.doesNotMatch(html, /id=["']listening-lyrics-open["']/, 'legacy lyrics/detail launcher must stay removed');
  // 参考稿版式：会话与伙伴入口在聊天列顶部的面包屑里（session-breadcrumb）。
  assert.match(html, /class=["']session-breadcrumb["'][\s\S]*id=["']player-source["']/, 'session breadcrumb must host the listening source link');
  assert.match(html, /class=["']source-label["']>伙伴</);
  assert.match(html, /id=["']radio-toggle["'][\s\S]{0,900}?class=["']radio-chev["']/, 'auto-continue toggle stays visible with its chevron');
  assert.doesNotMatch(html, /id=["']player-person["'][^>]*class=["'][^"']*person-avatar/, 'global player host must be labelled text, not a decorative avatar');
  assert.doesNotMatch(html, /id=["']player-person-name["']/, 'global player must not repeat the host name beside an avatar');
  // 底部通栏播放条：传输 / 进度 / 混音 / 待播 / 队列弹层。
  for (const id of ['queue-toggle', 'queue-pop', 'player-upcoming-count', 'episode-mixer', 'mixer-voice', 'mixer-bed']) {
    assert.match(html, new RegExp(`id=["']${id}["']`), `player bar is missing #${id}`);
  }
  assert.match(html, /id=["']sb-queue["'][\s\S]{0,200}?class=["']sb-queue["']|[\s\S]*id=["']sb-queue["']/);
  assert.match(html, /class=["']queue-pop["'][^>]*>[\s\S]*?id=["']sb-queue["']/, 'the queue list must live inside the queue popover');
  assert.match(html, /class=["']listening-hero["']/, 'listening hero is the anchor of the listening column');
  assert.match(html, /id=["']listening-hero["']/, 'listening hero must be addressable for visibility toggling');
  assert.match(html, /data-reactions/, 'like / dislike reactions must exist in the shell');
});

test('all themes share the concise voice preview label in profile and creation', async () => {
  const html = await readFile(resolve(pwaRoot, 'index.html'), 'utf8');
  for (const id of ['person-detail-listen', 'cast-preview']) {
    assert.match(html, new RegExp(`<button[^>]*id="${id}"[^>]*>声音试听</button>`), `#${id} uses the shared label`);
  }
  assert.doesNotMatch(html, /试听这把声音/);
});

test('all themes use an icon-only full-window entry and three companion presets', async () => {
  const html = await readFile(resolve(pwaRoot, 'index.html'), 'utf8');
  const entry = html.match(/<button id="focus-mode-enter"[\s\S]*?<\/button>/)?.[0] || '';
  assert.match(entry, /aria-label="全屏聆听"/);
  assert.match(entry, /title="全屏聆听"/);
  assert.match(entry, /<svg[^>]*aria-hidden="true"/);
  assert.doesNotMatch(entry, /<span|专注聆听/);
  const select = html.match(/<select id="companion-mode"[\s\S]*?<\/select>/)?.[0] || '';
  assert.equal((select.match(/<option/g) || []).length, 3);
  assert.match(select, /<option value="conversational" selected>多聊一点<\/option>/);
  assert.doesNotMatch(select, /未设置|沿用|value=""/);
});

test('song review is a manually opened, non-modal side panel instead of a sidebar list', async () => {
  const html = await readFile(resolve(pwaRoot, 'index.html'), 'utf8');
  const panelAt = html.indexOf('id="recording-review-panel"');
  assert.ok(panelAt > 0, 'the approved B panel must exist in the shell');
  const panelTag = html.slice(html.lastIndexOf('<', panelAt), html.indexOf('>', panelAt) + 1);
  assert.doesNotMatch(panelTag, /<dialog|aria-modal/, 'review must never be a modal');
  assert.match(panelTag, /\bhidden\b/, 'review stays collapsed until opened');
  assert.doesNotMatch(html, /recording-review["'].*sb-account-compact/, 'review must not live in the compact account area');
  // 入口与面板都是 #app 直接子级：不能塞进窄侧栏，也不能叠成第二个播放/聊天容器。
  assert.match(html, /<section id="recording-review-panel"[^>]*>/);
  assert.match(html, /<button id="recording-review-open"[^>]*aria-expanded="false"[^>]*aria-controls="recording-review-panel"/);
  const app = await readFile(resolve(pwaRoot, 'app.js'), 'utf8');
  assert.match(app, /m\.type === 'library-updated'\) void recordingReviewView\.handleServerEvent\(m\)/,
    'sync events refresh an open review without opening it');
  assert.doesNotMatch(app, /recordingReviewView\.show|recordingReview.*open\(\)[^;]*library-updated/);
});

test('D listening column pairs one cover with a readable introduction and three lyric lines', async () => {
  const html = await readFile(resolve(pwaRoot, 'index.html'), 'utf8');
  const css = await cikeStageCss();
  assert.equal((html.match(/id="listening-cover"/g) || []).length, 1);
  assert.match(html, /id="listening-hero"[^>]*role="region"[^>]*tabindex="0"/);
  assert.match(css, /grid-template-columns: 168px minmax\(0,1fr\)/);
  assert.match(css, /\.listening-intro p \{[^}]*overflow-y: auto/);
  for (const id of ['listening-clock','listening-company','listening-elapsed','listening-lyric-previous','listening-lyric','listening-lyric-next','listening-interlude','listening-next-queue']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
});

test('mentions are an inline listbox, not a permanent capsule row', async () => {
  const html = await readFile(resolve(pwaRoot,'index.html'),'utf8');
  const css = await readFile(resolve(pwaRoot,'features/conversations/conversations.css'),'utf8');
  assert.doesNotMatch(html,/compose-mentions/);
  assert.match(css,/\.compose-suggest\s*\{/);
  assert.match(css,/\.conversation-main \.compose #compose-send::after/);
  assert.doesNotMatch(css,/\.conversation-main \.compose button::after/);
});

test('D shell has a 220px sidebar and one full-width 76px transport bar', async () => {
  const html = await readFile(resolve(pwaRoot, 'index.html'), 'utf8');
  const css = await cikeStageCss();
  const shared = await readFile(resolve(pwaRoot, 'features/conversations/conversations.css'), 'utf8');
  assert.match(css, /--room-sidebar-width: 220px/);
  // 播放条只有一档高度：舞台版式跟随基础版式的 --studio-player-height，不再单独加高。
  assert.match(shared, /--studio-player-height: 76px/);
  assert.match(css, /--studio-player-height: 76px/);
  assert.match(shared, /\.persistent-player \{[\s\S]*?grid-column:\s*1 \/ -1;[\s\S]*?grid-row:\s*2;/);
  assert.match(css, /\.persistent-player \{[^}]*min-height: var\(--studio-player-height\)/);
  // 圆按钮必须是正圆：基础版式带 min-height: 48px，舞台版式只写 width/height 会拉成竖椭圆。
  assert.match(css, /\.persistent-player \.play-btn \{[^}]*width: 44px; height: 44px; min-height: 44px;/);
  assert.equal((html.match(/class="persistent-player"/g)||[]).length, 1);
  assert.match(css, /\.persistent-player \.player-waveform \{[^}]*pointer-events: none/);
  assert.match(shared, /\.persistent-player \.queue-pop \{[^}]*position:\s*absolute/);
  assert.match(shared, /\.persistent-player \.sb-status-row \{[^}]*position:\s*absolute/);
  // Keep the native traffic-light boundary on collapsed navigation.
  assert.match(shared, /\.conversation-sidebar:not\(\.expanded\)::after \{[^}]*top:\s*var\(--rail-line-top,\s*40px\)/);
});

test('D focus keeps one exit, the same media and player, a quote and a 4px lyric rule', async () => {
  const html = await readFile(resolve(pwaRoot, 'index.html'), 'utf8');
  const shared = await readFile(resolve(pwaRoot, 'features/conversations/conversations.css'), 'utf8');
  const css = await cikeStageCss();
  for (const id of ['audio','audioMusic','player-cover','np-title','np-sub','np-album','player-source','player-person',
    'player-line-text','player-line-next','player-previous','big-play','skip-btn','progress-bar','player-volume',
    'np-duration','waveform','focus-player-recommendation','focus-player-recommendation-text',
    'focus-player-recommendation-source','radio-toggle','continuation-retry','focus-mode-chat',
    'player-volume-slider','episode-mixer','focus-stage','focus-clock','focus-next-track']) {
    assert.equal((html.match(new RegExp(`id="${id}"`, 'g'))||[]).length, 1, `exactly one #${id}`);
  }
  assert.equal((html.match(/id="focus-mode-(?:chat|exit)"/g)||[]).length, 1);
  for (const selector of ['listening-panel','chat-scroll','compose']) {
    assert.match(shared, new RegExp(`#app\\.focus-mode [^{]*\\.${selector}[^{]*\\{ display: none !important; \\}`));
  }
  // 专注聆听整屏只留舞台与播放条：侧栏收起（theme-cike-design-parity 用户确认）。
  assert.match(css, /#app\.focus-mode \.conversation-sidebar \{ display: none !important/);
  assert.match(css, /#focus-clock \{ font: 400 96px\/.9/);
  assert.match(css, /grid-template-columns: 300px minmax\(0,1fr\); gap: 72px/);
  assert.match(css, /\.focus-player-recommendation:not\(\[hidden\]\) \{[^}]*border-radius: 18px/);
  assert.ok(css.includes("content: '\\201C'"), 'recommendation uses a quote, not a lyric rule');
  assert.match(css, /\.player-line-viewport:has\(\.lyric\):not\(\.next\) \{ border-left: 4px solid/);
  assert.match(css, /\.player-line-text\.lyric \{[^}]*36px/);
  assert.match(css, /\.player-line-text\.next \{[^}]*20px/);
  const footer = html.indexOf('class="persistent-player"');
  assert.ok(html.indexOf('id="episode-mixer"') > footer);
  assert.ok(html.indexOf('id="player-upcoming"') > footer);
  assert.ok(html.indexOf('id="focus-player-recommendation"') > html.indexOf('id="focus-stage"'));
});

test('player boundary fixes: integrated panel door, chat-focus strip', async () => {
  const html = await readFile(resolve(pwaRoot, 'index.html'), 'utf8');
  const css = await readFile(resolve(pwaRoot, 'features/conversations/conversations.css'), 'utf8');
  const doors = await readFile(resolve(pwaRoot, 'features/shell/panelDoors.css'), 'utf8');
  const shell = await readFile(resolve(pwaRoot, 'features/conversations/listeningShellController.js'), 'utf8');
  // 把手归面板外壳，不是应用级悬浮节点；内层面板仍负责裁切/滚动。
  assert.match(html, /id="listening-door">\s*<section class="listening-panel"/);
  assert.match(html, /id="chat-door">\s*<main class="conversation-main"[\s\S]*?<\/main>[\s\S]*?id="chat-focus-toggle"[\s\S]*?<\/button>\s*<\/div>/);
  assert.equal((html.match(/id="chat-focus-toggle"/g) || []).length, 1);
  assert.match(doors, /isolation: isolate;/);
  // 门框边线需画在内层 main（z-index:1）及不透明 compose 之上，不能在输入区断开。
  assert.match(doors, /\.panel-door:has\(> \.chat-focus-toggle\)::after \{[^}]*z-index: 2;/);
  assert.match(doors, /\.panel-door:has\(> \.chat-focus-toggle\) \{ z-index: 2; \}/);
  assert.match(doors, /\.listening-door > \.chat-focus-toggle \{\s*left: 100%;/);
  // 凸部与门框边线必须重叠焊接（多盖一个线宽），不允许出现接缝缺口。
  assert.match(doors, /width: calc\(var\(--door-tab-width\) \+ var\(--door-line-width\)\);/);
  assert.match(doors, /left: calc\(100% - var\(--door-line-width\)\);/);
  assert.match(doors, /#app:is\(\.settings-open, \.today-open, \.person-page\) > \.panel-door/);
  assert.match(shell, /owner\.appendChild\(toggle\)/);
  assert.doesNotMatch(shell, /syncChatFocusTogglePosition|toggle\.style\.(left|top)|shellClassObserver/);
  // 聊天聚焦态：听歌列收成竖向封面条，底部播放条保持通栏。
  assert.match(css, /#app\.chat-focus \{ grid-template-columns: var\(--room-sidebar-width\) minmax\(220px, 248px\) minmax\(0, 1fr\); \}/);
  // 收起态保留完整信息：旁白可见（填住中部），只收起反应与页眉。
  assert.match(css, /#app\.chat-focus \.listening-narration \{ margin-top: 2px; min-height: 0; overflow: hidden; \}/);
  assert.match(css, /#app\.chat-focus \.listening-reactions,[\s\S]{0,200}?display: none;/);
  // 「展开听歌区」按钮已删除：推拉门把手是唯一开合入口，工作台页与专注态都隐藏把手。
  assert.doesNotMatch(html, /id=["']chat-focus-exit["']/);
  assert.doesNotMatch(css, /chat-focus-exit/);
});

test('storage contract exports the existing Lunara keys', async () => {
  const { STORAGE_KEYS } = await import('./storageKeys.js');
  assert.deepEqual(STORAGE_KEYS, {
    artworkTheme: 'lunara.artworkTheme',
    bootDone: 'lunara.bootDone',
    firstRunRequestId: 'lunara.firstRun.requestId',
    firstRunCompleted: 'lunara.firstRun.completed',
    outcomeQueue: 'outcomeQueue',
    sidebarWidth: 'lunara.sidebarWidth',
    todayListWidth: 'lunara.todayListWidth',
    theme: 'lunara.theme',
    modernistBase: 'lunara.modernistBase',
    nocturneMaterial: 'lunara.nocturneMaterial',
    layoutOverride: 'lunara.dev.layout',
    trayText: 'lunara.tray.text',
  });
});

test('playback and virtual-person session projections share one authoritative app state', async () => {
  const { createAppState, reduceServerMessage } = await import('./appState.js');
  const store = createAppState({
    queue: [],
    cursor: -1,
    activeRadiohost: null,
    virtualPersons: [
      { id: 'lunara', displayName: 'Lunara', kind: 'root' },
      { id: 'radiohost-b', displayName: 'Luna', kind: 'radiohost' },
    ],
    sessionId: 'conversation:primary',
  });
  const seen = [];
  const unsubscribe = store.subscribe(next => seen.push(next));

  reduceServerMessage(store, {
    type: 'queue-update',
    queue: [{ kind: 'track', song_id: '1', title: 'A', artist: 'B', url: '/a.mp3' }],
    cursor: 0,
  });
  reduceServerMessage(store, {
    type: 'RADIOHOST_ACTIVATED',
    conversationId: 'conversation:primary',
    payload: { active: { id: 'radiohost-b', name: 'Luna' } },
  });

  const snapshot = store.getState();
  assert.equal(snapshot.queue.length, 1);
  assert.equal(snapshot.cursor, 0);
  assert.deepEqual(snapshot.activeRadiohost, { id: 'radiohost-b', name: 'Luna' });
  assert.equal(snapshot.sessionId, 'conversation:primary');
  assert.equal(snapshot.virtualPersons.length, 2);
  assert.equal(seen.length, 2);
  assert.strictEqual(seen.at(-1), snapshot);
  unsubscribe();
});

test('PWA uses server transcripts for each room and never restores old per-radiohost local chats', async () => {
  const app = await readFile(resolve(pwaRoot, 'app.js'), 'utf8');
  const controller = await readFile(resolve(pwaRoot, 'features/conversations/conversationController.js'), 'utf8');
  assert.match(app, /createConversationController/);
  assert.match(controller, /encodeURIComponent\(sid\).*turns/);
  assert.match(controller, /sessionId: sid/);
  assert.doesNotMatch(app, /chatPersistence|lunara_chats|lunara_active_dj/);
});

const STUDIO_SURFACE_TOKENS = [
  '--studio-line', '--studio-panel', '--studio-accent',
  '--studio-surface', '--studio-scrim', '--studio-shadow',
  '--studio-radius', '--studio-field-radius',
];

function ruleBody(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return css.match(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\n\\}`))?.[1] || '';
}

function nearestSelector(css, matchIndex) {
  const open = css.lastIndexOf('{', matchIndex);
  if (open === -1) return '';
  const prevClose = css.lastIndexOf('}', open);
  return css.slice(prevClose + 1, open).trim();
}

test('the studio surface tokens are defined once and consumed by every overlay surface', async () => {
  const styles = await readFile(resolve(pwaRoot, 'styles.css'), 'utf8');
  const conversations = await readFile(resolve(pwaRoot, 'features/conversations/conversations.css'), 'utf8');
  for (const token of STUDIO_SURFACE_TOKENS) {
    // 根定义唯一：所有弹层与 shell 共享同一 studio 表面语言，防止各自漂移。
    const styleDefs = [...styles.matchAll(new RegExp(`^[ \\t]*${token}:`, 'gm'))];
    const rootDefs = styleDefs.filter(m => /:root/.test(nearestSelector(styles, m.index)));
    assert.equal(rootDefs.length, 1,
      `${token} must be defined exactly once at :root in styles.css so overlays and the shell cannot drift`);
    // 唯一允许的例外：今日工作台浅色瓷面作用域（#app.today-open）内的主题化翻转。
    for (const m of styleDefs) {
      assert.match(nearestSelector(styles, m.index), /:root|today/i,
        `${token} redefinitions in styles.css are only allowed inside the today light scope`);
    }
    for (const m of conversations.matchAll(new RegExp(`^[ \\t]*${token}:`, 'gm'))) {
      assert.match(nearestSelector(conversations, m.index), /today/i,
        `${token} redefinitions in conversations.css are only allowed inside the today light scope`);
    }
  }
  for (const [file, selector] of [
    [styles, '.qr-card'],
    [styles, '.cast-card'],
    [conversations, '.salon-dialog'],
  ]) {
    const body = ruleBody(file, selector);
    assert.match(body, /var\(--studio-surface\)/, `${selector} must use the shared studio surface`);
    assert.match(body, /var\(--studio-line\)/, `${selector} must use the shared studio border`);
  }
});

test('shared user memory is inline in settings rather than a hidden sidebar dialog', async () => {
  const html = await readFile(resolve(pwaRoot, 'index.html'), 'utf8');
  const memoryPage = html.slice(html.indexOf('<section class="settings-page memory-settings"'), html.indexOf('<section class="settings-page" data-settings-page="connection"'));
  assert.match(memoryPage, /data-settings-page="memory"/);
  assert.match(memoryPage, /私人关系记忆/);
  for (const id of ['mem-input', 'mem-tags', 'mem-search', 'mem-list', 'mem-status', 'mem-retry']) {
    assert.equal(html.split(`id="${id}"`).length - 1, 1, `${id} must be mounted once`);
    assert.ok(memoryPage.includes(`id="${id}"`), `${id} must live inside memory settings`);
  }
  assert.doesNotMatch(html, /id="mem-drawer"|id="sb-open-memory"/);
  const stage = await readFile(resolve(pwaRoot, 'features/shell/stage.css'), 'utf8');
  assert.match(stage, /@media \(max-width: 960px\)\s*\{\s*:root\[data-layout="stage"\] #app\.settings-open \{ grid-template-rows: minmax\(0,1fr\) auto; \}\s*:root\[data-layout="stage"\] #app\.settings-open \.persistent-player \{ display: grid !important;/);
});

test('overlay surfaces drop the legacy serif titles and decorative eyebrows', async () => {
  const html = await readFile(resolve(pwaRoot, 'index.html'), 'utf8');
  const styles = await readFile(resolve(pwaRoot, 'styles.css'), 'utf8');
  const conversations = await readFile(resolve(pwaRoot, 'features/conversations/conversations.css'), 'utf8');
  for (const legacy of ['dialog-eyebrow', 'cast-eyebrow', 'mem-eyebrow']) {
    assert.doesNotMatch(html, new RegExp(`class=["'][^"']*${legacy}`), `#${legacy} must stay removed from the overlays`);
    assert.doesNotMatch(styles, new RegExp(`\\.${legacy}\\b`), `.${legacy} must not be styled again`);
    assert.doesNotMatch(conversations, new RegExp(`\\.${legacy}\\b`), `.${legacy} must not be styled again`);
  }
  for (const selector of ['.cast-title', '.settings-page-title', '.boot-title']) {
    assert.doesNotMatch(ruleBody(styles, selector), /background-clip:\s*text/,
      `${selector} must not use the legacy gradient text treatment`);
  }
});

test('shell pages share the session page header and surface vocabulary', async () => {
  const html = await readFile(resolve(pwaRoot, 'index.html'), 'utf8');
  const styles = await readFile(resolve(pwaRoot, 'styles.css'), 'utf8');
  const conversations = await readFile(resolve(pwaRoot, 'features/conversations/conversations.css'), 'utf8');
  const todayCss = await readFile(resolve(pwaRoot, 'features/today/today.css'), 'utf8');
  const todayView = await readFile(resolve(pwaRoot, 'features/today/todayView.js'), 'utf8');

  // 页眉同参：共享标题类必须与 .chat-heading 逐项一致，页面不允许再自定字阶。
  const chatTitle = ruleBody(conversations, '.chat-heading');
  const shellTitle = ruleBody(styles, '.shell-page-title');
  for (const fragment of ['clamp(19px, 1.7vw, 23px)', 'letter-spacing: .04em', 'text-shadow: var(--text-lift)']) {
    assert.ok(chatTitle.includes(fragment), `.chat-heading lost ${fragment}; it is the unification baseline`);
    assert.ok(shellTitle.includes(fragment), `.shell-page-title must match .chat-heading on ${fragment}`);
  }
  assert.match(ruleBody(styles, '.shell-page-head'), /padding: var\(--page-top, 20px\) var\(--page-edge, 34px\) 12px/);

  // 页面级主按钮 token：单点定义，.listen-together 与 .shell-primary 同源。
  for (const token of ['--studio-primary-bg', '--studio-primary-bg-hover', '--studio-primary-border', '--studio-primary-radius', '--studio-card-radius']) {
    const defs = [...styles.matchAll(new RegExp(`^[ \\t]*${token}:`, 'gm'))];
    assert.equal(defs.length, 1, `${token} must be defined exactly once in styles.css`);
    assert.match(nearestSelector(styles, defs[0].index), /:root/);
  }
  assert.match(ruleBody(conversations, '.listen-together'), /background: var\(--studio-primary-bg\)/,
    '.listen-together must consume the shared primary tokens');
  assert.match(ruleBody(styles, '.shell-primary'), /background: var\(--studio-primary-bg\)/,
    '.shell-primary must consume the shared primary tokens');
  assert.match(ruleBody(styles, '.boot-go'), /background: var\(--studio-primary-bg\)/,
    'settings save button must use the session primary treatment');
  assert.match(ruleBody(todayCss, '.today-panel .today-btn-primary'), /background: var\(--studio-primary-bg\)/);

  // 页面标记使用共享页眉；会话页没有的全大写眉标不得回来。
  assert.match(html, /settings-head shell-page-head/);
  assert.match(todayView, /today-header today-workspace-header shell-page-head/);
  // 写作优先：标题是正文级字号（stage 骨架与 today.css 的默认值都不再是展示级大字）。
  assert.match(todayCss, /input\.today-input-seamless-title \{[^}]*font-size: 18px;/);
  assert.match(todayCss, /\.today-panel \.today-split \{[^}]*cursor: col-resize;/);
  // 三轨布局：列表宽度由 --today-list-width 驱动，min() 给编辑器留保底宽度。
  assert.match(todayCss, /grid-template-columns: min\(var\(--today-list-width, 344px\), calc\(100% - 380px\)\) 12px minmax\(0, 1fr\);/);
  assert.match(todayView, /class="today-split" role="separator"/);
  // 时间轴：无时间的条目不再预留空时间列；快速添加是单行字段（高度容得下一行，不露滚动条）。
  const stageCss = await readFile(resolve(pwaRoot, 'features/shell/stage.css'), 'utf8');
  assert.match(stageCss, /\.today-entry\.is-untimed \.today-entry-main \{ grid-template-columns: 20px minmax\(0,1fr\); \}/);
  assert.match(stageCss, /\.today-entry\.is-untimed \.today-timeline-time \{ display: none; \}/);
  assert.match(stageCss, /\.today-quick-add textarea \{[^}]*height: 44px; min-height: 44px;/);
  for (const [name, text] of [['index.html', html], ['todayView.js', todayView],
    ['conversations.css', conversations], ['today.css', todayCss], ['styles.css', styles]]) {
    assert.doesNotMatch(text, /today-eyebrow/, `${name} must not bring back the shell eyebrow`);
  }

  // 页面卡统一 studio 表面。
  for (const [name, css, selector] of [
    ['settings card', styles, '.settings-card'],
    ['today card', conversations, '.today-panel .today-fieldset'],
    ['today editor card', todayCss, '.today-panel .today-editor-card'],
  ]) {
    const body = ruleBody(css, selector);
    assert.match(body, /background: var\(--studio-panel\)/, `${name} must use the studio panel surface`);
    assert.match(body, /border-radius: var\(--studio-card-radius\)/, `${name} must use the shared card radius`);
    assert.doesNotMatch(body, /linear-gradient/, `${name} must not reintroduce an opaque gradient card`);
  }
});

test('every pwa stylesheet keeps balanced brackets so one typo cannot drop the rest of the file', async () => {
  const { readdir } = await import('node:fs/promises');
  const files = [];
  const walk = async dir => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith('.css')) files.push(path);
    }
  };
  await walk(pwaRoot);
  assert.ok(files.length >= 8, `expected the real stylesheet set, found ${files.length}`);
  for (const file of files) {
    const css = (await readFile(file, 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '');
    for (const [open, close, label] of [['{', '}', 'brace'], ['(', ')', 'paren']]) {
      const opens = [...css].filter(c => c === open).length;
      const closes = [...css].filter(c => c === close).length;
      assert.equal(opens, closes,
        `${file}: unbalanced ${label} (${opens} vs ${closes}); browsers drop the rest of the stylesheet`);
    }
  }
});

test('scene colour comes from the moonlight theme block and artwork colour stays opt-in', async () => {
  const styles = await readStylesWithThemes();
  const html = await readFile(resolve(pwaRoot, 'index.html'), 'utf8');
  const controller = await readFile(resolve(pwaRoot, 'visuals/artworkThemeController.js'), 'utf8');

  const themeBlock = styles.match(/:root\[data-theme="moonlight"\]\s*\{([\s\S]*?)\n\}/)?.[1] || '';
  assert.match(themeBlock, /--theme-hue:\s*\d+/, 'the default theme must declare a numeric base hue');
  for (const token of ['--sky-glow-1-s', '--sky-base-l1', '--aurora-opacity', '--particle-glow', '--particle-drift', '--particle-count']) {
    assert.match(themeBlock, new RegExp(`${token}:`), `the theme block must own ${token}`);
  }
  assert.doesNotMatch(themeBlock, /188/, 'the default theme must not reuse the previous teal hue');
  assert.match(html, /<html[^>]*data-theme="nocturne"/, 'the document must declare the default theme');

  // 场景色相派生自主题，封面取色只做内联覆盖，不再写死回落色相
  assert.match(styles, /--ambient-hue:\s*var\(--theme-hue/, '--ambient-hue must derive from the theme');
  assert.doesNotMatch(controller, /FALLBACK_HUE/, 'the controller must not own a second default colour');
  assert.match(controller, /removeProperty\('--ambient-hue'\)/, 'disabling artwork colour must yield to the theme base');
  assert.match(controller, /STORAGE_KEYS\.artworkTheme\)\s*===\s*'1'/, 'artwork colour must default to off');

  // 强调色不再混入薄荷绿成功色，焦点环改用主题强调色
  const accentRule = styles.match(/--studio-accent:\s*([^;]+);/)?.[1] || '';
  assert.doesNotMatch(accentRule, /--pulse/, 'the moonlight accent must not be tinted towards the success colour');
  assert.match(styles, /--theme-accent-s/, 'the theme must own accent saturation');
  const conversations = await readFile(resolve(pwaRoot, 'features/conversations/conversations.css'), 'utf8');
  assert.match(conversations, /focus-visible[^}]*outline:\s*2px solid var\(--studio-accent\)/, 'focus rings must use the theme accent');

  // 调色板注入：辅色经回落链接入主题，玻璃洗底强度由各主题 token 决定
  assert.match(styles, /--ambient-hue-2:\s*calc\(var\(--ambient-hue\)/, 'the secondary hue must fall back to a theme-derived value');
  assert.match(controller, /--ambient-hue-2/, 'the controller must manage the secondary hue override');
  assert.match(conversations, /body::before[\s\S]*?opacity:\s*var\(--artwork-wash-opacity/, 'the artwork glass wash must be theme-tunable');
  assert.match(themeBlock, /--artwork-wash-opacity:/, 'the default theme must own the wash intensity tokens');
});

function themeBlock(css, id) {
  const pattern = id === 'moonlight'
    ? /:root,\s*\n:root\[data-theme="moonlight"\]\s*\{([\s\S]*?)\n\}/
    : new RegExp(`:root\\[data-theme="${id}"\\]\\s*\\{([\\s\\S]*?)\\n\\}`);
  return css.match(pattern)?.[1] || '';
}

test('every registered theme declares the complete token set so no theme leaks into another', async () => {
  const styles = await readStylesWithThemes();
  const { THEMES, DEFAULT_THEME } = await import('../visuals/themeController.js');
  assert.equal(DEFAULT_THEME, 'nocturne');
  assert.deepEqual([...THEMES], ['moonlight', 'modernist', 'nocturne']);

  const base = themeBlock(styles, 'moonlight');
  const baseTokens = [...base.matchAll(/(--[a-z0-9-]+):/g)].map(m => m[1]);
  assert.ok(baseTokens.length >= 20, `the default theme must own the full palette, saw ${baseTokens.length}`);

  for (const id of THEMES) {
    const body = themeBlock(styles, id);
    assert.ok(body, `missing theme block for ${id}`);
    for (const token of baseTokens) {
      assert.match(body, new RegExp(`${token}:`), `${id} must declare ${token}, otherwise moonlight's value leaks in`);
    }
    assert.match(body, /--theme-hue:\s*\d+/, `${id} needs a numeric base hue`);
  }

  const html = await readFile(resolve(pwaRoot, 'index.html'), 'utf8');
  const { getThemeManifest } = await import('../themes/registry.js');
  assert.match(html, /id="theme-choices"[^>]*role="radiogroup"/, 'settings must expose a theme chooser');
  // 色板来自各主题 theme.json，由 themeController 写进 --theme-swatch。
  for (const id of THEMES) assert.ok(getThemeManifest(id)?.swatch, `missing swatch for ${id}`);
});
