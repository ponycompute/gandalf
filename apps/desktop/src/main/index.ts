import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  nativeTheme,
  shell,
  type IpcMainInvokeEvent,
  type WebFrameMain,
} from "electron";
import { realpathSync, writeSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import { nodeEnv } from "@gandalf/skills";
import {
  HOME_ARGUMENT,
  REAL_HOME_ARGUMENT,
  channels,
  contentKey,
  type Planned,
  type Result,
} from "../shared/ipc";
import { openService, settle } from "./gandalf";
import { openMarket } from "./market";
import { findOnPath, isDirectory, isExecutable, withHomebrew } from "./path";
import { chosenFolder } from "./shell";
import { watchDisk } from "./watch";
import { readWindowSize, writeWindowSize } from "./windowSize";

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

// Before anything spawns git: an app opened from Finder does not get the terminal's PATH.
const path = withHomebrew(process.env.PATH, isDirectory);
if (path !== undefined) process.env.PATH = path;
const git = findOnPath("git", process.env.PATH ?? "", isExecutable);

const env = {
  home: absolutePathEnv("GANDALF_HOME"),
  userData: absolutePathEnv("GANDALF_USER_DATA"),
  perf: process.env.GANDALF_PERF === "1",
  hidden: process.env.GANDALF_HIDDEN === "1",
  /** Where skills.sh and GitHub are, so a test can serve both itself. */
  skillsSh: process.env.GANDALF_SKILLS_SH ?? "https://skills.sh",
  github: process.env.GANDALF_GITHUB ?? "https://github.com",
};

if (env.home !== undefined) app.setPath("home", env.home);
if (env.userData !== undefined) app.setPath("userData", env.userData);
const gandalfEnv = nodeEnv({ home: env.home });
const service = openService(gandalfEnv);
/** HOME with its symlinks resolved, as paths from a folder panel or a realpath arrive. */
const realHome = (() => {
  try {
    return realpathSync(gandalfEnv.home);
  } catch {
    return gandalfEnv.home;
  }
})();

function timed<A extends unknown[], R>(name: string, work: (...args: A) => Promise<R>) {
  return async (...args: A): Promise<R> => {
    const start = performance.now();
    const result = await work(...args);
    if (env.perf) process.stdout.write(`perf ${name} ${(performance.now() - start).toFixed(1)}\n`);
    return result;
  };
}

const snapshot = timed("snapshot", service.snapshot);
const plan = timed("plan", service.plan);
const apply = timed("apply", service.apply);
const readSkillFile = timed("readSkillFile", service.readSkillFile);

const market = openMarket({
  site: env.skillsSh.replace(/\/+$/, ""),
  github: env.github.replace(/\/+$/, ""),
  fetch: globalThis.fetch,
  now: Date.now,
});

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

/** Sends to each window showing the app's own page, never to one that navigated elsewhere. */
function sendToApp(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (isAppPage(window.webContents.mainFrame)) window.webContents.send(channel, payload);
  }
}

const watcher = watchDisk({
  home: gandalfEnv.home,
  snapshot,
  push: (result) => sendToApp(channels.snapshotPushed, result),
});

/** The plans still running, each by the controller that cancels it. */
const running = new Set<AbortController>();

/** Cancels every plan started so far: the core kills their fetches. An apply is never touched. */
function cancelPlans(): void {
  for (const controller of running) controller.abort();
}

/**
 * The snapshot is read first, so a change during planning shows the preview as out of date. The
 * core runs fetches of one repository one at a time, so a cancelled plan has stopped fetching
 * before the next one fetches.
 */
async function planned(intent: unknown): Promise<Result<Planned>> {
  const controller = new AbortController();
  running.add(controller);
  try {
    const basis = await service.snapshot();
    const result = await plan(intent, controller.signal);
    if (!result.ok) return result;
    return {
      ok: true,
      value: { ...result.value, basis: basis.ok ? contentKey(basis.value) : null },
    };
  } finally {
    running.delete(controller);
  }
}

/** Lists a repository's skills; Cancel stops its fetch as it stops a plan's. */
async function repoSkills(repository: unknown) {
  const controller = new AbortController();
  running.add(controller);
  try {
    return await service.repoSkills(repository, controller.signal);
  } finally {
    running.delete(controller);
  }
}

function serve(
  channel: string,
  work: (payload: unknown, event: IpcMainInvokeEvent) => Promise<unknown>,
) {
  ipcMain.handle(channel, async (event, payload: unknown) => {
    if (!isAppPage(event.senderFrame))
      throw new Error(`${channel} refused a caller outside gandalf`);
    return work(payload, event);
  });
}

/** The open panel, as a sheet on the asking window. */
function chooseFolder(event: IpcMainInvokeEvent): Promise<Result<string | null>> {
  return settle(async () => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const options = { properties: ["openDirectory" as const], buttonLabel: "Choose" };
    const answer = await (window === null
      ? dialog.showOpenDialog(options)
      : dialog.showOpenDialog(window, options));
    return chosenFolder(answer);
  });
}

async function revealSkill(dir: unknown): Promise<Result<null>> {
  const checked = await service.revealable(dir);
  if (!checked.ok) return checked;
  shell.showItemInFolder(checked.value);
  return { ok: true, value: null };
}

async function revealLibrary(): Promise<Result<null>> {
  const read = await watcher.snapshot();
  if (!read.ok) return read;
  shell.showItemInFolder(read.value.libraryDir);
  return { ok: true, value: null };
}

function setAppearance(appearance: unknown): Promise<Result<null>> {
  if (appearance !== "system" && appearance !== "light" && appearance !== "dark") {
    return Promise.resolve({
      ok: false,
      error: {
        kind: "badInput",
        field: "appearance",
        message: "appearance must be system, light or dark",
      },
    });
  }
  nativeTheme.themeSource = appearance;
  return Promise.resolve({ ok: true, value: null });
}

serve(channels.snapshot, () => watcher.snapshot());
serve(channels.plan, planned);
serve(channels.cancelPlan, () => {
  cancelPlans();
  return Promise.resolve({ ok: true, value: null });
});
serve(channels.apply, (token) => watcher.applying(() => apply(token)));
serve(channels.readSkillFile, readSkillFile);
serve(channels.chooseFolder, (_payload, event) => chooseFolder(event));
serve(channels.revealSkill, revealSkill);
serve(channels.revealLibrary, revealLibrary);
serve(channels.setAppearance, setAppearance);
serve(channels.searchSkillsSh, market.search);
serve(channels.skillsShBoard, market.board);
serve(channels.ownerAvatar, market.avatar);
serve(channels.repoSkills, repoSkills);

ipcMain.on(channels.watchReduceTransparency, (event) => {
  if (!isAppPage(event.senderFrame)) return;
  event.sender.send(channels.reduceTransparency, nativeTheme.prefersReducedTransparency);
});
nativeTheme.on("updated", () => {
  sendToApp(channels.reduceTransparency, nativeTheme.prefersReducedTransparency);
});

const MINIMUM_SIZE = { width: 640, height: 400 };

function openWindow(): Promise<void> {
  const sizeFile = join(app.getPath("userData"), "window.json");
  const size = readWindowSize(sizeFile, MINIMUM_SIZE, { width: 960, height: 640 });
  const window = new BrowserWindow({
    title: "Gandalf",
    ...size,
    minWidth: MINIMUM_SIZE.width,
    minHeight: MINIMUM_SIZE.height,
    show: false,
    titleBarStyle: "hidden",
    vibrancy: "under-window",
    trafficLightPosition: { x: 22, y: 22 },
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      additionalArguments: [
        `${HOME_ARGUMENT}${gandalfEnv.home}`,
        `${REAL_HOME_ARGUMENT}${realHome}`,
      ],
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => {
    if (event.url !== window.webContents.getURL()) event.preventDefault();
  });
  // The normal bounds, so a window closed in full screen reopens at the size it had before.
  window.on("close", () => writeWindowSize(sizeFile, window.getNormalBounds()));
  if (!env.hidden) window.once("ready-to-show", () => window.show());
  return devServer === undefined ? window.loadFile(RENDERER_INDEX) : window.loadURL(devServer);
}

app
  .whenReady()
  .then(openWindow)
  // Logged once the window shows the app, so a driver attached at launch reads it too.
  .then(() => process.stdout.write(`gandalf: git ${git ?? "is not on PATH"}\n`))
  .catch((error: unknown) => fail("could not open the window", error));
app.on("window-all-closed", () => app.quit());
app.on("will-quit", () => {
  watcher.close();
  // A fetch still running would outlive the app.
  cancelPlans();
});
