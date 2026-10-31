export function installElectronShutdown(app, stop, report = console.error) {
  let stopping = null;
  let completed = false;
  app.on('before-quit', event => {
    if (completed) return;
    event.preventDefault();
    if (stopping) return;
    stopping = Promise.resolve().then(stop).catch(() => {
      report('[shutdown] Lunara could not stop cleanly.');
    }).finally(() => {
      completed = true;
      app.quit();
    });
  });
}
