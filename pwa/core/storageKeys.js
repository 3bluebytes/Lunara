/**
 * Browser persistence keys owned by the Lunara client.
 *
 * Keeping them in one module prevents feature modules from silently inventing
 * incompatible keys during the app.js decomposition.
 */
export const STORAGE_KEYS = Object.freeze({
  artworkTheme: 'lunara.artworkTheme',
  bootDone: 'lunara.bootDone',
  firstRunRequestId: 'lunara.firstRun.requestId',
  firstRunCompleted: 'lunara.firstRun.completed',
  outcomeQueue: 'outcomeQueue',
  sidebarWidth: 'lunara.sidebarWidth',
  todayListWidth: 'lunara.todayListWidth',
  theme: 'lunara.theme',
  modernistBase: 'lunara.modernistBase',
  // 夜场材质：'flat'（实底，默认）| 'glass'；写到根元素 data-material。
  nocturneMaterial: 'lunara.nocturneMaterial',
  // 开发开关：覆盖当前主题声明的 layout（例如 'timeline'），夜场主题开放前用来预览新版式。
  layoutOverride: 'lunara.dev.layout',
  trayText: 'lunara.tray.text',
});
