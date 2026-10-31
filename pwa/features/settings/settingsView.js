import { STORAGE_KEYS } from '../../core/storageKeys.js';
import { escapeHtml } from '../chat/chatMarkup.js';
import { validateEndpointSelection } from './settingsController.js';
import { getTrayTextMode, setTrayTextMode } from '../playback/trayTextPreference.js';
import { createFreeVoiceSettings, FREE_EDGE_ENDPOINT_ID, FREE_EDGE_LABEL } from './freeVoiceSettings.js';
import { createRecipeSettings, guessProtocolChoice, parseProtocolChoice, protocolChoiceOf, RECIPE_PROTOCOL } from './recipeSettings.js';

// 设置面板的固定分类（与 index.html 的 data-settings-page 一一对应）。
const SETTINGS_PAGES = ['general', 'appearance', 'memory', 'connection', 'usage', 'voice', 'tags'];

export function initSettingsView({
  controller,
  storage,
  authController = null,
  onSourceLogin = () => {},
  onSourceLogout = async () => {},
  documentLike = globalThis.document,
  getActiveRadiohost = () => null,
  getMode = () => 'lobby',
  onSnapshot = () => {},
  onError = () => {},
  // 保存成功后的轻提示。页面里的内联 state 文字仍然保留（那里写着具体值），
  // toast 只负责回答「这次点下去到底存住了没有」。
  onToast = () => {},
  // 设置页每次打开都会触发：作息等独立分区在这里按需加载。
  onOpen = () => {},
  // 当前可见分类；关闭设置时为 null。独立分区据此按需加载。
  onSectionChange = () => {},
  onPreviewStart = () => {},
  // 面板从关闭变打开 / 从打开变关闭：壳层据此把设置当成一个页面来切换。
  onPageEnter = () => {},
  onPageLeave = () => {},
  createAudio = url => (typeof globalThis.Audio === 'function' ? new globalThis.Audio(url) : null),
} = {}) {
  const $ = selector => documentLike.querySelector(selector);
  const cleanups = [];
  let snapshot = controller.getSnapshot();
  let opening = false;
  // 打开设置页时按下的那个入口：关闭后把焦点还给它，而不是丢给 body。
  let pageOpener = null;
  let selection = { baseUrl: '', apiKey: '', model: '', source: null, primarySource: null, recommendationWeights: null };
  // 滑块的草稿与已保存值分开：拖动时不立刻打网络，保存时一次提交。
  let weightDraft = {};
  let accounts = null;
  let accountError = '';
  let accountBusy = false;
  let refreshingAccounts = false;
  // provider 就绪状态独立于 settings 快照。
  let ttsStatus = { providers: [] };
  // 自定义 TTS 接口：多个接口 + 统一声音池。customTts 是服务端视图（不含 key）；
  // currentEndpointId 是表单正在编辑的接口（NEW_ENDPOINT = 新增中、尚未保存）；
  // customDraft 是声音池草稿，每把声音记住所属接口与 model（可改名，默认源名称）。
  let customTts = { endpoints: [], voices: [], freeVoicesEnabled: false };
  let customLoaded = false; // 首次读到配置不算「刚开启免费声音」
  let currentEndpointId = '';
  let pendingRemoval = null; // 等待页内确认的接口 id
  // 声音池「加到哪个接口」：已保存的接口，或开启后的免费声音；与正在编辑的接口分开选。
  let poolSourceId = '';
  let customDraft = [];
  let discoveredModels = [];
  // 歌曲打标：只剩自动开关（模型跟随全局"使用中"，unified-model-providers）+ 覆盖率状态。
  let songTag = { auto: false };
  let songTagCoverage = null;
  // 待选名单的挑选辅助：筛选词、勾选集合与试听状态（几百个声音时按名筛选，
  // 先试听再批量去留）。勾选按 endpointId::sourceVoiceId 记，改名/重排/多接口同名都不会错位。
  let voiceFilter = '';
  const selectedVoiceIds = new Set();
  const previewUrls = new Map();
  let previewState = null; // { id, phase: 'loading' | 'playing' }
  let previewAudio = null;
  let previewGeneration = 0;
  // 发现结果：拉取到的声音先停在这里（标明来自哪个接口），勾选后才进声音池草稿，
  // 避免一次拉取几百个声音和已经挑好的混在一起。形状与声音池草稿相同。
  let candidateVoices = [];
  let candidateEndpointId = '';
  let candidateFilter = '';
  const selectedCandidates = new Set();
  // 设计声音（只对声明了 voiceDesign 的接口显示）：面板开合、伙伴列表（起草用，懒加载）
  // 与进行中的请求。生成、转正都会扣厂商额度，进行中禁用按钮，不自动重试。
  let designOpen = false;
  let designPersons = null;
  let designBusy = false;
  let activating = false;

  // 免费声音小节与代读卡：保存后的配置回到这里同步声音池视图，但不覆盖未保存的声音池草稿。
  const freeVoices = createFreeVoiceSettings({
    controller, documentLike,
    onConfig: config => { applyCustomConfig(config); renderCustomTts(); },
    onToast: message => onToast('success', '声音设置已保存', message),
  });
  cleanups.push(() => freeVoices.destroy());

  // 配方接口向导（千问/豆包预设、其他（让助手接入））：试合成通过、试听确认后才保存接口。
  // 协议选择器里用户手选过就不再按域名覆盖；切换/载入接口时按已保存的协议重新判断。
  let protocolTouched = false;
  let recipePresetsLoaded = false;
  const recipeSettings = createRecipeSettings({
    controller, documentLike,
    getChoice: () => parseProtocolChoice($('#tts-custom-protocol')?.value),
    getConnection: () => ({ ...readEndpointInputs(), endpointId: currentEndpointId === NEW_ENDPOINT ? '' : currentEndpointId }),
    getEndpoint: () => currentEndpoint(),
    onSave: saveRecipeEndpoint,
    // 卡片建议「改用 X」：等同于用户手选了协议。
    onSuggestChoice: choice => {
      setProtocolChoice(choice);
      protocolTouched = true;
      recipeSettings.reset({ fillDefaults: true });
      renderCustomTts();
      $('#tts-custom-protocol')?.focus?.({ preventScroll: true });
    },
    choiceLabel: value => Array.from($('#tts-custom-protocol')?.options || [])
      .find(option => option.value === value)?.textContent?.trim() || value,
  });
  cleanups.push(() => recipeSettings.destroy());

  function listen(element, type, listener) {
    // 测试注入的 documentLike 只有 querySelector；没有事件目标时安静跳过。
    if (typeof element?.addEventListener !== 'function') return;
    element.addEventListener(type, listener);
    cleanups.push(() => element.removeEventListener(type, listener));
  }

  // ---- 分类页导航：左侧列表 + 右侧页面，一次只显示一页 ----
  let activePage = 'connection';

  function setPage(pageId) {
    activePage = SETTINGS_PAGES.includes(pageId) ? pageId : 'connection';
    if (activePage !== 'voice') stopPreview();
    $('#settings-nav')?.querySelectorAll?.('[data-settings-page]')?.forEach(item => {
      if (!item) return;
      const active = item.dataset?.settingsPage === activePage;
      item.classList?.toggle?.('active', active);
      item.setAttribute?.('aria-current', active ? 'page' : 'false');
    });
    $('#settings-content')?.querySelectorAll?.('.settings-page')?.forEach(page => {
      if (page) page.hidden = page.dataset?.settingsPage !== activePage;
    });
    if (isOpen()) onSectionChange(activePage);
  }

  function renderSidebarMeta() {
    const current = snapshot.current || {};
    const llm = current.llm || {};
    const activeRadiohost = getActiveRadiohost();
    const radiohostName = activeRadiohost?.name || (getMode() === 'lobby' ? '大厅' : '—');
    $('#sb-meta-llm').textContent = llm.model || '未配置 LLM';
    const sourceLabel = current.playbackSourceMode === 'single' ? `单源 · ${current.primarySource || 'qq'}` : '多源播放';
    $('#sb-meta-source').textContent = `${radiohostName} · ${sourceLabel}`;
    $('#sb-meta-source-primary').textContent = sourceLabel;
    $('#sb-meta-llm').title = llm.ready ? llm.baseUrl : '请填写 Base URL / API Key / Model';
    $('#sb-meta-source').title = `伙伴: ${activeRadiohost?.voiceProfileId || radiohostName} | ${sourceLabel}`;
  }

  function validate() {
    const sources = snapshot.options?.source || [];
    const hasLlmInputs = Boolean($('#boot-llm-base-url'));
    let warning = '';
    let ready = sources.some(option => option.ready === true && option.id === selection.primarySource);
    if (hasLlmInputs) {
      const endpoint = validateEndpointSelection({
        ...selection,
        apiKeySet: snapshot.current?.llm?.apiKeySet,
      });
      if (!endpoint.ready) warning = '请完整填写 Base URL / API Key / Model；已保存过的 Key 可以留空。';
      ready = ready && endpoint.ready;
    }
    if (!ready && !warning) warning = '请先选择可用的播放源。';
    const warn = $('#boot-warn');
    if (warn) warn.textContent = warning;
    const go = $('#boot-go');
    if (go) go.disabled = !ready;
    return ready;
  }

  function renderSourceMode() {
    const single = selection.playbackSourceMode === 'single';
    const one = $('#single-source-settings');
    const many = $('#multi-source-settings');
    if (one) one.hidden = !single;
    if (many) many.hidden = single;
    const note = $('#source-mode-note');
    if (note) note.textContent = single
      ? '之后的选歌只用选定来源；不可用时不会自动换源。保存不打断当前歌曲，也不清空已有队列。'
      : '比例只影响推荐、发现与自动续选的候选，不保证实际播放比例；点名歌曲不按比例换歌。保存不打断当前歌曲。';
    documentLike.querySelectorAll?.('[name="playback-source-mode"]').forEach(input => {
      input.checked = input.value === selection.playbackSourceMode;
      input.closest?.('label')?.classList?.toggle('selected', input.checked);
    });
  }

  function renderSourceAccounts() {
    const host = $('#settings-source-accounts');
    if (!host) return;
    // 账号状态与来源选择独立，任何登录态通知都不能重新打开设置、重置草稿。
    host.innerHTML = (snapshot.options?.source || []).filter(option => option.ready === true).map(option => {
      const profile = accounts?.[option.id];
      const loggedIn = profile?.loggedIn === true;
      const status = loggedIn ? `已登录 · ${profile.nickname || '音乐账号'}`
        : profile ? (profile.cookieStored ? '登录待验证，可重新登录' : '未登录') : '登录状态未读取';
      return `<div class="source-account-row">
        <div class="source-account-copy"><strong>${escapeHtml(option.name)}</strong><span>${escapeHtml(status)}</span></div>
        <div class="source-account-actions">
          <button type="button" class="quiet-button" data-source-login="${escapeHtml(option.id)}"${accountBusy ? ' disabled' : ''}>${loggedIn || profile?.cookieStored ? '重新登录' : '登录'}${escapeHtml(option.name)}</button>
          ${loggedIn || profile?.cookieStored ? `<button type="button" class="quiet-button" data-source-logout="${escapeHtml(option.id)}"${accountBusy ? ' disabled' : ''}>退出${escapeHtml(option.name)}</button>` : ''}
        </div>
      </div>`;
    }).join('');
    const status = $('#settings-source-account-status');
    if (status) status.textContent = accountError || (accountBusy ? '正在退出账号…'
      : refreshingAccounts ? '正在读取登录状态…' : '登录状态与左下角「音乐源」同步；登录不切歌。');
  }

  async function refreshAccounts() {
    if (!authController) return;
    refreshingAccounts = true;
    accountError = '';
    renderSourceAccounts();
    try { accounts = await authController.refresh(); }
    catch { accountError = '登录状态暂时无法读取，可重新打开设置重试，或直接登录。'; }
    finally { refreshingAccounts = false; renderSourceAccounts(); }
  }

  if (authController?.subscribe) cleanups.push(authController.subscribe(next => {
    accounts = next;
    accountError = '';
    renderSourceAccounts();
  }));

  function renderOptions() {
    const baseUrl = $('#boot-llm-base-url');
    const apiKey = $('#boot-llm-api-key');
    const model = $('#boot-llm-model');
    if (baseUrl) baseUrl.value = selection.baseUrl;
    if (apiKey) {
      apiKey.value = selection.apiKey;
      apiKey.placeholder = snapshot.current?.llm?.apiKeySet ? '已保存（留空保持不变）' : '尚未配置';
    }
    if (model) model.value = selection.model;

    renderSourceAccounts();
    renderSourceMode();

    const primaryBox = $('#boot-primary');
    if (primaryBox) {
      // 默认播放源候选由服务端源注册表派生：只列可播源，目录源（仅跳转）不参与。
      // 这里不再维护一份独立名单，否则「注册表加了源但首启看不到」会再次成为静默缺口。
      const playable = (snapshot.options?.source || []).filter(option => option.ready === true);
      primaryBox.innerHTML = playable.map(option => `<option value="${escapeHtml(option.id)}">${escapeHtml(option.name)}</option>`).join('');
      primaryBox.value = selection.primarySource;
    }

    renderRecommendationWeights();
    renderTrayTextOptions();

    // 声音不在这里选：设置页的全局默认音色是遗留字段（当前所有合成调用都
    // 显式按伙伴绑定的 voiceProfileId，无人消费它），实际声线在创建伙伴面板
    // 按伙伴选择。这里只呈现 provider 就绪状态。
    renderTtsStatus();
  }

  /**
   * 状态栏（菜单栏）文字：只有桌面壳并且是 macOS 才有菜单栏文字，其它环境整张卡隐藏——
   * 不摆一个按不动的开关。改动立刻生效（播放器订阅了这个偏好），不需要保存设置。
   */
  function renderTrayTextOptions() {
    const card = $('#tray-text-card');
    const host = $('#tray-text-options');
    if (!card || !host) return;
    const desktop = globalThis.lunaraDesktop;
    const supported = desktop?.tray?.isAvailable === true && desktop?.platform === 'darwin';
    card.hidden = !supported;
    if (!supported) return;
    const current = getTrayTextMode();
    const options = [
      { id: 'title', name: '曲名', note: '安静、稳定，一眼知道在放什么' },
      { id: 'lyrics', name: '当前歌词', note: '跟着唱时看这一行；没有歌词时仍显示曲名' },
    ];
    host.innerHTML = options.map(option => `
      <button type="button" class="boot-opt ${option.id === current ? 'selected' : ''}" data-tray-text="${option.id}">
        <span class="boot-opt-radio"></span>
        <span class="boot-opt-meta">
          <span class="boot-opt-name">${option.name}</span>
          <span class="boot-opt-note">${option.note}</span>
        </span>
      </button>`).join('');
    host.querySelectorAll('[data-tray-text]').forEach(element => {
      element.addEventListener('click', () => {
        setTrayTextMode(element.dataset.trayText);
        renderTrayTextOptions();
      });
    });
  }

  /**
   * 推荐来源比例：只列可播源（目录源不占播放配额）。滑块是**相对比例**，
   * 右侧写归一后的百分比，让「70/30」与「7/3」看起来一样；同时显示近 7 天
   * 实际占比——只有目标看不到实际，用户调完不知道有没有生效。
   */
  function renderRecommendationWeights() {
    const host = $('#recommendation-weights');
    if (!host) return;
    const playable = (snapshot.options?.source || []).filter(option => option.ready === true);
    if (!playable.length) {
      host.innerHTML = '<p class="weight-empty">还没有可用的音乐源。登录后这里会出现比例滑块。</p>';
      return;
    }
    const total = playable.reduce((sum, option) => sum + Math.max(0, Number(weightDraft[option.id] ?? option.weight ?? 0) || 0), 0);
    host.innerHTML = playable.map((option, index) => {
      const raw = Math.max(0, Number(weightDraft[option.id] ?? option.weight ?? 0) || 0);
      const share = total > 0 ? Math.round((raw / total) * 100) : Math.round(100 / playable.length);
      const actual = typeof option.actualShare === 'number' ? `近 7 天实际 ${Math.round(option.actualShare * 100)}%` : '近 7 天还没有收听记录';
      const id = `weight-${option.id}`;
      return `<div class="weight-row">
        <label class="weight-name" for="${escapeHtml(id)}">${escapeHtml(option.name)}</label>
        <input id="${escapeHtml(id)}" type="range" min="0" max="100" step="1" value="${share}"
          aria-label="${escapeHtml(option.name)} 的推荐比例" data-weight="${escapeHtml(option.id)}">
        <span class="weight-value"><strong data-weight-target="${escapeHtml(option.id)}">目标 ${share}%</strong><small>${escapeHtml(actual)}</small></span>
      </div>`;
    }).join('') + '<p class="weight-note">比例是候选目标，不是播放保证：来源不足或不可用时会由其他来源补足。切换单源不会丢失这里的比例。</p>';
    host.querySelectorAll('[data-weight]').forEach(input => {
      input.addEventListener('input', () => {
        // 调到 30% 就是 30%，剩余来源分配 70%。不替换拖动中的 input，保留指针与键盘焦点。
        const id = input.dataset.weight;
        const share = Math.max(0, Math.min(100, Number(input.value))) / 100;
        const others = playable.filter(option => option.id !== id);
        const rest = others.reduce((sum, option) => sum + Number(weightDraft[option.id] ?? option.weight ?? 0), 0);
        weightDraft[id] = others.length ? share : 1;
        for (const option of others) {
          weightDraft[option.id] = (1 - share) * (rest > 0 ? Number(weightDraft[option.id] ?? option.weight ?? 0) / rest : 1 / others.length);
        }
        for (const option of playable) {
          const percent = Math.round(weightDraft[option.id] * 100);
          const slider = host.querySelector(`[data-weight="${option.id}"]`);
          const label = host.querySelector(`[data-weight-target="${option.id}"]`);
          if (slider) slider.value = percent;
          if (label) label.textContent = `目标 ${percent}%`;
        }
      });
    });
  }

  // ---- 自定义 TTS 接口卡片 ----
  const CUSTOM_URL_PLACEHOLDER = {
    openai: 'https://tts.example.com/v1',
    minimax: 'https://api.minimax.cn',
    breeze: 'https://api.breeze.blue',
    recipe: 'https://api.vendor.com',
  };
  const CUSTOM_MODEL_PLACEHOLDER = {
    openai: '拉取或手填',
    minimax: '手填，如 speech-2.8-hd',
    breeze: '拉取或手填，如 breeze-tts-2',
    recipe: '按厂商文档手填',
  };
  const CUSTOM_NOTE = {
    openai: '合成走 {URL}/audio/speech；发现走 {URL}/models 与 {URL}/voices（后者非标准，没有就手动填 voice 名）。',
    minimax: 'URL 填主域名或文档里的完整接口地址均可（多余的 /v1、/t2a_v2 会自动纠正）。合成走 {URL}/v1/t2a_v2；声音列表走 {URL}/v1/get_voice；model 无列表接口，按官方文档手填（如 speech-2.8-hd）；快速克隆的声音在首次合成成功后才会出现。',
    breeze: 'URL 填主域名即可（多余的 /v1 会自动纠正）。合成走 {URL}/v1/text-to-speech/{voice}；模型走 {URL}/v1/models；声音列表取你的个人音色和当日热门中文音色。中文按 2 个计费单位/字计。',
    recipe: '配方接口按一份请求配方发请求：URL 填厂商的接口主地址（路径由配方决定），Key 只会替换进请求头。改地址、model 或配方都要重新试合成并试听确认才能保存。',
  };
  const CUSTOM_PROTOCOLS = Object.keys(CUSTOM_URL_PLACEHOLDER);

  const NEW_ENDPOINT = '__new__';
  const voiceKey = voice => `${voice.endpointId}::${voice.sourceVoiceId}`;
  const endpointById = id => customTts.endpoints.find(endpoint => endpoint.id === id) || null;
  const currentEndpoint = () => endpointById(currentEndpointId);
  const endpointLabel = id => (id === FREE_EDGE_ENDPOINT_ID ? FREE_EDGE_LABEL : endpointById(id)?.name || '未保存的接口');

  /** 协议以选择器的实时值为准（未保存的改动也算数），只在载入/切换接口时回填。 */
  function currentCustomProtocol() {
    const { protocol } = parseProtocolChoice($('#tts-custom-protocol')?.value);
    return CUSTOM_PROTOCOLS.includes(protocol) ? protocol : 'openai';
  }

  /** 把选择器设成某个值；预设已下架（选项不存在）时退回「其他」，配方 JSON 仍会回显。 */
  function setProtocolChoice(value) {
    const select = $('#tts-custom-protocol');
    if (!select) return;
    const options = select.options ? Array.from(select.options, option => option.value) : null;
    select.value = !options || options.includes(value) ? value : (parseProtocolChoice(value).protocol === RECIPE_PROTOCOL ? RECIPE_PROTOCOL : 'openai');
  }

  function renderCustomNote() {
    const note = $('#tts-custom-note');
    if (!note) return;
    note.textContent = CUSTOM_NOTE[currentCustomProtocol()] || '';
    note.hidden = false;
  }

  function visibleDraftVoices() {
    const needle = voiceFilter.trim().toLowerCase();
    if (!needle) return customDraft;
    return customDraft.filter(voice =>
      String(voice.displayName || '').toLowerCase().includes(needle)
      || String(voice.sourceVoiceId || '').toLowerCase().includes(needle)
      || endpointLabel(voice.endpointId).toLowerCase().includes(needle));
  }

  function matchesVoiceFilter(voice, filter) {
    const needle = filter.trim().toLowerCase();
    return !needle
      || String(voice.displayName || '').toLowerCase().includes(needle)
      || String(voice.sourceVoiceId || '').toLowerCase().includes(needle);
  }

  /** 接口按分组返回时（Breeze：我的 / 热门）的计数摘要；不分组的接口返回空串。 */
  function groupSummary(voices) {
    const personal = voices.filter(voice => voice.group === 'personal').length;
    const trending = voices.filter(voice => voice.group === 'trending').length;
    return personal || trending ? `我的 ${personal} · 热门 ${trending}` : '';
  }

  function visibleCandidates() {
    return candidateVoices.filter(voice => matchesVoiceFilter(voice, candidateFilter));
  }

  /** 发现结果面板：没有候选时整块隐藏；行只读，挑选靠勾选与试听。 */
  function renderCandidateRows() {
    const list = $('#tts-custom-candidate-list');
    if (!list) return;
    const rows = visibleCandidates();
    list.innerHTML = rows.length
      ? rows.map(voice => {
        const key = escapeHtml(voiceKey(voice));
        return `
        <div class="tts-custom-voice-row">
          <input type="checkbox" data-candidate-select="${key}"${selectedCandidates.has(voiceKey(voice)) ? ' checked' : ''} aria-label="选择 ${escapeHtml(voice.displayName)}">
          <span class="tts-custom-candidate-name">${escapeHtml(voice.displayName)}${voice.designed ? ' <span class="tts-custom-design-tag">设计</span>' : ''}${voice.group === 'personal' ? ' <span class="tts-custom-design-tag">我的</span>' : ''}</span>
          <span class="tts-custom-voice-id" title="${escapeHtml(voice.sourceVoiceId)}">${escapeHtml(voice.sourceVoiceId)}</span>
          ${previewButton(voice)}
        </div>`;
      }).join('')
      : `<span class="boot-model-note">没有匹配「${escapeHtml(candidateFilter.trim())}」的声音。</span>`;
  }

  function renderCandidateToolbar() {
    const visible = visibleCandidates();
    const selectedVisible = visible.filter(voice => selectedCandidates.has(voiceKey(voice)));
    const selectAll = $('#tts-custom-candidate-select-all');
    if (selectAll) {
      selectAll.checked = visible.length > 0 && selectedVisible.length === visible.length;
      const partial = selectedVisible.length > 0 && selectedVisible.length < visible.length;
      if ('indeterminate' in selectAll) selectAll.indeterminate = partial;
      selectAll.disabled = visible.length === 0;
    }
    const filter = $('#tts-custom-candidate-filter');
    if (filter && documentLike.activeElement !== filter) filter.value = candidateFilter;
    const count = $('#tts-custom-candidate-count');
    if (count) {
      count.textContent = selectedCandidates.size
        ? `已选 ${selectedCandidates.size} / 共 ${candidateVoices.length} 个`
        : `共 ${candidateVoices.length} 个`;
    }
    const add = $('#tts-custom-candidate-add');
    if (add) {
      add.disabled = selectedCandidates.size === 0 || activating;
      add.textContent = activating ? '转正中…'
        : selectedCandidates.size ? `加入声音池（${selectedCandidates.size}）` : '加入声音池';
    }
  }

  /** 声音池草稿相对已保存版本的改动数：新增、移除、改名或改 model 各算一处。 */
  function poolChangeCount() {
    const saved = new Map(customTts.voices.map(voice => [voiceKey(voice), voice]));
    let changes = 0;
    for (const voice of customDraft) {
      const before = saved.get(voiceKey(voice));
      if (!before) changes += 1;
      else if ((before.displayName || '') !== (voice.displayName || '') || (before.model || '') !== (voice.model || '')) changes += 1;
      saved.delete(voiceKey(voice));
    }
    return changes + saved.size;
  }

  /** 池下方的保存按钮与提示：有未保存改动时一直可见，避免删完忘记保存。 */
  function renderPoolSaveState() {
    const changes = poolChangeCount();
    const save = $('#tts-custom-save');
    if (save) {
      save.classList.toggle('dirty', changes > 0);
      save.textContent = changes ? `保存声音池（${changes} 处改动）` : '保存声音池';
    }
    const hint = $('#tts-custom-dirty');
    if (hint) {
      hint.hidden = changes === 0;
      hint.textContent = changes ? `声音池有 ${changes} 处未保存的改动，不保存的话关闭设置后会恢复原样。` : '';
    }
  }

  function renderCandidates() {
    const panel = $('#tts-custom-candidates');
    if (!panel) return;
    panel.hidden = candidateVoices.length === 0;
    if (panel.hidden) return;
    const title = $('#tts-custom-candidate-title');
    const groups = groupSummary(candidateVoices);
    if (title) title.textContent = `发现结果 · ${endpointLabel(candidateEndpointId)}${groups ? ` · ${groups}` : ''}`;
    renderCandidateRows();
    renderCandidateToolbar();
  }

  function clearCandidates() {
    candidateVoices = [];
    candidateEndpointId = '';
    candidateFilter = '';
    selectedCandidates.clear();
  }

  /**
   * 把勾选的发现结果加入声音池草稿（仍要点保存才生效），并从发现结果移走。
   * 设计候选先逐个转正（Breeze 保存为私人音色、MiniMax 做一次短合成），用转正后的
   * 永久 voice id 入池；转正失败的留在发现结果并说明原因。
   */
  async function addSelectedCandidates() {
    const picked = candidateVoices.filter(voice => selectedCandidates.has(voiceKey(voice)));
    if (!picked.length || activating) return;
    const known = new Set(customDraft.map(voiceKey));
    const settled = new Set();
    const failures = [];
    for (const voice of picked.filter(item => !item.designed)) {
      const { group: _group, ...entry } = voice;
      if (!known.has(voiceKey(voice))) customDraft.push(entry);
      settled.add(voiceKey(voice));
    }
    const designed = picked.filter(item => item.designed);
    if (designed.length) {
      activating = true;
      renderCustomTts();
      poolStatus(`正在转正 ${designed.length} 个设计候选…`);
      for (const voice of designed) {
        try {
          const { voiceId } = await controller.activateDesignedVoice({
            endpointId: voice.endpointId, generatedId: voice.designed.generatedId, name: voice.displayName,
            description: voice.designed.description, ...(voice.model ? { model: voice.model } : {}),
          });
          const { designed: _designed, ...rest } = voice;
          customDraft.push({ ...rest, sourceVoiceId: voiceId });
          settled.add(voiceKey(voice));
        } catch (error) {
          failures.push(`${voice.displayName}：${error.message}`);
        }
      }
      activating = false;
    }
    candidateVoices = candidateVoices.filter(voice => !settled.has(voiceKey(voice)));
    for (const key of settled) selectedCandidates.delete(key);
    renderCustomTts();
    const savedRemote = designed.length - failures.length;
    poolStatus([
      settled.size ? `已加入声音池 ${settled.size} 个；点下方「保存声音池」后生效。` : '',
      savedRemote ? `其中 ${savedRemote} 个设计的声音已在「${endpointLabel(designed[0].endpointId)}」账号里转正。` : '',
      failures.length ? `${failures.length} 个转正失败，留在发现结果：${failures.join('；')}` : '',
    ].filter(Boolean).join(''));
  }

  /** 行内试听按钮的文案与状态类：合成中禁用，播放中可点停止。 */
  function previewButton(voice) {
    const key = voiceKey(voice);
    const phase = previewState?.id === key ? previewState.phase : null;
    const label = phase === 'loading' ? '合成中…' : phase === 'playing' ? '停止' : '试听';
    const cls = ['tts-secondary', 'tts-row-button', 'tts-custom-preview-btn', phase === 'playing' ? 'playing' : '']
      .filter(Boolean).join(' ');
    return `<button type="button" class="${cls}" data-preview="${escapeHtml(key)}"
      aria-label="试听 ${escapeHtml(voice.displayName)}"${phase === 'loading' ? ' disabled' : ''}>${label}</button>`;
  }

  /** 行徽标：这把声音属于哪个接口、用哪个 model（声音没记 model 时显示接口默认）。 */
  function voiceSourceBadge(voice) {
    const model = voice.model || endpointById(voice.endpointId)?.model || '';
    return `${endpointLabel(voice.endpointId)}${model ? ` · ${model}` : ''}`;
  }

  function renderVoiceRows() {
    const editor = $('#tts-custom-voice-editor');
    const previousScrollTop = typeof editor.scrollTop === 'number' ? editor.scrollTop : 0;
    const rows = visibleDraftVoices();
    editor.innerHTML = rows.length
      ? rows.map(voice => {
        const key = escapeHtml(voiceKey(voice));
        const badge = escapeHtml(voiceSourceBadge(voice));
        return `
        <div class="tts-custom-voice-row">
          <input type="checkbox" data-select="${key}"${selectedVoiceIds.has(voiceKey(voice)) ? ' checked' : ''} aria-label="选择 ${escapeHtml(voice.displayName)}">
          <input type="text" value="${escapeHtml(voice.displayName)}" data-rename="${key}" aria-label="${escapeHtml(voice.sourceVoiceId)} 的显示名">
          <span class="tts-custom-voice-source" title="${badge}">${badge}</span>
          <span class="tts-custom-voice-id" title="${escapeHtml(voice.sourceVoiceId)}">${escapeHtml(voice.sourceVoiceId)}</span>
          ${previewButton(voice)}
          <button type="button" class="tts-secondary tts-row-button" data-remove="${key}" aria-label="移除 ${escapeHtml(voice.displayName)}">移除</button>
        </div>`;
      }).join('')
      : (customDraft.length
        ? `<span class="boot-model-note">没有匹配「${escapeHtml(voiceFilter.trim())}」的声音。</span>`
        : '<span class="boot-model-note">还没有保留声音：拉取或手动填入后，会出现在创建伙伴的声音选择里。</span>');
    // 重渲染后保持在列表里的阅读位置（几百行时勾选/改名不该跳回顶部）。
    if (typeof editor.scrollTop === 'number') editor.scrollTop = previousScrollTop;
  }

  /** 工具栏独立于行渲染：勾选只更新计数，不重建行，避免滚动位置与焦点丢失。 */
  function renderVoiceToolbar() {
    const toolbar = $('#tts-custom-voice-toolbar');
    if (!toolbar) return;
    toolbar.hidden = customDraft.length === 0;
    if (toolbar.hidden) return;
    const visible = visibleDraftVoices();
    const selectedVisible = visible.filter(voice => selectedVoiceIds.has(voiceKey(voice)));
    const selectAll = $('#tts-custom-select-all');
    if (selectAll) {
      selectAll.checked = visible.length > 0 && selectedVisible.length === visible.length;
      const partial = selectedVisible.length > 0 && selectedVisible.length < visible.length;
      if ('indeterminate' in selectAll) selectAll.indeterminate = partial;
      selectAll.disabled = visible.length === 0;
    }
    const filter = $('#tts-custom-voice-filter');
    if (filter && documentLike.activeElement !== filter) filter.value = voiceFilter;
    const count = $('#tts-custom-voice-count');
    if (count) {
      count.textContent = selectedVoiceIds.size
        ? `已选 ${selectedVoiceIds.size} / 共 ${customDraft.length} 个`
        : `共 ${customDraft.length} 个`;
    }
    const removeButton = $('#tts-custom-remove-selected');
    if (removeButton) {
      removeButton.disabled = selectedVoiceIds.size === 0;
      removeButton.textContent = selectedVoiceIds.size ? `移除所选（${selectedVoiceIds.size}）` : '移除所选';
    }
  }

  /** 协议在列表里的简称：取选择器选项文字的括号前部分（预设已下架时退回协议名）。 */
  function protocolShortLabel(endpoint) {
    const choice = protocolChoiceOf(endpoint);
    const text = Array.from($('#tts-custom-protocol')?.options || [])
      .find(option => option.value === choice)?.textContent?.trim() || '';
    return text.split('（')[0] || endpoint.protocol || '';
  }

  /** 表单与已保存的接口是否不同（key 填了新值、配方待试合成也算）。 */
  function editorDirty() {
    const endpoint = currentEndpoint();
    if (!endpoint) return false;
    const value = selector => String($(selector)?.value || '').trim();
    return value('#tts-custom-name') !== (endpoint.name || '')
      || value('#tts-custom-url') !== (endpoint.baseUrl || '')
      || value('#tts-custom-model') !== (endpoint.model || '')
      || Boolean(value('#tts-custom-key'))
      || ($('#tts-custom-protocol')?.value || '') !== protocolChoiceOf(endpoint)
      || Boolean(recipeSettings.pendingRecipe());
  }

  /** 左列：已保存的接口各一项；新增中的接口以「未保存」项出现在末尾。 */
  function renderEndpointList() {
    const list = $('#tts-custom-endpoint-list');
    if (!list) return;
    const savedCounts = new Map();
    for (const voice of customTts.voices) savedCounts.set(voice.endpointId, (savedCounts.get(voice.endpointId) || 0) + 1);
    const items = customTts.endpoints.map(endpoint => {
      const meta = endpoint.configured
        ? `${protocolShortLabel(endpoint)} · ${savedCounts.get(endpoint.id) || 0} 个声音`
        : `${protocolShortLabel(endpoint)} · 未配置完整`;
      return `<li><button type="button" class="tts-endpoint-item" data-endpoint-id="${escapeHtml(endpoint.id)}"`
        + ` aria-current="${endpoint.id === currentEndpointId}">`
        + `<span class="tts-endpoint-item-name">${escapeHtml(endpoint.name || endpoint.id)}</span>`
        + `<span class="tts-endpoint-item-meta">${escapeHtml(meta)}</span></button></li>`;
    });
    if (!currentEndpoint()) {
      const name = String($('#tts-custom-name')?.value || '').trim() || '新接口';
      items.push(`<li><button type="button" class="tts-endpoint-item" data-endpoint-id="${NEW_ENDPOINT}" data-new aria-current="true">`
        + `<span class="tts-endpoint-item-name">${escapeHtml(name)}</span>`
        + '<span class="tts-endpoint-item-meta">未保存</span></button></li>');
    }
    list.innerHTML = items.join('');
    const add = $('#tts-custom-endpoint-add');
    if (add) add.disabled = !currentEndpoint();
  }

  /** 右侧标题与状态：正在编辑哪个接口、改动是否已保存。 */
  function renderEditorHead() {
    const endpoint = currentEndpoint();
    const title = $('#tts-custom-editor-title');
    if (title) {
      title.textContent = endpoint
        ? `编辑「${endpoint.name || endpoint.id}」`
        : (customTts.endpoints.length ? '接入新接口' : '接入第一个语音接口');
    }
    const state = $('#tts-custom-editor-state');
    if (state) {
      const kind = !endpoint ? 'new' : (editorDirty() ? 'dirty' : 'saved');
      state.dataset.state = kind;
      state.textContent = { new: '未保存', dirty: '有未保存的修改', saved: '已保存' }[kind];
    }
    const remove = $('#tts-custom-endpoint-remove');
    if (remove) {
      remove.hidden = !endpoint && !customTts.endpoints.length;
      remove.textContent = endpoint ? '删除接口' : '放弃新增';
    }
  }

  /** 声音池的来源接口：只列已保存的接口；没有接口时禁用获取与手填。 */
  /** 可作为声音来源：已保存的接口；免费声音只在开启后可选。 */
  const isPoolSource = id => Boolean(endpointById(id)) || (id === FREE_EDGE_ENDPOINT_ID && customTts.freeVoicesEnabled);

  function renderPoolSource() {
    if (!isPoolSource(poolSourceId)) poolSourceId = currentEndpoint()?.id || customTts.endpoints[0]?.id || '';
    const select = $('#tts-pool-source');
    if (select) {
      const options = customTts.endpoints.map(endpoint =>
        `<option value="${escapeHtml(endpoint.id)}">${escapeHtml(endpoint.name || endpoint.id)}${endpoint.configured ? '' : '（未配置完整）'}</option>`);
      if (customTts.freeVoicesEnabled) options.push(`<option value="${FREE_EDGE_ENDPOINT_ID}">${escapeHtml(FREE_EDGE_LABEL)}</option>`);
      select.innerHTML = options.length ? options.join('') : '<option value="">先在上方保存一个接口</option>';
      select.value = poolSourceId;
      select.disabled = !options.length;
    }
    for (const selector of ['#tts-custom-voices-btn', '#tts-custom-manual-add']) {
      const button = $(selector);
      if (button) button.disabled = !poolSourceId;
    }
  }

  // ---- 所选接口的最近发声失败（只读本地记录）----
  const FAILURE_REASONS = {
    timeout: '超时', failed: '合成失败', 'credit-exhausted': '额度用尽', 'auth-failed': 'Key 无效或无权限',
    'rate-limited': '并发超限', busy: '厂商容量不足', 'not-configured': '接口未配置',
  };
  const FAILURE_PHASES = { queue: '卡在排队', request: '等厂商响应', 'retry-wait': '等待重试', read: '卡在接收音频' };
  let failures = { endpointId: '', rows: [], error: '', loading: false };
  let failuresToken = 0;
  const secondsText = value => `${(value / 1000).toFixed(1)} 秒`;
  const pad = value => String(value).padStart(2, '0');
  const failureTime = at => { const date = new Date(at); return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`; };

  function failureDetail(entry) {
    const parts = [];
    if (entry.elapsedMs != null) parts.push(`共 ${secondsText(entry.elapsedMs)}`);
    if (entry.queueMs) parts.push(`排队 ${secondsText(entry.queueMs)}`);
    // 早期记录没有 readMs，requestMs 里含接收音频，只能笼统写「请求」。
    if (entry.requestMs) parts.push(`${entry.readMs == null ? '请求' : '等响应'} ${secondsText(entry.requestMs)}`);
    if (entry.readMs) parts.push(`接收音频 ${secondsText(entry.readMs)}`);
    if (entry.retryWaitMs) parts.push(`重试等待 ${secondsText(entry.retryWaitMs)}`);
    if (entry.attempts > 1) parts.push(`尝试 ${entry.attempts} 次`);
    const errors = entry.statuses.filter(status => status >= 400);
    if (errors.length) parts.push(`HTTP ${[...new Set(errors)].map(status => `${status}×${errors.filter(item => item === status).length}`).join(' ')}`);
    return parts.join(' · ');
  }

  /** 摘要：按原因计数；超时多半卡在排队或接收音频时点明慢在哪一段。 */
  function failureSummary(rows) {
    const counts = new Map();
    for (const row of rows) counts.set(row.reason, (counts.get(row.reason) || 0) + 1);
    const text = [...counts].map(([reason, count]) => `${FAILURE_REASONS[reason] || reason} ${count}`).join('、');
    const timeouts = rows.filter(row => row.reason === 'timeout');
    const queued = timeouts.filter(row => row.phase === 'queue').length;
    const reading = timeouts.filter(row => row.phase === 'read').length;
    const hint = queued && queued * 2 >= timeouts.length
      ? `超时多半卡在排队（${queued}/${timeouts.length}）：同时要念的段落太多，在等本机前面的合成，厂商本身不一定慢。`
      : reading && reading * 2 >= timeouts.length
        ? `超时多半卡在接收音频（${reading}/${timeouts.length}）：厂商已经回应，音频没在时限内传完，段落越长越容易出现。` : '';
    return `最近 ${rows.length} 次：${text}。${hint}`;
  }

  function renderFailures() {
    const section = $('#tts-endpoint-failures');
    if (!section) return;
    const endpoint = currentEndpoint();
    section.hidden = !endpoint;
    if (!endpoint) return;
    if (failures.endpointId !== endpoint.id) void loadFailures(endpoint.id);
    const summary = $('#tts-endpoint-failures-summary');
    const list = $('#tts-endpoint-failures-list');
    const refresh = $('#tts-endpoint-failures-refresh');
    if (refresh) refresh.disabled = failures.loading;
    if (summary) {
      summary.textContent = failures.error ? `读取失败记录失败：${failures.error}`
        : failures.loading && !failures.rows.length ? '读取中…'
          : failures.rows.length ? failureSummary(failures.rows) : '还没有失败记录。';
    }
    if (list) {
      list.innerHTML = failures.rows.map(entry => `
        <li class="tts-endpoint-failure">
          <span class="tts-endpoint-failure-time">${escapeHtml(failureTime(entry.at))}</span>
          <span class="tts-endpoint-failure-reason">${escapeHtml(FAILURE_REASONS[entry.reason] || entry.reason)}${entry.phase ? ` · ${escapeHtml(FAILURE_PHASES[entry.phase] || entry.phase)}` : ''}${entry.fallbackEndpointId ? ` · 已由${escapeHtml(endpointLabel(entry.fallbackEndpointId))}代读` : ''}</span>
          <span class="tts-endpoint-failure-detail">${escapeHtml(failureDetail(entry))}</span>
        </li>`).join('');
    }
  }

  async function loadFailures(endpointId) {
    const token = ++failuresToken;
    failures = { endpointId, rows: failures.endpointId === endpointId ? failures.rows : [], error: '', loading: true };
    renderFailures();
    try {
      const rows = await controller.loadTtsFailures(endpointId);
      if (token === failuresToken) failures = { endpointId, rows, error: '', loading: false };
    } catch (error) {
      if (token === failuresToken) failures = { endpointId, rows: [], error: error.message, loading: false };
    }
    if (token === failuresToken) renderFailures();
  }

  function renderEndpointPanel() {
    renderEndpointList();
    renderEditorHead();
    renderPoolSource();
    renderFailures();
    const confirmBox = $('#tts-custom-remove-confirm');
    if (confirmBox) {
      confirmBox.hidden = !pendingRemoval;
      if (pendingRemoval) {
        const count = customDraft.filter(voice => voice.endpointId === pendingRemoval).length;
        const text = $('#tts-custom-remove-text');
        if (text) {
          text.textContent = `删除接口「${endpointLabel(pendingRemoval)}」会同时移除它名下的 ${count} 个保留声音；`
            + '已绑定这些声音的伙伴需要在创建伙伴面板重新选择声音。';
        }
      }
    }
  }

  /** 把某个接口的连接信息填进表单（切换接口、载入、保存后调用）。 */
  function fillEndpointForm() {
    const endpoint = currentEndpoint();
    setProtocolChoice(CUSTOM_PROTOCOLS.includes(endpoint?.protocol) ? protocolChoiceOf(endpoint) : 'openai');
    // 已保存的接口保留它的协议；新增中的接口可以按粘贴的地址预选。
    protocolTouched = Boolean(endpoint);
    const name = $('#tts-custom-name');
    if (name) name.value = endpoint?.name || '';
    const url = $('#tts-custom-url');
    if (url) url.value = endpoint?.baseUrl || '';
    const model = $('#tts-custom-model');
    if (model) model.value = endpoint?.model || '';
    const key = $('#tts-custom-key');
    if (key) key.value = '';
    discoveredModels = [];
    recipeSettings.reset();
  }

  /** 设计能力以已保存的接口为准；协议选择器改了还没保存时先不显示（避免按旧协议生成）。 */
  function currentDesignCapability() {
    const endpoint = currentEndpoint();
    if (!endpoint?.voiceDesign || endpoint.protocol !== currentCustomProtocol()) return null;
    return endpoint.voiceDesign;
  }

  function renderDesign() {
    const capability = currentDesignCapability();
    const toggle = $('#tts-custom-design-toggle');
    if (toggle) {
      toggle.hidden = !capability;
      toggle.setAttribute('aria-expanded', String(Boolean(capability && designOpen)));
    }
    const panel = $('#tts-custom-design');
    if (!panel) return;
    panel.hidden = !capability || !designOpen;
    if (panel.hidden) return;
    const count = $('#tts-custom-design-count');
    if (count) {
      const previous = Number.parseInt(count.value, 10) || 1;
      count.innerHTML = Array.from({ length: capability.maxCandidates }, (_, index) =>
        `<option value="${index + 1}">${index + 1} 个</option>`).join('');
      count.value = String(Math.min(previous, capability.maxCandidates));
      count.disabled = capability.maxCandidates <= 1;
    }
    const cost = $('#tts-custom-design-cost');
    if (cost) cost.textContent = capability.costNote || '';
    const person = $('#tts-custom-design-person');
    if (person && designPersons) {
      const selected = person.value;
      person.innerHTML = ['<option value="">选择伙伴…</option>', ...designPersons.map(item =>
        `<option value="${escapeHtml(item.id)}">${escapeHtml(item.displayName || item.id)}</option>`)].join('');
      person.value = selected;
    }
    const run = $('#tts-custom-design-run');
    if (run) {
      run.disabled = designBusy;
      run.textContent = designBusy ? '生成中…' : '生成候选';
    }
    const draft = $('#tts-custom-design-draft');
    if (draft) draft.disabled = designBusy || !designPersons?.length;
    renderDesignChars();
  }

  function renderDesignChars() {
    const chars = $('#tts-custom-design-chars');
    if (chars) chars.textContent = `${String($('#tts-custom-design-description')?.value || '').trim().length} / 500`;
  }

  async function toggleDesign(open = !designOpen) {
    designOpen = open;
    renderDesign();
    if (!designOpen || designPersons) return;
    try {
      designPersons = await controller.listPersons();
    } catch (error) {
      designPersons = [];
      customStatus(`读取伙伴列表失败：${error.message}；仍可手写描述。`);
    }
    renderDesign();
  }

  /** 按伙伴人设起草描述：结果只填进描述框给用户改，人设原文不会发给 TTS 厂商。 */
  async function draftDesignDescription() {
    const personId = String($('#tts-custom-design-person')?.value || '');
    if (!personId) { customStatus('先选一个伙伴，再从 TA 的人设起草。'); return; }
    designBusy = true;
    renderDesign();
    customStatus('正在根据人设起草音色描述…');
    try {
      const { description } = await controller.draftVoiceDescription(personId);
      const box = $('#tts-custom-design-description');
      if (box) box.value = description || '';
      const name = $('#tts-custom-design-name');
      const person = designPersons?.find(item => item.id === personId);
      if (name && !name.value.trim() && person?.displayName) name.value = person.displayName;
      customStatus(`已按「${person?.displayName || personId}」的人设起草，改到满意再生成；只有描述会发给厂商，人设原文不会发给 TTS 厂商。`);
    } catch (error) {
      customStatus(`起草失败：${error.message}`);
    } finally {
      designBusy = false;
      renderDesign();
    }
  }

  /** 生成设计候选：替换发现结果；候选带厂商样音，试听不再合成。 */
  async function runDesign() {
    const description = String($('#tts-custom-design-description')?.value || '').trim();
    if (description.length < 3) { customStatus('先写一段至少 3 个字的音色描述。'); return; }
    if (designBusy) return;
    designBusy = true;
    renderDesign();
    customStatus('正在生成候选（会扣厂商额度）…');
    try {
      const endpointId = await persistCurrentEndpoint();
      const count = Number.parseInt($('#tts-custom-design-count')?.value, 10) || 1;
      const { candidates = [] } = await controller.designCustomVoices({
        endpointId, description, previewText: String($('#tts-custom-design-preview')?.value || '').trim(), count,
      });
      const prefix = String($('#tts-custom-design-name')?.value || '').trim() || '设计的声音';
      clearCandidates();
      candidateEndpointId = endpointId;
      candidates.forEach((candidate, index) => {
        const name = candidates.length > 1 ? `${prefix} ${index + 1}` : prefix;
        const draft = { ...draftVoiceFor(endpointId, candidate.generatedId, name), designed: { generatedId: candidate.generatedId, description } };
        candidateVoices.push(draft);
        if (candidate.previewUrl) previewUrls.set(`${voiceKey(draft)}::${draft.model || ''}`, candidate.previewUrl);
      });
      renderCustomTts();
      customStatus(`生成了 ${candidates.length} 个候选，已放进发现结果：试听满意后勾选加入声音池（加入时会在「${endpointLabel(endpointId)}」账号里转正）。`);
    } catch (error) {
      customStatus(`生成失败：${error.message}`);
    } finally {
      designBusy = false;
      renderDesign();
    }
  }

  function renderCustomTts() {
    const url = $('#tts-custom-url');
    const key = $('#tts-custom-key');
    const model = $('#tts-custom-model');
    if (!url) return;
    renderEndpointPanel();
    url.placeholder = CUSTOM_URL_PLACEHOLDER[currentCustomProtocol()];
    if (model) model.placeholder = CUSTOM_MODEL_PLACEHOLDER[currentCustomProtocol()];
    renderCustomNote();
    key.placeholder = currentEndpoint()?.hasKey ? '已保存（留空保持不变）' : 'API key';
    $('#tts-custom-models-list').innerHTML = discoveredModels
      .map(item => `<option value="${escapeHtml(item)}"></option>`).join('');
    renderVoiceRows();
    renderVoiceToolbar();
    renderCandidates();
    renderPoolSaveState();
    renderDesign();
    // 配方接口没有模型列表接口：按文档手填。
    const modelsButton = $('#tts-custom-models-btn');
    if (modelsButton) modelsButton.hidden = currentCustomProtocol() === RECIPE_PROTOCOL;
    recipeSettings.render();
  }

  function customStatus(message) {
    const status = $('#tts-custom-status');
    if (status) status.textContent = message || '';
  }

  /** 声音池卡自己的结果行：获取、加入、试听、保存声音池的反馈都写在这里。 */
  function poolStatus(message) {
    const status = $('#tts-pool-status');
    if (status) status.textContent = message || '';
  }

  /** 表单 → 接口补丁。新增中的接口不带 id（服务端生成）；一个接口都没有时用 custom。 */
  function readEndpointInputs() {
    const id = currentEndpointId === NEW_ENDPOINT || !currentEndpointId
      ? (customTts.endpoints.length ? '' : 'custom')
      : currentEndpointId;
    return {
      ...(id ? { id } : {}),
      name: String($('#tts-custom-name')?.value || '').trim(),
      protocol: currentCustomProtocol(),
      baseUrl: $('#tts-custom-url').value.trim(),
      apiKey: $('#tts-custom-key').value.trim(),
      model: $('#tts-custom-model').value.trim(),
    };
  }

  /** 应用服务端返回的配置；声音池草稿只在 replaceDraft 时整体换成服务端版本。 */
  function applyCustomConfig(config, { replaceDraft = false, selectEndpoint = null } = {}) {
    const wasFree = customTts.freeVoicesEnabled;
    customTts = {
      endpoints: Array.isArray(config?.endpoints) ? config.endpoints : [],
      voices: Array.isArray(config?.voices) ? config.voices : [],
      freeVoicesEnabled: config?.fallback ? Boolean(config.fallback.freeVoicesEnabled) : wasFree,
    };
    // 刚开启免费声音：来源直接切过去，下一步点「获取声音列表」就是免费声音。
    if (!wasFree && customTts.freeVoicesEnabled && customLoaded) poolSourceId = FREE_EDGE_ENDPOINT_ID;
    customLoaded = true;
    freeVoices.apply(config);
    const wanted = selectEndpoint || (currentEndpointId === NEW_ENDPOINT ? NEW_ENDPOINT : currentEndpointId);
    currentEndpointId = wanted === NEW_ENDPOINT || endpointById(wanted) ? wanted : (customTts.endpoints[0]?.id || '');
    if (replaceDraft) customDraft = customTts.voices.map(voice => ({ ...voice }));
    const available = new Set(customDraft.map(voiceKey));
    for (const id of [...selectedVoiceIds]) {
      if (!available.has(id)) selectedVoiceIds.delete(id);
    }
  }

  async function refreshCustomTts() {
    if (!recipePresetsLoaded) {
      recipePresetsLoaded = true;
      void recipeSettings.loadPresets();
    }
    try {
      const config = await controller.loadCustomTtsConfig() || { endpoints: [], voices: [] };
      pendingRemoval = null;
      failures = { ...failures, endpointId: '' }; // 重新打开设置时失败记录也重新读
      applyCustomConfig(config, { replaceDraft: true, selectEndpoint: currentEndpointId === NEW_ENDPOINT ? null : currentEndpointId });
      fillEndpointForm();
      renderCustomTts();
    } catch (error) {
      customStatus(`读取自定义接口配置失败：${error.message}`);
    }
  }

  /** 只保存当前接口的连接信息（发现与试听前调用）；返回保存后的接口 id。 */
  async function persistCurrentEndpoint() {
    const config = await controller.saveCustomTtsConfig({ endpoint: readEndpointInputs() });
    applyCustomConfig(config, { selectEndpoint: config?.savedEndpointId });
    const key = $('#tts-custom-key');
    if (key) key.value = '';
    return currentEndpointId;
  }

  async function saveCustomTts() {
    const button = $('#tts-custom-save');
    if (button) button.disabled = true;
    try {
      // 只存声音池；上方接口表单里未保存的改动保持原样，由「保存接口」单独保存。
      const config = await controller.saveCustomTtsConfig({ voices: customDraft });
      applyCustomConfig(config, { replaceDraft: true });
      renderCustomTts();
      poolStatus(`声音池已保存：${customDraft.length} 个声音。创建伙伴时就能从这里挑。`);
      onToast('success', '声音池已保存', `${customDraft.length} 个保留声音已存住。`, { curated: true });
    } catch (error) {
      poolStatus(`保存失败：${error.message}`);
    } finally {
      if (button) button.disabled = false;
    }
  }

  /**
   * 配方向导确认后保存接口（服务端再核一次这份「地址 + 配方」刚通过试合成）。
   * 保存后把试合成用的音色填进手动添加框，按回车即可加入声音池。
   */
  async function saveRecipeEndpoint({ recipe, presetId, voice }) {
    const config = await controller.saveCustomTtsConfig({
      endpoint: { ...readEndpointInputs(), protocol: RECIPE_PROTOCOL, recipe, ...(presetId ? { presetId } : {}) },
    });
    applyCustomConfig(config, { selectEndpoint: config?.savedEndpointId });
    poolSourceId = currentEndpointId;
    fillEndpointForm();
    renderCustomTts();
    const manual = $('#tts-custom-manual');
    if (manual && voice) manual.value = voice;
    customStatus(`已保存接口「${endpointLabel(currentEndpointId)}」。`);
    poolStatus(`来源已切到「${endpointLabel(currentEndpointId)}」。${voice ? `按回车把「${voice}」加入声音池，` : ''}或点「获取声音列表」挑选更多声音。`);
    onToast('success', '接口已保存', `「${endpointLabel(currentEndpointId)}」试合成通过并已保存。`);
    manual?.focus?.({ preventScroll: true });
    return true;
  }

  /** 新增接口时按粘贴的地址预选协议（用户手选过就不动）。 */
  function onCustomUrlInput() {
    if (!protocolTouched) {
      const guess = guessProtocolChoice($('#tts-custom-url')?.value);
      const select = $('#tts-custom-protocol');
      if (guess && select && select.value !== guess) {
        setProtocolChoice(guess);
        recipeSettings.reset({ fillDefaults: true });
        renderCustomTts();
        return;
      }
    }
    recipeSettings.render();
  }

  /** 只保存当前接口的连接信息；声音池草稿原样保留，仍由池下方的按钮保存。 */
  async function saveEndpointOnly() {
    const button = $('#tts-custom-save-endpoint');
    if (button) button.disabled = true;
    try {
      // 配方协议下，新的或改过的配方只能在刚试合成通过后保存（D9）；保存成功的提示由 saveRecipeEndpoint 给出。
      if (currentCustomProtocol() === RECIPE_PROTOCOL) {
        const result = await recipeSettings.save();
        if (result.handled) {
          if (!result.saved && result.message) customStatus(result.message);
          return;
        }
      }
      await persistCurrentEndpoint();
      poolSourceId = currentEndpointId;
      fillEndpointForm();
      renderCustomTts();
      customStatus(`已保存接口「${endpointLabel(currentEndpointId)}」。${currentEndpoint()?.hasKey ? 'key 已配置；' : 'key 尚未配置；'}到下方声音池获取它的声音。`);
    } catch (error) {
      customStatus(`保存失败：${error.message}`);
    } finally {
      if (button) button.disabled = false;
    }
  }

  function switchEndpoint(id) {
    if (id === currentEndpointId) return;
    currentEndpointId = id === NEW_ENDPOINT || endpointById(id) ? id : (customTts.endpoints[0]?.id || '');
    if (currentEndpoint()) poolSourceId = currentEndpointId;
    pendingRemoval = null;
    fillEndpointForm();
    renderCustomTts();
    customStatus('');
  }

  function addEndpoint() {
    currentEndpointId = NEW_ENDPOINT;
    pendingRemoval = null;
    fillEndpointForm();
    renderCustomTts();
    customStatus('填写新接口的协议、URL 与 key 后保存；已有接口和它们的声音不受影响。');
    $('#tts-custom-name')?.focus?.();
  }

  function requestRemoveEndpoint() {
    if (currentEndpointId === NEW_ENDPOINT) {
      currentEndpointId = customTts.endpoints[0]?.id || '';
      fillEndpointForm();
      renderCustomTts();
      customStatus('已放弃新增的接口。');
      return;
    }
    if (!currentEndpoint()) return;
    pendingRemoval = currentEndpointId;
    renderCustomTts();
    $('#tts-custom-remove-no')?.focus?.();
  }

  /** 列表重建后把焦点放回当前项；没有接口时落在「接入新接口」。 */
  function focusCurrentEndpointItem() {
    const list = $('#tts-custom-endpoint-list');
    const item = list?.querySelector?.('[aria-current="true"]');
    (item || $('#tts-custom-endpoint-add'))?.focus?.();
  }

  function cancelRemoveEndpoint() {
    pendingRemoval = null;
    renderCustomTts();
    $('#tts-custom-endpoint-remove')?.focus?.();
  }

  async function confirmRemoveEndpoint() {
    const id = pendingRemoval;
    if (!id) return;
    const name = endpointLabel(id);
    try {
      const config = await controller.removeCustomTtsEndpoint(id);
      pendingRemoval = null;
      // 只丢掉被删接口的草稿声音，其他接口未保存的草稿改动保留。
      customDraft = customDraft.filter(voice => voice.endpointId !== id);
      if (candidateEndpointId === id) clearCandidates();
      applyCustomConfig(config, { selectEndpoint: config?.endpoints?.[0]?.id || '' });
      fillEndpointForm();
      renderCustomTts();
      customStatus(`已删除接口「${name}」及其 ${config?.removedVoices ?? 0} 个保留声音。`);
      focusCurrentEndpointItem();
    } catch (error) {
      customStatus(`删除失败：${error.message}`);
    }
  }

  // ---- 歌曲打标卡片 ----

  function songTagMessage(message) {
    const status = $('#song-tag-status');
    if (status) status.textContent = message || '';
  }

  function renderSongTagCoverage() {
    const node = $('#song-tag-coverage');
    if (!node) return;
    if (!songTagCoverage) { node.textContent = ''; return; }
    const coverage = songTagCoverage.coverage || {};
    const endpointText = songTagCoverage.activeModel
      ? `模型 ${songTagCoverage.activeModel.model}（跟随使用中）`
      : '未接入任何模型：只写歌词可判的免费字段，不调用 LLM';
    node.textContent = `候选池 ${songTagCoverage.candidatePool ?? 0} 首：已打标 ${coverage.tagged ?? 0}，占位 ${coverage.placeholders ?? 0}，未标 ${coverage.untagged ?? 0}；${endpointText}；自动补标${songTagCoverage.auto ? '开' : '关'}。`;
  }

  function renderSongTag() {
    const auto = $('#song-tag-auto');
    if (auto) auto.checked = Boolean(songTag.auto);
    renderSongTagCoverage();
  }

  async function refreshSongTag() {
    try {
      // 直接 await（不用 .catch 链、不用 Promise.all）：状态请求失败可容忍，
      // 但每个 await 都要在打开面板的同一轮微任务内完成，与 refreshCustomTts 的
      // 时序语义保持一致（渲染先于打开流程的后续断言/回调）。
      const config = await controller.loadSongTagConfig();
      let status = null;
      try { status = await controller.loadSongTagStatus(); } catch { status = null; }
      songTag = { auto: Boolean(config?.auto) };
      songTagCoverage = status;
      renderSongTag();
    } catch (error) {
      songTagMessage(`读取打标配置失败：${error.message}`);
    }
  }

  function readSongTagInputs() {
    return { auto: Boolean($('#song-tag-auto')?.checked) };
  }

  async function saveSongTag() {
    const button = $('#song-tag-save');
    if (button) button.disabled = true;
    try {
      songTag = await controller.saveSongTagConfig(readSongTagInputs());
      renderSongTag();
      songTagCoverage = await controller.loadSongTagStatus().catch(() => songTagCoverage);
      renderSongTagCoverage();
      songTagMessage('已保存。点“补全候选池标签”立即开始打标。');
      onToast('success', '打标设置已保存', songTag.auto
        ? '播放到新歌时会自动入队打标；补全需要手动触发。'
        : '已关闭自动补标；已经生成的标签保留。', { curated: true });
    } catch (error) {
      songTagMessage(`保存失败：${error.message}`);
    } finally {
      if (button) button.disabled = false;
    }
  }

  async function backfillSongTags() {
    const button = $('#song-tag-backfill');
    if (button) button.disabled = true;
    try {
      const result = await controller.runSongTagBackfill({ limit: 100 });
      songTagMessage(`已入队 ${result?.enqueued ?? 0} 首（候选 ${result?.candidatePool ?? 0}，跳过 ${result?.skipped ?? 0}）。打标在后台串行进行，重开设置即可看最新覆盖率。`);
      onToast('info', '已开始补全标签',
        `本次入队 ${result?.enqueued ?? 0} 首，后台串行打标，不影响播放。`, { curated: true });
    } catch (error) {
      songTagMessage(`补全失败：${error.message}`);
    } finally {
      if (button) button.disabled = false;
    }
  }

  async function discoverModels() {
    const button = $('#tts-custom-models-btn');
    if (button) button.disabled = true;
    try {
      // 先把当前接口的输入保存下来，发现请求用的是服务端存储的连接配置。
      const endpointId = await persistCurrentEndpoint();
      discoveredModels = await controller.discoverCustomModels(endpointId);
      const model = $('#tts-custom-model');
      if (model && !model.value.trim() && discoveredModels.length) model.value = discoveredModels[0];
      renderCustomTts();
      customStatus(discoveredModels.length ? `取到 ${discoveredModels.length} 个 model，已在 model 输入框给出下拉候选。` : '端点返回了空 model 列表。');
    } catch (error) {
      customStatus(error.message);
    } finally {
      if (button) button.disabled = false;
    }
  }

  /** 新加入声音池的声音记下来源接口与它已保存的 model（之后改接口默认 model 不影响它）。 */
  function draftVoiceFor(endpointId, sourceVoiceId, displayName) {
    const model = endpointId === FREE_EDGE_ENDPOINT_ID ? '' : (endpointById(endpointId)?.model || '');
    return { endpointId, sourceVoiceId, displayName: displayName || sourceVoiceId, ...(model ? { model } : {}) };
  }

  /** 拉取声音进发现结果；免费声音不是表单里的接口，不需要先保存连接信息。 */
  async function discoverVoices() {
    const button = $('#tts-custom-voices-btn');
    if (button) button.disabled = true;
    try {
      // 只用已保存的连接信息；上方表单里没保存的改动不会被这里悄悄存下。
      const endpointId = poolSourceId;
      if (!isPoolSource(endpointId)) { poolStatus('先在上方保存一个接口，再获取它的声音。'); return; }
      const unsavedNote = endpointId === currentEndpointId && editorDirty()
        ? '（用的是已保存的连接信息；上方表单的修改还没保存）' : '';
      const voices = await controller.discoverCustomVoices(endpointId);
      // 新一批替换上一批发现结果；已在声音池的不再列出。
      const kept = new Set(customDraft.map(voiceKey));
      const seen = new Set();
      clearCandidates();
      candidateEndpointId = endpointId;
      for (const voice of voices) {
        const draft = draftVoiceFor(endpointId, voice.id, voice.name);
        if (kept.has(voiceKey(draft)) || seen.has(voiceKey(draft))) continue;
        seen.add(voiceKey(draft));
        candidateVoices.push(voice.group ? { ...draft, group: voice.group } : draft);
      }
      const alreadyKept = voices.length - candidateVoices.length;
      renderCustomTts();
      // 发现结果紧挨在两个「获取」按钮下方；长页面里仍确保它进入视野，点了就看得到结果。
      if (candidateVoices.length) $('#tts-custom-candidates')?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
      const groups = groupSummary(voices);
      poolStatus((voices.length
        ? `从「${endpointLabel(endpointId)}」取到 ${voices.length} 个声音${groups ? `（${groups}）` : ''}${alreadyKept ? `，其中 ${alreadyKept} 个已在声音池` : ''}；`
          + (candidateVoices.length ? '在发现结果里试听、勾选后加入声音池。' : '没有新的声音。')
        : '端点返回了空声音列表。') + unsavedNote);
    } catch (error) {
      poolStatus(`${error.message}`);
    } finally {
      if (button) button.disabled = false;
    }
  }

  function addManualVoice() {
    const input = $('#tts-custom-manual');
    const id = String(input?.value || '').trim();
    if (!id) { poolStatus('请先填写 voice 名。'); return; }
    if (!isPoolSource(poolSourceId)) { poolStatus('先在上方保存一个接口，再给它加入声音。'); return; }
    const draft = draftVoiceFor(poolSourceId, id, id);
    if (customDraft.some(voice => voiceKey(voice) === voiceKey(draft))) { poolStatus('这个 voice 已经在声音池里。'); return; }
    customDraft.push(draft);
    if (input) input.value = '';
    renderCustomTts();
    poolStatus(`已加入声音池：${id}（${endpointLabel(poolSourceId)}）；点「保存声音池」后生效。`);
  }

  /** 从待选移除（单个移除与批量移除共用）；只改草稿，点保存才真正生效。 */
  function removeDraftVoices(keys) {
    const keySet = new Set(keys);
    if (!keySet.size) return;
    customDraft = customDraft.filter(voice => !keySet.has(voiceKey(voice)));
    for (const key of keySet) selectedVoiceIds.delete(key);
    renderCustomTts();
    poolStatus(`已从待选移除 ${keySet.size} 个声音；点下方「保存声音池」后生效。`);
  }

  function resetPreview(audio, message) {
    if (audio && previewAudio !== audio) return;
    previewAudio = null;
    const changed = previewState !== null;
    previewState = null;
    if (changed) renderCustomTts();
    if (message) poolStatus(message);
  }

  function startPreviewPlayback(key, url) {
    const audio = createAudio(url);
    if (!audio) { poolStatus('当前环境不支持音频播放。'); return; }
    previewAudio = audio;
    previewState = { id: key, phase: 'playing' };
    renderCustomTts();
    audio.addEventListener?.('ended', () => resetPreview(audio));
    audio.addEventListener?.('error', () => resetPreview(audio, '试听音频播放失败。'));
    Promise.resolve(audio.play?.()).catch(error => {
      resetPreview(audio, `试听播放失败：${error?.message || error}`);
    });
  }

  function stopPreview() {
    previewGeneration++;
    const audio = previewAudio;
    previewAudio = null;
    previewState = null;
    try { audio?.pause?.(); } catch { /* 已销毁的音频对象不影响流程 */ }
  }

  /**
   * 试听一把待选声音：按它所属的接口与 model 合成。同一把声音的音频在会话内缓存
   * （服务端磁盘也按接口+voice+文本缓存），重复点击不会重复请求端点。播放中再点是停止。
   */
  async function previewVoice(key) {
    const voice = customDraft.find(item => voiceKey(item) === String(key || ''))
      || candidateVoices.find(item => voiceKey(item) === String(key || ''));
    if (!voice) return;
    if (previewState?.id === key && previewState.phase === 'loading') return;
    if (previewState?.id === key && previewState.phase === 'playing') {
      stopPreview();
      renderCustomTts();
      return;
    }
    stopPreview();
    onPreviewStart();
    const generation = previewGeneration;
    const cacheKey = `${key}::${voice.model || ''}`;
    let url = previewUrls.get(cacheKey);
    if (!url) {
      previewState = { id: key, phase: 'loading' };
      renderCustomTts();
      try {
        // 试听用服务端已保存的连接配置；接口表单的未保存改动不会被试听悄悄存下。
        const result = await controller.previewCustomVoice({
          endpointId: voice.endpointId, voiceId: voice.sourceVoiceId, ...(voice.model ? { model: voice.model } : {}),
        });
        if (generation !== previewGeneration) return;
        if (!result?.url) throw new Error(result?.error || '试听没有返回音频');
        url = result.url;
        previewUrls.set(cacheKey, url);
      } catch (error) {
        if (generation !== previewGeneration) return;
        previewState = null;
        renderCustomTts();
        poolStatus(`试听失败：${error.message}`);
        return;
      }
    }
    startPreviewPlayback(key, url);
  }

  /**
   * provider 就绪情况随用户配置变化，每次打开时刷新。
   */
  function renderTtsStatus() {
    const providerBox = $('#boot-tts-providers');
    if (providerBox) {
      const providers = ttsStatus.providers || [];
      providerBox.innerHTML = providers.length
        ? providers.map(provider => {
          const state = provider.configured ? '就绪' : (provider.requiresCredentials ? '需要凭据' : '不可用');
          return `<span class="boot-provider ${provider.configured ? 'ready' : 'idle'}">${escapeHtml(provider.label || provider.id)} · ${escapeHtml(state)}</span>`;
        }).join('')
        : '<span class="boot-provider idle">状态未知</span>';
    }
  }

  async function refreshTtsStatus() {
    try {
      ttsStatus = await controller.loadTtsStatus();
    } catch (error) {
      ttsStatus = { providers: [], error: error.message };
    }
    renderTtsStatus();
    return ttsStatus;
  }

  /**
   * 位置设置：显示当前城市、来源（自动/手动）与解析出的完整地名。
   * 保存/自动定位/清除各自独立动作；成功后服务端广播 environment 事件，角标由监听器更新。
   */
  function renderLocation(noteText = '') {
    const input = $('#boot-location-input');
    const clearButton = $('#boot-location-clear');
    const note = $('#boot-location-note');
    const location = snapshot.current?.location || null;
    const sourceLabel = location?.source === 'auto' ? 'IP 自动定位' : '手动设置';
    if (input && documentLike.activeElement !== input) input.value = location?.cityName || '';
    if (clearButton) clearButton.hidden = !location;
    if (note) note.textContent = noteText || (location
      ? `当前：${location.resolvedName || location.cityName}（${sourceLabel}）。坐标仅用于向天气服务查询，且只保留城区级精度。`
      : '尚未定位。默认按 IP 自动定位城市，或手动填写后保存；手动城市会固定下来，不会被自动结果覆盖。');
  }

  async function saveLocation() {
    const input = $('#boot-location-input');
    const button = $('#boot-location-save');
    const city = String(input?.value || '').trim();
    if (!city) { renderLocation('请先填写城市名，或点「自动定位」。'); return; }
    if (button) button.disabled = true;
    try {
      const result = await controller.setLocation(city);
      renderLocation(`已手动固定：${result?.location?.resolvedName || city}（不会再被自动定位覆盖）。`);
      onToast('success', '位置已保存', `${result?.location?.resolvedName || city}，之后天气与作息都按它算。`, { curated: true });
    } catch (error) {
      renderLocation(error.message);
    } finally {
      if (button) button.disabled = false;
    }
  }

  async function autoDetectLocation() {
    const button = $('#boot-location-auto');
    if (button) button.disabled = true;
    try {
      const result = await controller.redetectLocation();
      renderLocation(`已按 IP 自动定位：${result?.location?.resolvedName || result?.location?.cityName || ''}。`);
      onToast('success', '已按 IP 定位',
        `${result?.location?.resolvedName || result?.location?.cityName || '当前城市'}；之后不会再被自动覆盖。`, { curated: true });
    } catch (error) {
      renderLocation(error.message);
    } finally {
      if (button) button.disabled = false;
    }
  }

  async function clearSavedLocation() {
    const button = $('#boot-location-clear');
    if (button) button.disabled = true;
    try {
      await controller.clearLocation();
      renderLocation('已清除位置。下次启动会重新按 IP 自动定位。');
      onToast('info', '位置已清除', '下次启动会重新按 IP 自动定位。', { curated: true });
    } catch (error) {
      renderLocation(error.message);
    } finally {
      if (button) button.disabled = false;
    }
  }

  function open() {
    // 壳层会在 notify 回来的同一轮再调一次 open：首次调用还没收尾，直接复用它的结果。
    if (opening) return;
    opening = true;
    try { renderOpen(); } finally { opening = false; }
  }

  function renderOpen() {
    const current = snapshot.current || {};
    // 壳层已经把设置当成当前页面切过来了：这时只渲染内容，不再反向导航（否则会递归）。
    const alreadyOpen = isOpen();
    selection = {
      baseUrl: current.llm?.baseUrl || '',
      apiKey: '',
      model: current.llm?.model || '',
      source: current.source,
      primarySource: current.primarySource || 'qq',
      recommendationWeights: current.recommendationWeights || null,
      playbackSourceMode: current.playbackSourceMode === 'single' ? 'single' : 'multi',
    };
    weightDraft = { ...(selection.recommendationWeights || {}) };
    renderOptions();
    validate();
    renderLocation();
    setPage(activePage);
    try { onOpen(); } catch { /* 分区加载失败不能挡住设置面板打开 */ }
    // provider 状态、模型状态与自定义接口配置都是异步的（且会变化），不阻塞面板打开。
    void refreshAccounts();
    void refreshTtsStatus();
    void refreshCustomTts();
    void refreshSongTag();
    // 壳层驱动的打开会让面板先可见：无论哪种入口都要记住入口，关闭后才能把焦点还回去。
    // （嵌套调用在 open() 开头就返回了，这里不会被覆写。）
    pageOpener = documentLike.activeElement || null;
    $('#settings-panel').hidden = false;
    $('#app')?.classList?.add?.('settings-open');
    if (!alreadyOpen) {
      onSectionChange(activePage);
      onPageEnter();
    }
  }

  function close() {
    const wasOpen = isOpen();
    stopPreview();
    $('#settings-panel').hidden = true;
    $('#app')?.classList?.remove?.('settings-open');
    // 只有真的关闭了才通知壳层，否则后台状态回调会把用户从别的页面拽回聊天。
    if (wasOpen) {
      onSectionChange(null);
      onPageLeave();
      // 焦点还给入口，不让键盘用户被丢到 body；入口已随侧栏收起而不可聚焦时，浏览器自行决定。
      pageOpener?.focus?.({ preventScroll: true });
      pageOpener = null;
    }
    return true;
  }

  function isOpen() {
    return $('#settings-panel')?.hidden === false;
  }

  const inputBindings = [
    ['#boot-llm-base-url', 'baseUrl'],
    ['#boot-llm-api-key', 'apiKey'],
    ['#boot-llm-model', 'model'],
  ];
  for (const [selector, key] of inputBindings) {
    listen($(selector), 'input', event => {
      selection[key] = event.currentTarget.value;
      validate();
    });
  }
  // 分类导航用事件委托：列表项是静态的，但与页面切换同走一条路径，方便测试。
  listen($('#settings-nav'), 'click', event => {
    const item = event?.target?.closest?.('[data-settings-page]');
    if (item?.dataset?.settingsPage) setPage(item.dataset.settingsPage);
  });
  // 页面内的跳转入口（如「模型与连接」里的「查看使用统计」）：与左侧导航同一条切换路径，
  // 不复制显隐逻辑，也不把按钮伪装成导航项。
  listen($('#settings-content'), 'click', event => {
    const link = event?.target?.closest?.('[data-settings-page-link]');
    if (link?.dataset?.settingsPageLink) setPage(link.dataset.settingsPageLink);
  });
  listen(documentLike, 'keydown', event => {
    if (event?.key === 'Escape' && isOpen() && !event.defaultPrevented) close();
  });
  listen($('#boot-primary'), 'change', event => {
    selection.primarySource = event.currentTarget.value;
    validate();
  });
  documentLike.querySelectorAll?.('[name="playback-source-mode"]').forEach(input => {
    listen(input, 'change', () => {
      if (!input.checked) return;
      selection.playbackSourceMode = input.value;
      renderSourceMode();
      validate();
    });
  });
  listen($('#settings-source-accounts'), 'click', async event => {
    const login = event.target?.closest?.('[data-source-login]');
    if (login && !accountBusy) { onSourceLogin(login.dataset.sourceLogin); return; }
    const logout = event.target?.closest?.('[data-source-logout]');
    if (!logout || accountBusy) return;
    accountBusy = true;
    accountError = '';
    // 不重建触发按钮；保留确认弹窗取消后的焦点，并立即给网络等待反馈。
    logout.disabled = true;
    const status = $('#settings-source-account-status');
    if (status) status.textContent = '正在退出账号…';
    try { await onSourceLogout(logout.dataset.sourceLogout); }
    catch { accountError = '退出失败，请重试。'; }
    finally {
      accountBusy = false;
      renderSourceAccounts();
      const target = $('#settings-source-accounts')?.querySelector?.(`[data-source-login="${logout.dataset.sourceLogout}"]`);
      target?.focus?.({ preventScroll: true });
    }
  });
  listen($('#sb-cog'), 'click', open);
  listen($('#sb-meta-llm'), 'click', open);
  listen($('#sb-meta-source'), 'click', open);
  listen($('#boot-close'), 'click', close);
  listen($('#boot-location-save'), 'click', () => { void saveLocation(); });
  listen($('#boot-location-auto'), 'click', () => { void autoDetectLocation(); });
  listen($('#boot-location-clear'), 'click', () => { void clearSavedLocation(); });
  listen($('#tts-custom-protocol'), 'change', () => {
    protocolTouched = true;
    recipeSettings.reset({ fillDefaults: true });
    renderCustomTts();
  });
  listen($('#tts-custom-url'), 'input', () => { onCustomUrlInput(); renderEditorHead(); });
  listen($('#tts-custom-model'), 'input', () => { recipeSettings.render(); renderEditorHead(); });
  listen($('#tts-custom-key'), 'input', () => { recipeSettings.render(); renderEditorHead(); });
  listen($('#tts-custom-name'), 'input', () => { renderEndpointList(); renderEditorHead(); });
  listen($('#tts-custom-endpoint-list'), 'click', event => {
    const item = event.target?.closest?.('[data-endpoint-id]');
    if (item) switchEndpoint(item.dataset.endpointId);
  });
  listen($('#tts-recipe-json'), 'input', () => renderEditorHead());
  listen($('#tts-pool-source'), 'change', event => { poolSourceId = event.currentTarget.value; renderPoolSource(); });
  listen($('#tts-custom-endpoint-add'), 'click', addEndpoint);
  listen($('#tts-custom-endpoint-remove'), 'click', requestRemoveEndpoint);
  listen($('#tts-custom-remove-yes'), 'click', () => { void confirmRemoveEndpoint(); });
  listen($('#tts-custom-remove-no'), 'click', cancelRemoveEndpoint);
  listen($('#tts-custom-models-btn'), 'click', () => { void discoverModels(); });
  listen($('#tts-custom-voices-btn'), 'click', () => { void discoverVoices(); });
  listen($('#tts-endpoint-failures-refresh'), 'click', () => { if (currentEndpoint()) void loadFailures(currentEndpointId); });
  listen($('#tts-custom-save'), 'click', () => { void saveCustomTts(); });
  listen($('#tts-custom-save-endpoint'), 'click', () => { void saveEndpointOnly(); });
  listen($('#song-tag-save'), 'click', () => { void saveSongTag(); });
  listen($('#song-tag-backfill'), 'click', () => { void backfillSongTags(); });
  listen($('#tts-custom-manual-add'), 'click', addManualVoice);
  listen($('#tts-custom-manual'), 'keydown', event => { if (event.key === 'Enter') { event.preventDefault(); addManualVoice(); } });
  // 待选名单用事件委托：行随筛选/状态频繁重建，委托只需要绑一次，
  // 也让测试与真实 DOM 走同一条路径。
  listen($('#tts-custom-voice-editor'), 'click', async event => {
    const previewTarget = event.target?.closest?.('[data-preview]');
    if (previewTarget) { await previewVoice(previewTarget.dataset.preview); return; }
    const removeTarget = event.target?.closest?.('[data-remove]');
    if (removeTarget) removeDraftVoices([removeTarget.dataset.remove]);
  });
  listen($('#tts-custom-voice-editor'), 'input', event => {
    const renameTarget = event.target?.closest?.('[data-rename]');
    if (!renameTarget) return;
    const voice = customDraft.find(item => voiceKey(item) === renameTarget.dataset.rename);
    if (voice) voice.displayName = event.target.value;
    renderPoolSaveState();
  });
  listen($('#tts-custom-voice-editor'), 'change', event => {
    const selectTarget = event.target?.closest?.('[data-select]');
    if (!selectTarget) return;
    if (event.target.checked) selectedVoiceIds.add(selectTarget.dataset.select);
    else selectedVoiceIds.delete(selectTarget.dataset.select);
    renderVoiceToolbar();
  });
  listen($('#tts-custom-voice-filter'), 'input', event => {
    voiceFilter = event.currentTarget.value;
    renderVoiceRows();
    renderVoiceToolbar();
  });
  // 全选作用于当前筛选出的行：筛选本身就是挑选动作的一部分。
  listen($('#tts-custom-select-all'), 'change', event => {
    const visible = visibleDraftVoices();
    for (const voice of visible) {
      if (event.currentTarget.checked) selectedVoiceIds.add(voiceKey(voice));
      else selectedVoiceIds.delete(voiceKey(voice));
    }
    renderVoiceRows();
    renderVoiceToolbar();
  });
  listen($('#tts-custom-remove-selected'), 'click', () => { removeDraftVoices([...selectedVoiceIds]); });
  // 发现结果：与声音池同样用事件委托；全选只作用于筛选出的行。
  listen($('#tts-custom-candidate-list'), 'click', async event => {
    const previewTarget = event.target?.closest?.('[data-preview]');
    if (previewTarget) await previewVoice(previewTarget.dataset.preview);
  });
  listen($('#tts-custom-candidate-list'), 'change', event => {
    const selectTarget = event.target?.closest?.('[data-candidate-select]');
    if (!selectTarget) return;
    if (event.target.checked) selectedCandidates.add(selectTarget.dataset.candidateSelect);
    else selectedCandidates.delete(selectTarget.dataset.candidateSelect);
    renderCandidateToolbar();
  });
  listen($('#tts-custom-candidate-filter'), 'input', event => {
    candidateFilter = event.currentTarget.value;
    renderCandidateRows();
    renderCandidateToolbar();
  });
  listen($('#tts-custom-candidate-select-all'), 'change', event => {
    for (const voice of visibleCandidates()) {
      if (event.currentTarget.checked) selectedCandidates.add(voiceKey(voice));
      else selectedCandidates.delete(voiceKey(voice));
    }
    renderCandidateRows();
    renderCandidateToolbar();
  });
  listen($('#tts-custom-candidate-add'), 'click', () => { void addSelectedCandidates(); });
  listen($('#tts-custom-design-toggle'), 'click', () => { void toggleDesign(); });
  listen($('#tts-custom-design-close'), 'click', () => {
    void toggleDesign(false);
    $('#tts-custom-design-toggle')?.focus?.();
  });
  listen($('#tts-custom-design-draft'), 'click', () => { void draftDesignDescription(); });
  listen($('#tts-custom-design-run'), 'click', () => { void runDesign(); });
  listen($('#tts-custom-design-description'), 'input', renderDesignChars);
  listen($('#tts-custom-candidate-close'), 'click', () => {
    clearCandidates();
    renderCandidates();
    $('#tts-custom-voices-btn')?.focus?.();
  });
  listen($('#boot-go'), 'click', async () => {
    try {
      const payload = {
        playbackSourceMode: selection.playbackSourceMode,
        primarySource: selection.primarySource,
        // 只提交归一后的相对比例；服务端仍会按当前可播源再收敛一次。
        ...(weightDraft && Object.keys(weightDraft).length ? { recommendationWeights: weightDraft } : {}),
      };
      if ($('#boot-llm-base-url')) {
        payload.baseUrl = selection.baseUrl.trim();
        payload.apiKey = selection.apiKey.trim();
        payload.model = selection.model.trim();
      }
      await controller.save(payload);
      storage.setItem(STORAGE_KEYS.bootDone, '1');
      onToast('success', '设置已保存', `${selection.playbackSourceMode === 'single' ? '单源' : '多源'}播放已生效；当前歌曲与队列没有变化。`, { curated: true });
      close({ complete: true });
    } catch (error) {
      onError(error);
    }
  });

  const unsubscribe = controller.subscribe(next => {
    snapshot = next;
    onSnapshot(next);
    renderSidebarMeta();
  });

  // 启动只载入配置，不再自动展开设置页；未配置完成时由 app 层提示引导。
  async function start() {
    try {
      snapshot = await controller.load();
      return snapshot;
    } catch (error) {
      onError(error);
      return null;
    }
  }

  return Object.freeze({
    start,
    open,
    close,
    isOpen,
    setPage,
    stopPreview,
    renderSidebarMeta,
    destroy() {
      unsubscribe();
      cleanups.splice(0).forEach(cleanup => cleanup());
    },
  });
}
