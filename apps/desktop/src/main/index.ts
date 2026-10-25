import { app, BrowserWindow, ipcMain, nativeTheme } from "electron";
import { writeSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { inspect } from "node:util";
import { nodeEnv } from "@gandalf/skills";
import { channels } from "../shared/ipc";
import { openService } from "./gandalf";

/** Writes synchronously, because process.exit drops pending writes to a pipe on macOS. */
function fail(message: string, error?: unknown): never {
  const detail = error === undefined ? "" : ` ${inspect(error)}`;
  writeSync(process.stderr.fd, `gandalf: ${message}${detail}\n`);
  process.exit(1);
}

function absolutePathEnv(name: string): string | undefined {
  const value = process.env[name];
  if (value === undefined || isAbsolute(value)) return value;
  return fail(`${name} must be an absolute path, got ${JSON.stringify(value)}`);
}

const env = {
  home: absolutePathEnv("GANDALF_HOME"),
  userData: absolutePathEnv("GANDALF_USER_DATA"),
  perf: process.env.GANDALF_PERF === "1",
  hidden: process.env.GANDALF_HIDDEN === "1",
};

if (env.home !== undefined) app.setPath("home", env.home);
if (env.userData !== undefined) app.setPath("userData", env.userData);
const service = openService(nodeEnv({ home: env.home }));

function perf(name: string, start: number): void {
  if (env.perf) process.stdout.write(`perf ${name} ${(performance.now() - start).toFixed(1)}\n`);
}

ipcMain.handle(channels.snapshot, async () => {
  const start = performance.now();
  const result = await service.snapshot();
  perf("snapshot", start);
  return result;
});

ipcMain.on(channels.watchReduceTransparency, (event) => {
  event.sender.send(channels.reduceTransparency, nativeTheme.prefersReducedTransparency);
});
nativeTheme.on("updated", () => {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(channels.reduceTransparency, nativeTheme.prefersReducedTransparency);
  }
});

function openWindow(): Promise<void> {
  const window = new BrowserWindow({
    title: "Gandalf",
    width: 960,
    height: 640,
    minWidth: 640,
    minHeight: 400,
    show: false,
    titleBarStyle: "hidden",
    vibrancy: "under-window",
    trafficLightPosition: { x: 22, y: 22 },
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => {
    if (event.url !== window.webContents.getURL()) event.preventDefault();
  });
  if (!env.hidden) window.once("ready-to-show", () => window.show());
  const devServer = process.env.ELECTRON_RENDERER_URL;
  return devServer === undefined
    ? window.loadFile(join(import.meta.dirname, "../renderer/index.html"))
    : window.loadURL(devServer);
}

app
  .whenReady()
  .then(openWindow)
  .catch((error: unknown) => fail("could not open the window", error));
app.on("window-all-closed", () => app.quit());
