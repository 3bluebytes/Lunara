import { countUsableVoices } from '../../core/usableVoice.js';
import { createFreeVoiceQuickEnable } from '../settings/freeVoiceSettings.js';
import { firstRunChecklist, firstRunReadiness } from './firstRunCoordinator.js';

const ITEMS = [
  { id: 'model', label: '接入模型', missing: '第一步，接入模型，去设置', complete: '模型，已完成' },
  { id: 'music', label: '登录音乐账号', missing: '第二步，登录音乐账号', complete: '音乐账号，已完成' },
  { id: 'voice', label: '声音（可选）', missing: '声音，可选，去设置', complete: '声音，已完成' },
];

export function onboardingPrefersChatPane({ incomplete = false, alreadyDefaulted = false } = {}) {
  return incomplete === true && alreadyDefaulted !== true;
}

export function onboardingView({ settings, auth, voicesBody, customBody, rootVoiceId } = {}) {
  const voicesKnown = Array.isArray(voicesBody?.voices);
  const voices = voicesKnown ? voicesBody.voices : [];
  const fallback = customBody?.config?.fallback ?? null;
  return {
    checklist: firstRunChecklist({
      settings: fallback ? { ...settings, fallback } : settings,
      auth,
      voices,
      rootVoiceId,
    }),
    source: firstRunReadiness({ settings, auth }).source,
    ...(voicesKnown ? { voices, fallback } : {}),
  };
}

export function createOnSetupRequired({ openSource = () => {} } = {}) {
  let prompted = false;
  return state => {
    if (prompted) return;
    prompted = true;
    if (state?.missing === 'source-login' && state.source) openSource(state.source);
  };
}

export function activateOnboardingItem(item, source, { setPage, openSettings, openSource } = {}, { complete = false } = {}) {
  if (item === 'music' && complete) return;
  if (item === 'music' && source) return openSource(source);
  if (item !== 'model' && item !== 'voice' && item !== 'music') return;
  setPage(item === 'voice' ? 'voice' : 'connection');
  openSettings();
}

export function createOnboardingCard({
  documentLike = globalThis.document,
  mount,
  setPage = () => {},
  openSettings = () => {},
  openSource = () => {},
  saveTtsFallback,
  onFreeVoiceEnabled = () => {},
} = {}) {
  if (!mount?.insertBefore) throw new TypeError('onboarding card requires a mount element');
  const card = documentLike.createElement('section');
  card.className = 'shell-page-head';
  card.dataset.onboardingCard = '';
  card.setAttribute('aria-label', '开始之前');
  card.hidden = true;
  mount.insertBefore(card, mount.firstChild);
  const buttons = new Map();
  let freeVoice = null;

  function ensure() {
    if (buttons.size) return;
    const copy = documentLike.createElement('div');
    copy.className = 'shell-page-copy';
    const title = documentLike.createElement('h2');
    title.className = 'shell-page-title';
    title.textContent = '开始之前';
    const sub = documentLike.createElement('p');
    sub.className = 'shell-page-sub';
    sub.textContent = '先接入模型，再登录音乐账号，就能聊天和放歌；声音可以以后再开。';
    copy.append(title, sub);
    const actions = documentLike.createElement('div');
    actions.className = 'shell-page-actions';
    for (const item of ITEMS) {
      const button = documentLike.createElement('button');
      button.type = 'button';
      button.className = 'shell-primary';
      button.dataset.onboardingItem = item.id;
      button.dataset.complete = 'false';
      const mark = documentLike.createElement('span');
      mark.setAttribute('aria-hidden', 'true');
      const label = documentLike.createElement('span');
      label.textContent = item.label;
      button.append(mark, label);
      button.addEventListener('click', () => {
        activateOnboardingItem(item.id, button.dataset.source || '', {
          setPage, openSettings, openSource,
        }, { complete: button.dataset.complete === 'true' });
      });
      buttons.set(item.id, { button, mark });
      actions.append(button);
    }
    freeVoice = createFreeVoiceQuickEnable({
      documentLike,
      saveTtsFallback,
      onEnabled: onFreeVoiceEnabled,
    });
    freeVoice.hidden = true;
    card.append(copy, actions, freeVoice);
  }

  function render(state) {
    const { checklist = null, source = null } = state || {};
    const visible = Boolean(checklist) && ITEMS.some(item => checklist[item.id] !== 'complete');
    if (!visible && !buttons.size) {
      card.hidden = true;
      return card;
    }
    ensure();
    const offer = visible && Array.isArray(state?.voices) && countUsableVoices(state.voices, state.fallback) === 0;
    freeVoice.hidden = !offer;
    if (!visible) {
      card.hidden = true;
      return card;
    }
    // 只有“下一步该做的那一项”是实心主按钮，其余退成描边，免得三个按钮一样重。
    const nextId = ITEMS.find(item => checklist[item.id] !== 'complete')?.id;
    for (const item of ITEMS) {
      const complete = checklist[item.id] === 'complete';
      const { button, mark } = buttons.get(item.id);
      button.dataset.complete = complete ? 'true' : 'false';
      button.dataset.emphasis = item.id === nextId ? 'primary' : 'secondary';
      button.setAttribute('aria-label', complete ? item.complete : item.missing);
      if (item.id === 'music') {
        if (source && !complete) button.dataset.source = source;
        else delete button.dataset.source;
      }
      mark.textContent = complete ? '✓ ' : '';
    }
    card.hidden = false;
    return card;
  }

  return Object.freeze({
    render,
    element: card,
    destroy() { card.remove(); },
  });
}
