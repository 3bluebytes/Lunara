// 主题插件注册表：列出所有已安装主题，顺序即设置里主题选择器的顺序。
// 规范见 docs/design/handoff-theme-d/THEME_PLUGINS.md。
//
// 每套主题是 pwa/themes/<id>/ 一个文件夹：theme.json 声明元数据和显示变体，
// tokens.css 只写 :root[data-theme="<id>"] 一个变量块，overrides.css 只写限定在
// 本主题下的覆盖样式，atmosphere.js 是可选的背景氛围层。样式文件由 index.html
// 静态链接（选择器都被限定在各自主题下，所以同时加载不会互相影响）。
//
// 加主题 = 新建文件夹 + 在下面 import 一行 + 在 index.html 链接它的样式。
import moonlight from './moonlight/theme.json' with { type: 'json' };
import modernist from './modernist/theme.json' with { type: 'json' };
import nocturne from './nocturne/theme.json' with { type: 'json' };

// 共享组件预先支持的显示方式；主题只能从这里挑，不能自己发明新值。
export const VARIANT_OPTIONS = Object.freeze({
  identity: Object.freeze(['dot', 'line', 'name']),
  clock: Object.freeze(['hero', 'compact', 'hidden']),
  waveform: Object.freeze(['dual', 'single', 'line']),
  decoration: Object.freeze(['on', 'off']),
  // stage：方案 A / B / C / D 共用的舞台骨架（features/shell/stage.css）。
  // classic：旧主题的版式；旧主题已删除（见 legacy/ui-v2 分支），值暂留以免旧样式规则失去锚点。
  // timeline：横向时间线 + 顶栏导航（features/shell/timeline.css），侧栏改为「全部」浮层。
  layout: Object.freeze(['classic', 'stage', 'timeline']),
});

// 没有 data-theme 时生效的回退主题：它的 token 块同时写在裸 :root 上。
export const FALLBACK_THEME = 'moonlight';

function freezeManifest(manifest) {
  return Object.freeze({ ...manifest, variants: Object.freeze({ ...manifest.variants }) });
}

export const THEME_MANIFESTS = Object.freeze(
  [moonlight, modernist, nocturne].map(freezeManifest),
);

const byId = new Map(THEME_MANIFESTS.map(manifest => [manifest.id, manifest]));

export function getThemeManifest(id) {
  return byId.get(String(id ?? '')) || null;
}

// 主题文件相对本模块解析，浏览器里是 /themes/<id>/<file>，Node 测试里是磁盘路径。
export function themeFileUrl(id, file) {
  return new URL(`./${id}/${file}`, import.meta.url);
}
