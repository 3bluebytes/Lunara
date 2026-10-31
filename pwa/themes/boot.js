// 首帧主题：在任何样式表之前同步执行，把保存的主题写到根元素上，避免先画出
// index.html 写死的默认主题、等 app.js 模块加载后再跳一次（闪主题）。
// 规则与 visuals/themeController.js 一致（迁移、开发版式开关、素色底色），
// 变体表与各主题 theme.json 一致；themeBoot.test.js 校验两者不漂移。
// 经典脚本（非模块），不能 import；存储读不到就按默认主题走。
(function () {
  var VARIANTS = {
    moonlight: { identity: 'dot', clock: 'hidden', waveform: 'dual', decoration: 'on', layout: 'stage' },
    modernist: { identity: 'name', clock: 'hidden', waveform: 'line', decoration: 'off', layout: 'stage' },
    nocturne: { identity: 'dot', clock: 'compact', waveform: 'line', decoration: 'off', layout: 'timeline' },
  };
  var LAYOUTS = ['classic', 'stage', 'timeline'];
  var root = document.documentElement.dataset;
  function read(key) {
    try { return localStorage.getItem(key); } catch (error) { return null; }
  }
  var stored = read('lunara.theme');
  var theme = stored === 'cike' ? 'moonlight' : stored;
  if (!Object.prototype.hasOwnProperty.call(VARIANTS, theme)) theme = 'nocturne';
  root.theme = theme;
  if (theme === 'modernist') root.modernistBase = read('lunara.modernistBase') === 'indigo' ? 'indigo' : 'paper';
  var variants = VARIANTS[theme];
  for (var key in variants) root[key] = variants[key];
  var layout = read('lunara.dev.layout');
  if (LAYOUTS.indexOf(layout) !== -1) root.layout = layout;
  root.material = read('lunara.nocturneMaterial') === 'glass' ? 'glass' : 'flat';
  // 首帧不播过渡：app.js 初始化完主题后移除这个标记。
  root.themeBooting = '';
})();
