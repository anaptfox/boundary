import electron from "electron";

const { app, BrowserWindow } = electron;
const uiUrl = process.env.TODO_UI_URL ?? "http://127.0.0.1:4173/";

async function waitForUrl(url, ms = 20000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: "manual" });
      if (response.status < 500) return;
    } catch {
      // Vite is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Todo UI did not become ready at ${url}`);
}

app
  .whenReady()
  .then(async () => {
    await waitForUrl(uiUrl);
    const window = new BrowserWindow({
      title: "Todos",
      width: 960,
      height: 800,
      show: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    window.show();
    window.focus();
    await window.loadURL(uiUrl);
    app.on("window-all-closed", () => app.quit());
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
