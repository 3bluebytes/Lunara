// 隔离验收窗口：不加载正式 main.js、不读用户配置。由 hostOwnedNarration 集成测试启动。
const { app, BrowserWindow } = require('electron');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');

app.setPath('userData', process.env.LUNARA_GREETING_QA_DIR);
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
let window;
app.whenReady().then(async () => {
  window = new BrowserWindow({ width: 650, height: 360, show: false,
    webPreferences: { backgroundThrottling: false, contextIsolation: true, sandbox: true } });
  window.showInactive();
  try {
    await window.loadURL(process.env.LUNARA_GREETING_QA_URL);
    const result = await window.webContents.executeJavaScript('window.greetingResult');
    const screenshot = join(process.env.LUNARA_GREETING_QA_DIR, 'greeting.png');
    writeFileSync(screenshot, (await window.webContents.capturePage()).toPNG());
    const report = { ...result, screenshot };
    writeFileSync(join(process.env.LUNARA_GREETING_QA_DIR, 'result.json'), JSON.stringify(report, null, 2));
    console.log(`GREETING_QA_RESULT ${JSON.stringify(report)}`);
    app.exit(0);
  } catch (error) {
    console.error(`GREETING_QA_FAILED ${error.message}`);
    app.exit(1);
  }
});
