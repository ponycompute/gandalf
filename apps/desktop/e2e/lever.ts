import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { isAbsolute, join, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { _electron, type ElectronApplication, type Locator, type Page } from "playwright";
import { channels } from "../src/shared/ipc";
import { requireFfmpeg } from "./ffmpeg";

const run = promisify(execFile);
const APP_DIR = fileURLToPath(new URL("..", import.meta.url));
const CLI_BIN = fileURLToPath(new URL("../../../packages/cli/dist/bin.js", import.meta.url));
const CLI_TIMEOUT_MS = 30_000;
/** Longer than main's 100 ms watch debounce plus a snapshot and a late FSEvents delivery. */
const SETTLE_MS = 1000;
/** Resolving the package also fetches the binary when `pnpm install` skipped it. */
const ELECTRON_BIN: string = createRequire(import.meta.url)("electron");

const MARGIN = 60;
const SIDEBAR_INSET = 8;
const SIDEBAR_WIDTH = 220;
const BACKDROP_GAP = 30;
const BACKDROP_TEXT_LEFT = MARGIN + SIDEBAR_INSET + SIDEBAR_WIDTH + BACKDROP_GAP;

const BACKDROP_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>backdrop</title><style>
html,body{margin:0;height:100%}
body{background:repeating-linear-gradient(45deg,#ff3b30 0 40px,#ffcc00 40px 80px,#34c759 80px 120px,#007aff 120px 160px,#af52de 160px 200px);
font:900 64px/1 -apple-system;color:#000;display:flex;flex-wrap:wrap;align-content:flex-start;gap:${BACKDROP_GAP}px;padding:${BACKDROP_GAP}px ${BACKDROP_GAP}px ${BACKDROP_GAP}px ${BACKDROP_TEXT_LEFT}px;box-sizing:border-box;overflow:hidden}
span{background:#fff;padding:4px 10px}
</style></head><body><span>DESKTOP</span><span>BEHIND</span><span>WINDOW</span><span>BLUR?</span><span>DESKTOP</span><span>BEHIND</span></body></html>`;

export interface LaunchOptions {
  readonly home: string;
  readonly shots?: string;
  readonly show?: boolean;
  /** Records the window into a .webm in `dir`, written when the app closes. */
  readonly recordVideo?: {
    readonly dir: string;
    readonly size?: { readonly width: number; readonly height: number };
  };
  /** Variables for main on top of this process's, such as a minimal PATH. HOME stays the lane's. */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * A userData folder the caller made in the OS temp dir. It outlives the app, so a relaunch on it
   * reads what the last launch saved. Without it each launch gets a fresh one, removed on close.
   */
  readonly userData?: string;
}

/**
 * A packaged app's binary, such as release/mac-arm64/Gandalf.app/Contents/MacOS/Gandalf, which
 * every launch then runs in place of the built out/ folder.
 */
const PACKAGED_APP = process.env.GANDALF_E2E_APP;

export type ThemeSource = "system" | "light" | "dark";

export interface App {
  readonly electron: ElectronApplication;
  readonly page: Page;
  readonly home: string;
  readonly shots: string;
  readonly windowId: number;
  shot(slug: string): Promise<string>;
  countLine(): Promise<string>;
  /** A point in main's perf lines, so a later wait can skip what was printed before it. */
  mark(): number;
  /** Waits for main's latest "perf <name>" line, printed after `after` when given. */
  timing(name: string, options?: { readonly after?: number }): Promise<number>;
  /** Every "perf <name>" line main printed after `after`, without waiting. */
  timings(name: string, options: { readonly after: number }): readonly number[];
  /** Waits until main prints no perf line for a second, so a count from now sees only what follows. */
  settle(): Promise<void>;
  /** Every line main printed to stdout so far, perf lines and its "gandalf: git …" line included. */
  log(): readonly string[];
  /**
   * Makes the folder panel answer `folder` (null for Cancel) without opening, so no test ever
   * shows a real dialog. Call it before clicking Choose….
   */
  stubFolderPanel(folder: string | null): Promise<void>;
  /** Replaces Finder's reveal with a recorder, so no test opens Finder. Returns what it received. */
  stubFinder(): Promise<() => Promise<readonly string[]>>;
  setTheme(source: ThemeSource): Promise<void>;
  setReduceTransparency(on: boolean): Promise<void>;
  pushSnapshot(result: unknown): Promise<void>;
  resize(width: number, height: number): Promise<void>;
  show(): Promise<void>;
  backdrop(): Promise<() => Promise<void>>;
  regionShot(slug: string): Promise<string>;
  /** The toolbar's Sync button, whatever its label says. */
  syncButton(): Locator;
  /** The sync preview sheet. */
  sheet(): Locator;
  /** Clicks the agent chip for `skill` in its detail, opening the detail first, then waits for the sheet. */
  toggleCell(skill: string, agent: string): Promise<Locator>;
  /** The chip's glyph and the word its checkbox is described by, such as "● Linked". */
  cellStatus(skill: string, agent: string): Promise<string>;
  /** Clicks the sheet's primary button, then waits for the sheet to close. */
  applySheet(): Promise<void>;
  close(): Promise<void>;
}

export async function launchApp(options: LaunchOptions): Promise<App> {
  const home = await isolatedHome(options.home);
  if (options.recordVideo !== undefined) await requireFfmpeg();
  const shots = options.shots ?? join(tmpdir(), `gandalf-shots-${randomUUID()}`);
  const ownUserData = options.userData === undefined;
  const userData = ownUserData
    ? await mkdtemp(join(tmpdir(), "gandalf-user-data-"))
    : await isolatedHome(options.userData);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== "ELECTRON_RUN_AS_NODE") env[key] = value;
  }
  let electron: ElectronApplication | undefined;
  try {
    electron = await _electron.launch({
      executablePath: PACKAGED_APP ?? ELECTRON_BIN,
      args: PACKAGED_APP === undefined ? [APP_DIR] : [],
      colorScheme: null,
      ...(options.recordVideo === undefined ? {} : { recordVideo: options.recordVideo }),
      env: {
        ...env,
        // skills.sh and GitHub point at a closed port unless a test serves its own.
        GANDALF_SKILLS_SH: "http://127.0.0.1:9",
        GANDALF_GITHUB: "http://127.0.0.1:9",
        ...options.env,
        HOME: home,
        GIT_CONFIG_NOSYSTEM: "1",
        GANDALF_HOME: home,
        GANDALF_USER_DATA: userData,
        GANDALF_PERF: "1",
        GANDALF_HIDDEN: options.show === true ? "0" : "1",
      },
    });
    return await drive(electron, home, shots, ownUserData ? userData : undefined);
  } catch (error) {
    await stop(electron, ownUserData ? userData : undefined).catch((cleanupError: unknown) => {
      throw new AggregateError([error, cleanupError], "launchApp failed, and so did its cleanup");
    });
    throw error;
  }
}

async function drive(
  electron: ElectronApplication,
  home: string,
  shots: string,
  userData: string | undefined,
): Promise<App> {
  const perf: { readonly name: string; readonly ms: number }[] = [];
  const log: string[] = [];
  let pending = "";
  electron.process().stdout?.on("data", (chunk: Buffer) => {
    const lines = (pending + chunk.toString()).split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      log.push(line);
      const match = /^perf (\S+) (\d+(?:\.\d+)?)$/.exec(line);
      if (match?.[1] !== undefined && match[2] !== undefined) {
        perf.push({ name: match[1], ms: Number(match[2]) });
      }
    }
  });

  const page = await electron.firstWindow();
  const windowId = await electron.evaluate(({ BrowserWindow }) => {
    const [window] = BrowserWindow.getAllWindows();
    if (window === undefined) throw new Error("the app opened no window");
    return window.id;
  });

  const shotPath = async (slug: string) => {
    await mkdir(shots, { recursive: true });
    return join(shots, `${slug}.png`);
  };
  const send = (channel: string, payload: unknown) =>
    electron.evaluate(
      ({ BrowserWindow }, [id, name, value]) =>
        BrowserWindow.fromId(id)?.webContents.send(name, value),
      [windowId, channel, payload] as const,
    );
  const bounds = () =>
    electron.evaluate(({ BrowserWindow }, id) => {
      const window = BrowserWindow.fromId(id);
      if (window === null) throw new Error("the app window is gone");
      return window.getBounds();
    }, windowId);
  const show = async () => {
    await electron.evaluate(({ BrowserWindow }, id) => {
      const window = BrowserWindow.fromId(id);
      if (window === null) throw new Error("the app window is gone");
      window.showInactive();
    }, windowId);
    await delay(500);
  };

  const checkbox = (skill: string, agent: string) =>
    page.getByRole("checkbox", { name: `${skill} for ${agent}`, exact: true });
  /** Selects the skill's row unless its detail shows already, so its agent chips are on screen. */
  const showSkill = async (skill: string) => {
    const detail = page.getByRole("complementary", { name: skill, exact: true });
    if (await detail.isVisible()) return;
    await page.locator(`[role="option"][data-skill="${skill}"]`).click();
    await detail.waitFor();
  };

  const app: App = {
    electron,
    page,
    home,
    shots,
    windowId,
    shot: async (slug) => {
      const path = await shotPath(slug);
      await page.screenshot({ path });
      return path;
    },
    countLine: async () => {
      const count = page.getByText(/^\d+ skills?$/);
      await count.waitFor();
      return (await count.textContent()) ?? "";
    },
    mark: () => perf.length,
    timing: async (name, { after = 0 } = {}) => {
      const deadline = Date.now() + 10_000;
      for (;;) {
        const latest = perf.slice(after).findLast((entry) => entry.name === name);
        if (latest !== undefined) return latest.ms;
        if (Date.now() > deadline) {
          throw new Error(`main printed no "perf ${name}" line after mark ${after}`);
        }
        await delay(25);
      }
    },
    timings: (name, { after }) =>
      perf
        .slice(after)
        .filter((entry) => entry.name === name)
        .map((entry) => entry.ms),
    settle: async () => {
      let seen = -1;
      while (seen !== perf.length) {
        seen = perf.length;
        await delay(SETTLE_MS);
      }
    },
    log: () => [...log],
    stubFolderPanel: async (folder) => {
      await electron.evaluate(({ dialog }, answer) => {
        const open = () =>
          Promise.resolve({
            canceled: answer === null,
            filePaths: answer === null ? [] : [answer],
          });
        Object.defineProperty(dialog, "showOpenDialog", { configurable: true, value: open });
      }, folder);
    },
    stubFinder: async () => {
      await electron.evaluate(({ shell }) => {
        const revealed: string[] = [];
        Object.defineProperty(globalThis, "__gandalfRevealed", {
          configurable: true,
          value: revealed,
        });
        Object.defineProperty(shell, "showItemInFolder", {
          configurable: true,
          value: (path: string) => revealed.push(path),
        });
      });
      return () =>
        electron.evaluate(
          () => (globalThis as { __gandalfRevealed?: string[] }).__gandalfRevealed ?? [],
        );
    },
    setTheme: async (source) => {
      const dark = await electron.evaluate(({ nativeTheme }, themeSource) => {
        nativeTheme.themeSource = themeSource;
        return nativeTheme.shouldUseDarkColors;
      }, source);
      await page.waitForFunction(
        (wanted) => matchMedia("(prefers-color-scheme: dark)").matches === wanted,
        dark,
      );
    },
    setReduceTransparency: async (on) => {
      await electron.evaluate(({ nativeTheme }, value) => {
        Object.defineProperty(nativeTheme, "prefersReducedTransparency", {
          configurable: true,
          get: () => value,
        });
        nativeTheme.emit("updated");
      }, on);
      await page.waitForFunction(
        (wanted) => document.documentElement.hasAttribute("data-reduce-transparency") === wanted,
        on,
      );
    },
    pushSnapshot: async (result) => {
      await send(channels.snapshotPushed, result);
    },
    resize: async (width, height) => {
      await electron.evaluate(
        ({ BrowserWindow }, [id, w, h]) => BrowserWindow.fromId(id)?.setSize(w, h),
        [windowId, width, height] as const,
      );
      await page.waitForFunction(([w, h]) => window.innerWidth === w && window.innerHeight === h, [
        width,
        height,
      ] as const);
    },
    show,
    backdrop: async () => {
      const backdropId = await electron.evaluate(
        async ({ app: electronApp, BrowserWindow }, [id, html, margin]) => {
          const window = BrowserWindow.fromId(id);
          if (window === null) throw new Error("the app window is gone");
          const { x, y, width, height } = window.getBounds();
          const backdrop = new BrowserWindow({
            x: x - margin,
            y: y - margin,
            width: width + 2 * margin,
            height: height + 2 * margin,
            frame: false,
            roundedCorners: false,
            focusable: false,
            hasShadow: false,
            show: false,
          });
          await backdrop.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
          backdrop.setAlwaysOnTop(true, "floating");
          backdrop.showInactive();
          window.setAlwaysOnTop(true, "pop-up-menu");
          window.show();
          electronApp.focus({ steal: true });
          window.focus();
          return backdrop.id;
        },
        [windowId, BACKDROP_HTML, MARGIN] as const,
      );
      await delay(1500);
      return async () => {
        await electron.evaluate(
          ({ BrowserWindow }, [id, backdrop]) => {
            BrowserWindow.fromId(backdrop)?.destroy();
            BrowserWindow.fromId(id)?.setAlwaysOnTop(false);
          },
          [windowId, backdropId] as const,
        );
      };
    },
    regionShot: async (slug) => {
      await show();
      await requireScreenRecording(app);
      const { x, y, width, height } = await bounds();
      const path = await shotPath(slug);
      const region = [x - MARGIN, y - MARGIN, width + 2 * MARGIN, height + 2 * MARGIN].join(",");
      await screencapture(["-x", `-R${region}`, path]);
      return path;
    },
    syncButton: () => page.locator("header").getByRole("button"),
    sheet: () => page.getByRole("dialog"),
    toggleCell: async (skill, agent) => {
      await showSkill(skill);
      await checkbox(skill, agent).click();
      const sheet = page.getByRole("dialog");
      await sheet.waitFor();
      return sheet;
    },
    cellStatus: async (skill, agent) => {
      await showSkill(skill);
      const box = checkbox(skill, agent);
      const glyph = await box
        .locator("xpath=ancestor::li[@data-cell]")
        // The status glyph, not the agent's mark beside it.
        .locator("span.font-mono[aria-hidden=true]")
        .textContent();
      const description = await box.evaluate((input) =>
        (input.getAttribute("aria-describedby") ?? "")
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent ?? "")
          .join(" ")
          .trim(),
      );
      return `${glyph ?? ""} ${description}`;
    },
    applySheet: async () => {
      const sheet = page.getByRole("dialog");
      await sheet.getByRole("button", { name: "Apply" }).click();
      await sheet.waitFor({ state: "hidden" });
    },
    close: () => stop(electron, userData),
  };
  return app;
}

export interface Holder {
  readonly pid: number;
  readonly since: Date;
}

/**
 * Writes ~/.gandalf/lock as a live gandalf would, so an apply in that HOME reports busy. The pid
 * defaults to this test process, which stays alive while the lock is held.
 */
export async function holdLock(
  home: string,
  { pid = process.pid, since = new Date() }: Partial<Holder> = {},
): Promise<() => Promise<void>> {
  const lock = join(await isolatedHome(home), ".gandalf", "lock");
  await mkdir(join(lock, ".."), { recursive: true });
  await writeFile(lock, JSON.stringify({ pid, since: since.toISOString() }), { flag: "wx" });
  return () => rm(lock, { force: true });
}

/** Quits the app, then removes its userData unless the caller owns it (undefined). */
async function stop(
  electron: ElectronApplication | undefined,
  userData: string | undefined,
): Promise<void> {
  try {
    await electron?.close();
  } finally {
    if (userData !== undefined) await rm(userData, { recursive: true, force: true });
  }
}

export async function withApp<T>(
  options: LaunchOptions,
  work: (app: App) => Promise<T>,
): Promise<T> {
  const app = await launchApp(options);
  try {
    return await work(app);
  } finally {
    await app.close();
  }
}

export async function osShot(app: App, path: string): Promise<string> {
  await app.show();
  await captureWindow(app, path);
  return path;
}

export interface CliResult {
  readonly code: number;
  readonly json: unknown;
  readonly stderr: string;
}

export interface CliOptions {
  /** The CLI's TMPDIR. One on another device than HOME makes it probe symlinks in HOME's folders. */
  readonly tmpdir?: string;
}

export async function gandalfCli(
  home: string,
  args: readonly string[],
  { tmpdir: cliTmpdir }: CliOptions = {},
): Promise<CliResult> {
  const cwd = await isolatedHome(home);
  const options = {
    cwd,
    env: {
      ...process.env,
      HOME: cwd,
      GIT_CONFIG_NOSYSTEM: "1",
      ...(cliTmpdir === undefined ? {} : { TMPDIR: cliTmpdir }),
    },
    timeout: CLI_TIMEOUT_MS,
  };
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI_BIN, "--json", ...args], options);
    return { code: 0, json: stdout.trim() === "" ? null : JSON.parse(stdout), stderr };
  } catch (error) {
    const failed = error as { code?: unknown; killed?: boolean; stdout?: string; stderr?: string };
    if (failed.killed === true) {
      throw new Error(`gandalf ${args.join(" ")} ran longer than ${CLI_TIMEOUT_MS} ms`, {
        cause: error,
      });
    }
    if (typeof failed.code !== "number") throw error;
    const stdout = failed.stdout ?? "";
    return {
      code: failed.code,
      json: stdout.trim() === "" ? null : JSON.parse(stdout),
      stderr: failed.stderr ?? "",
    };
  }
}

async function isolatedHome(home: string): Promise<string> {
  if (!isAbsolute(home)) {
    throw new Error(`home must be an absolute path, got ${JSON.stringify(home)}`);
  }
  const real = await realpath(home).catch((error: unknown) => {
    throw new Error(`home ${home} does not exist. Seed a throwaway one with seedHome.`, {
      cause: error,
    });
  });
  const temp = await realpath(tmpdir());
  if (!real.startsWith(temp + sep)) {
    throw new Error(
      `home ${home} is not inside the OS temp dir ${temp}. Seed a throwaway one with seedHome.`,
    );
  }
  return home;
}

async function cgWindowId(app: App): Promise<string> {
  const mediaId = await app.electron.evaluate(({ BrowserWindow }, id) => {
    const window = BrowserWindow.fromId(id);
    if (window === null) throw new Error("the app window is gone");
    return window.getMediaSourceId();
  }, app.windowId);
  const cgId = mediaId.split(":")[1];
  if (cgId === undefined) throw new Error(`no window id in media source ${mediaId}`);
  return cgId;
}

/**
 * Without Screen Recording, `screencapture -R` silently drops other apps' windows, so probe with a
 * window capture, which fails outright instead.
 */
async function requireScreenRecording(app: App): Promise<void> {
  const probe = join(tmpdir(), `gandalf-probe-${process.pid}-${Date.now()}.png`);
  try {
    await captureWindow(app, probe);
  } finally {
    await rm(probe, { force: true });
  }
}

const CAPTURE_ATTEMPTS = 5;
const CAPTURE_RETRY_MS = 400;

async function captureWindow(app: App, path: string): Promise<void> {
  const windowId = await cgWindowId(app);
  for (let attempt = 1; ; attempt += 1) {
    try {
      await run("screencapture", ["-x", "-o", "-l", windowId, path]);
      return;
    } catch (error) {
      if (!couldNotCreateImage(error)) {
        throw new Error(`screencapture failed. (${detail(error)})`, { cause: error });
      }
      if (attempt === CAPTURE_ATTEMPTS) {
        throw new Error(
          "screencapture could not capture the app window. Either this terminal lacks Screen " +
            "Recording (grant it in System Settings > Privacy & Security > Screen Recording, then " +
            `rerun) or the window is not on the current screen. (${detail(error)})`,
          { cause: error },
        );
      }
      await delay(CAPTURE_RETRY_MS);
    }
  }
}

/** A window shown moments ago can fail this way until macOS has composited it. */
function couldNotCreateImage(error: unknown): boolean {
  const { stderr } = error as { stderr?: unknown };
  return typeof stderr === "string" && stderr.includes("could not create image from window");
}

async function screencapture(args: readonly string[]): Promise<void> {
  try {
    await run("screencapture", args);
  } catch (error) {
    throw new Error(`screencapture failed. (${detail(error)})`, { cause: error });
  }
}

function detail(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).trim();
}
