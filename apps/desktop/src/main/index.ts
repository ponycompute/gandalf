import { app, BrowserWindow, ipcMain, nativeTheme, type WebFrameMain } from "electron";
import { writeSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import { nodeEnv } from "@gandalf/skills";
import { HOME_ARGUMENT, channels } from "../shared/ipc";
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
const gandalfEnv = nodeEnv({ home: env.home });
const service = openService(gandalfEnv);

function perf(name: string, start: number): void {
  if (env.perf) process.stdout.write(`perf ${name} ${(performance.now() - start).toFixed(1)}\n`);
}

const RENDERER_INDEX = join(import.meta.dirname, "../renderer/index.html");
const devServer = process.env.ELECTRON_RENDERER_URL;

/** Only the app's own top-level page may call gandalf, never a frame or a page it navigated to. */
function isAppPage(frame: WebFrameMain | null): boolean {
  const url = frame === null || frame.parent !== null ? null : URL.parse(frame.url);
  if (url === null) return false;
  return devServer === undefined
    ? url.protocol === "file:" && fileURLToPath(url) === RENDERER_INDEX
    : url.origin === new URL(devServer).origin;
}

function serve(name: string, channel: string, work: (payload: unknown) => Promise<unknown>) {
  ipcMain.handle(channel, async (event, payload: unknown) => {
    if (!isAppPage(event.senderFrame))
      throw new Error(`${channel} refused a caller outside gandalf`);
    const start = performance.now();
    const result = await work(payload);
    perf(name, start);
    return result;
  });
}

serve("snapshot", channels.snapshot, () => service.snapshot());
serve("plan", channels.plan, (intent) => service.plan(intent));
serve("apply", channels.apply, (token) => service.apply(token));

ipcMain.on(channels.watchReduceTransparency, (event) => {
  if (!isAppPage(event.senderFrame)) return;
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
      additionalArguments: [`${HOME_ARGUMENT}${gandalfEnv.home}`],
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => {
    if (event.url !== window.webContents.getURL()) event.preventDefault();
  });
  if (!env.hidden) window.once("ready-to-show", () => window.show());
  return devServer === undefined ? window.loadFile(RENDERER_INDEX) : window.loadURL(devServer);
}

app
  .whenReady()
  .then(openWindow)
  .catch((error: unknown) => fail("could not open the window", error));
app.on("window-all-closed", () => app.quit());
