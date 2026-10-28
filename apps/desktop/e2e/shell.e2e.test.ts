import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Locator } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listTree, seedHome, withHome } from "./homes";
import { gandalfCli, launchApp, osShot, withApp, type App } from "./lever";

interface AgentJson {
  readonly installed: boolean;
  readonly readError: string | null;
}

function style(locator: Locator, property: string): Promise<string> {
  return locator.evaluate(
    (element, name) => getComputedStyle(element).getPropertyValue(name),
    property,
  );
}

async function cliCounts(home: string): Promise<[number, number]> {
  const skills = (await gandalfCli(home, ["skills", "list"])).json as readonly unknown[];
  const { agents } = (await gandalfCli(home, ["agents"])).json as { agents: readonly AgentJson[] };
  return [skills.length, agents.filter((a) => a.installed && a.readError === null).length];
}

const reduceTransparencyShown = (app: App) =>
  app.page.evaluate(() => document.documentElement.hasAttribute("data-reduce-transparency"));

describe("the shell on the twoAgents HOME", () => {
  let home = "";
  let app: App;
  let before: string[] = [];
  const sidebar = () => app.page.getByRole("navigation", { name: "Sections" });
  const sync = () => app.syncButton();

  beforeAll(async () => {
    home = await seedHome("twoAgents");
    before = await listTree(home);
    app = await launchApp({ home });
  });

  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      if (home !== "") await rm(home, { recursive: true, force: true });
    }
  });

  it("shows the skill and agent counts the CLI reports, in a live region", async () => {
    expect(await cliCounts(home)).toEqual([1, 2]);
    expect(await app.countLine()).toBe("1 skill");
    const status = app.page.locator("header").getByRole("status");
    await expect.poll(() => status.textContent()).toBe("1 skill · Nothing to sync");
    expect(
      await app.page
        .getByRole("option")
        .evaluateAll((options) => options.map((option) => option.getAttribute("data-skill"))),
    ).toEqual(["demo"]);
  });

  it("reads the screen title before the rows", async () => {
    const tree = await app.page.getByRole("main").ariaSnapshot();
    const title = tree.indexOf('heading "Library"');
    const rows = tree.indexOf('listbox "Skills"');
    expect(title).toBeGreaterThanOrEqual(0);
    expect(rows).toBeGreaterThan(title);
  });

  it("floats the glass sidebar 8px inside the window with the screens and Settings", async () => {
    // The Projects heading's add button sits between the screens and Settings, with no projects.
    expect(
      await sidebar()
        .getByRole("button")
        .evaluateAll((buttons) =>
          buttons.map((button) => button.getAttribute("aria-label") ?? button.textContent),
        ),
    ).toEqual(["Library", "Discover", "Install", "Add Project…", "Settings"]);
    const box = await sidebar().boundingBox();
    const height = await app.page.evaluate(() => window.innerHeight);
    expect(box).toMatchObject({ x: 8, y: 8, width: 220, height: height - 16 });
    expect(await style(sidebar(), "border-radius")).toBe("18px");
    expect(await style(sidebar(), "backdrop-filter")).toContain("blur(28px)");
  });

  it("paints the content pane opaque and holds a disabled Sync in a glass capsule", async () => {
    expect(await style(app.page.getByRole("main"), "background-color")).toBe("rgb(255, 255, 255)");
    expect(await sync().textContent()).toBe("Sync");
    expect(await style(sync().locator(".."), "backdrop-filter")).toContain("blur(20px)");
  });

  for (const theme of ["light", "dark"] as const) {
    it(`dims a disabled Sync to half its enabled look in ${theme}`, async () => {
      await app.setTheme(theme);
      try {
        await app.page.getByText("· Nothing to sync").waitFor({ timeout: 10_000 });
        expect(await sync().isDisabled()).toBe(true);
        expect(await style(sync(), "opacity")).toBe("0.5");
        expect(await style(sync(), "pointer-events")).toBe("none");
        expect(await style(sync(), "background-color")).toBe("rgb(204, 70, 48)");
        expect(await style(sync(), "color")).toBe("rgb(255, 255, 255)");
      } finally {
        await app.setTheme("light");
      }
    });
  }

  it("fills a bg-primary button with coral", async () => {
    const fill = await app.page.evaluate(() => {
      const probe = document.createElement("button");
      probe.className = "bg-primary";
      document.body.append(probe);
      const color = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return color;
    });
    expect(fill).toBe("rgb(204, 70, 48)");
  });

  it("gives the renderer no Node and only window.gandalf", async () => {
    expect(
      await app.page.evaluate(() => [
        typeof (window as { require?: unknown }).require,
        typeof (window as { process?: unknown }).process,
        typeof window.gandalf.snapshot,
      ]),
    ).toEqual(["undefined", "undefined", "function"]);
    const preferences = await app.electron.evaluate(({ BrowserWindow }, id) => {
      const contents = BrowserWindow.fromId(id)?.webContents as
        { getLastWebPreferences?: () => Electron.WebPreferences | null } | undefined;
      const last = contents?.getLastWebPreferences?.();
      return {
        sandbox: last?.sandbox,
        contextIsolation: last?.contextIsolation,
        nodeIntegration: last?.nodeIntegration,
      };
    }, app.windowId);
    expect(preferences).toEqual({ sandbox: true, contextIsolation: true, nodeIntegration: false });
  });

  it("runs main with the seeded HOME as its home directory", async () => {
    expect(
      await app.electron.evaluate(({ app: electronApp }) => [
        electronApp.getPath("home"),
        process.env.HOME,
        process.getBuiltinModule("node:os").homedir(),
      ]),
    ).toEqual([home, home, home]);
  });

  it("blocks inline scripts under the production CSP", async () => {
    const ran = await app.page.evaluate(() => {
      const script = document.createElement("script");
      script.textContent = "document.documentElement.dataset.inlineRan = 'yes'";
      document.head.append(script);
      script.remove();
      return document.documentElement.dataset.inlineRan === "yes";
    });
    expect(ran).toBe(false);
  });

  it("walks the sidebar with Tab, arrow keys and Enter behind a 2px coral focus ring", async () => {
    const { page } = app;
    await page.keyboard.press("Tab");
    // Settings sits between Install and Library, so the walk steps over it on the way round.
    for (const [screen, steps] of [
      ["Discover", 1],
      ["Install", 1],
      ["Library", 2],
    ] as const) {
      for (let step = 0; step < steps; step++) await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
      await expect.poll(() => page.getByRole("heading", { level: 1 }).textContent()).toBe(screen);
      const focused = page.locator(":focus");
      expect(await focused.getAttribute("aria-current")).toBe("page");
      expect(await style(focused, "outline")).toBe("rgb(181, 59, 37) solid 2px");
      expect(await style(focused, "outline-offset")).toBe("1px");
    }
  });

  it("fills glass with the opaque sidebar color under Reduce Transparency", async () => {
    await app.setReduceTransparency(true);
    for (const glass of [sidebar(), sync().locator("..")]) {
      expect(await style(glass, "background-color")).toBe("rgb(228, 228, 231)");
      expect(await style(glass, "backdrop-filter")).toBe("none");
    }
    await app.setTheme("dark");
    expect(await reduceTransparencyShown(app)).toBe(true);
    await app.setTheme("light");
    expect(await reduceTransparencyShown(app)).toBe(true);
    await app.page.reload();
    await app.countLine();
    expect(await reduceTransparencyShown(app)).toBe(true);
    await app.setReduceTransparency(false);
    expect(await style(sidebar(), "backdrop-filter")).toContain("blur(28px)");
  });

  it("follows the system appearance into dark", async () => {
    await app.setTheme("dark");
    expect(await style(app.page.getByRole("main"), "background-color")).toBe("rgb(30, 30, 30)");
    expect(await style(sidebar(), "background-color")).toBe("rgba(58, 58, 60, 0.45)");
    await app.setTheme("light");
  });

  it("reports how long main's snapshot took", async () => {
    expect(await app.timing("snapshot")).toBeGreaterThan(0);
  });

  it("opens no other window and stays on its page", async () => {
    const { page } = app;
    const url = page.url();
    expect(await page.evaluate(() => window.open("about:blank") === null)).toBe(true);
    await page.evaluate(() => {
      location.href = new URL("./elsewhere.html", location.href).href;
    });
    await page.waitForTimeout(500);
    expect(app.electron.windows()).toHaveLength(1);
    expect(page.url()).toBe(url);
    expect(await page.getByRole("heading", { level: 1 }).textContent()).toBe("Library");
  });

  for (const [error, title, action] of [
    [
      { kind: "git", message: "fatal: repository not found" },
      "A git command failed",
      "Some changes may already be applied. Click Sync to see what is left.",
    ],
    [
      { kind: "badInput", field: "agents", message: "agents: must be a list" },
      "gandalf rejected the request",
      "Nothing changed. Try again. If it happens again, report the message above.",
    ],
    [
      { kind: "internal", message: "pushed failure" },
      "gandalf hit an unexpected error",
      "Quit and reopen gandalf. If it happens again, report the message above.",
    ],
  ] as const) {
    it(`replaces the view with the ${error.kind} banner, which says what to do`, async () => {
      await app.pushSnapshot({ ok: false, error });
      const alert = app.page.getByRole("alert");
      await expect.poll(() => alert.textContent()).toContain(error.message);
      expect(await alert.locator(":scope > div > span").allTextContents()).toEqual([
        title,
        error.message,
        action,
      ]);
    });
  }

  it("replaces the view with the stateCorrupt banner, which says what to do", async () => {
    const error = { kind: "stateCorrupt", path: "~/.gandalf/state.json", reason: "not JSON" };
    await app.pushSnapshot({ ok: false, error });
    const alert = app.page.getByRole("alert");
    await expect.poll(() => alert.textContent()).toContain(error.reason);
    expect(await alert.locator(":scope > div > span").allTextContents()).toEqual([
      "gandalf cannot read its state file",
      error.path,
      error.reason,
      "Fix the file or move it aside, then reopen gandalf. Until then gandalf changes no skills " +
        "or agent folders.",
    ]);
  });

  it("never wrote under HOME", async () => {
    expect(await listTree(home)).toEqual(before);
  });
});

describe("the sidebar toggle", () => {
  it("hides and shows the sidebar by button and by Control-Command-S, keeping the title clear", async () => {
    await withHome("twoAgents", (home) =>
      withApp({ home }, async (app) => {
        const sidebar = app.page.getByRole("navigation", { name: "Sections" });
        const title = app.page.getByRole("heading", { name: "Library" });
        await app.countLine();
        const hide = app.page.getByRole("button", { name: "Hide Sidebar" });
        expect(await hide.getAttribute("aria-expanded")).toBe("true");
        await hide.click();
        await sidebar.waitFor({ state: "hidden" });
        const show = app.page.getByRole("button", { name: "Show Sidebar" });
        const toggleBox = await show.boundingBox();
        const titleBox = await title.boundingBox();
        // Past the traffic lights and the toggle, with the toggle where it was.
        expect(titleBox!.x).toBeGreaterThan(toggleBox!.x + toggleBox!.width);
        expect(toggleBox).toMatchObject({ x: 84, y: 15 });

        await app.page.keyboard.press("Control+Meta+s");
        await sidebar.waitFor();
        expect((await title.boundingBox())!.x).toBe(256);

        // Hiding from inside the list leaves focus on the toggle, not in a hidden list.
        await sidebar.getByRole("button", { name: "Library" }).focus();
        await app.page.keyboard.press("Control+Meta+s");
        await sidebar.waitFor({ state: "hidden" });
        expect(await show.evaluate((button) => button === document.activeElement)).toBe(true);
      }),
    );
  });
});

describe("the shell on the empty HOME", () => {
  it("shows the empty library and writes nothing", async () => {
    await withHome("empty", (home) =>
      withApp({ home }, async (app) => {
        await app.page.getByText("The library is empty.").waitFor();
        expect(await app.countLine()).toBe("0 skills");
        expect(await listTree(home)).toEqual([]);
      }),
    );
  });
});

describe("the shell on a HOME whose state.json is corrupt", () => {
  it("names the state file under ~ and the reason in a banner and keeps running", async () => {
    await withHome("twoAgents", async (home) => {
      await writeFile(join(home, ".gandalf/state.json"), "{ not json");
      const cli = await gandalfCli(home, ["status"]);
      const reason = /is unreadable \((.+)\)\. gandalf will not write/.exec(cli.stderr)?.[1];
      if (reason === undefined) throw new Error(`the CLI named no reason: ${cli.stderr}`);
      await withApp({ home }, async (app) => {
        const banner = app.page.getByRole("alert");
        await banner.waitFor();
        const text = (await banner.textContent()) ?? "";
        expect(text.startsWith("gandalf cannot read its state file")).toBe(true);
        expect(text).toContain("~/.gandalf/state.json");
        expect(text).not.toContain(home);
        expect(text).toContain(reason);
        expect(app.electron.windows()).toHaveLength(1);
      });
    });
  });
});

describe("the shell on the realShaped HOME", () => {
  it("counts 12 agents over 220 entries", async () => {
    await withHome("realShaped", (home) =>
      withApp({ home }, async (app) => {
        const entries = (await gandalfCli(home, ["skills", "scan"])).json as readonly unknown[];
        expect(entries).toHaveLength(220);
        expect(await cliCounts(home)).toEqual([12, 12]);
        expect(await app.countLine()).toBe("12 skills");
        // Three screens, the Projects heading's add button and Settings.
        expect(
          await app.page.getByRole("navigation", { name: "Sections" }).getByRole("button").count(),
        ).toBe(5);
      }),
    );
  });
});

describe("the shell on the manySkills HOME", () => {
  it("keeps the title clear while 200 rows scroll under the toolbar", async () => {
    await withHome("manySkills", (home) =>
      withApp({ home }, async (app) => {
        const { page } = app;
        expect(await app.countLine()).toBe("200 skills");
        expect(await page.getByRole("option").count()).toBe(200);
        await page.getByText("· Nothing to sync").waitFor();
        await app.resize(720, 480);
        const main = await page.getByRole("main").boundingBox();
        const heading = await page.getByRole("heading", { level: 1 }).boundingBox();
        const capsule = await app.syncButton().locator("..").boundingBox();
        if (main === null || heading === null || capsule === null) throw new Error("no toolbar");
        const titleBand = {
          x: main.x,
          y: 0,
          width: capsule.x - main.x,
          height: Math.ceil(heading.y + heading.height),
        };
        const rowUnderTitle = () =>
          page.evaluate(
            ([x, y]) =>
              document
                .elementsFromPoint(x, y)
                .some((element) => element.closest('[role="listbox"]') !== null),
            [heading.x + heading.width / 2, heading.y + heading.height / 2] as const,
          );
        expect(await rowUnderTitle()).toBe(false);
        const atTop = await page.screenshot({ clip: titleBand });
        const scrolled = await page.getByRole("listbox", { name: "Skills" }).evaluate((list) => {
          const scroller = list.parentElement;
          if (scroller === null) return 0;
          scroller.scrollTop = 400;
          return scroller.scrollTop;
        });
        expect(scrolled).toBe(400);
        await page.evaluate(() => new Promise(requestAnimationFrame));
        expect(await rowUnderTitle()).toBe(true);
        expect((await page.screenshot({ clip: titleBand })).equals(atTop)).toBe(true);
      }),
    );
  });
});

describe("the shell when main fails it", () => {
  it("shows an error banner when the snapshot call itself rejects", async () => {
    await withHome("twoAgents", (home) =>
      withApp({ home }, async (app) => {
        await app.countLine();
        // The watcher pushes again after the reads that start its watches, and a push rightly
        // replaces a failed read with fresh data. Pushes stop too, so only the rejection shows.
        await app.electron.evaluate(({ BrowserWindow, ipcMain }, id) => {
          ipcMain.removeHandler("gandalf:snapshot");
          const contents = BrowserWindow.fromId(id)?.webContents;
          if (contents === undefined) throw new Error("the app window is gone");
          const send = contents.send.bind(contents);
          contents.send = (channel, ...args) => {
            if (channel !== "gandalf:snapshot-pushed") send(channel, ...args);
          };
        }, app.windowId);
        await app.page.reload();
        const banner = app.page.getByRole("alert");
        await banner.waitFor({ timeout: 5_000 });
        expect(await banner.textContent()).toContain("gandalf hit an unexpected error");
        expect(await banner.textContent()).toContain("Quit and reopen gandalf.");
        // Past the watcher's 1 s longest wait, the banner is still the one on screen.
        await app.page.waitForTimeout(1_200);
        expect(await banner.textContent()).toContain("gandalf hit an unexpected error");
      }),
    );
  });

  it("says the window is gone instead of blaming Screen Recording", async () => {
    await withHome("empty", (home) =>
      withApp({ home }, async (app) => {
        await app.electron.evaluate(({ BrowserWindow }, id) => {
          new BrowserWindow({ show: false });
          BrowserWindow.fromId(id)?.destroy();
        }, app.windowId);
        const shot = osShot(app, join(tmpdir(), `gandalf-gone-${process.pid}.png`));
        await expect(shot).rejects.toThrow("the app window is gone");
      }),
    );
  });
});

const ELECTRON_BIN: string = createRequire(import.meta.url)("electron");
const APP_DIR = fileURLToPath(new URL("..", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const LEVER = fileURLToPath(new URL("./lever.ts", import.meta.url));

function startMain(env: Readonly<Record<string, string>>): Promise<{
  readonly code: number | null;
  readonly stderr: string;
}> {
  const base = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key !== "ELECTRON_RUN_AS_NODE"),
  );
  return new Promise((resolve) => {
    execFile(
      ELECTRON_BIN,
      [APP_DIR],
      { env: { ...base, ...env }, timeout: 10_000 },
      (error, _stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === "number" ? error.code : null;
        resolve({ code, stderr });
      },
    );
  });
}

describe("main and the lever refuse a HOME that is not an isolated absolute path", () => {
  for (const [label, value] of [
    ["an empty", ""],
    ["a relative", "relative/home"],
  ] as const) {
    it(`main exits 1 on ${label} GANDALF_HOME`, async () => {
      const scratch = await mkdtemp(join(tmpdir(), "gandalf-refuse-"));
      try {
        const result = await startMain({
          HOME: scratch,
          GANDALF_HOME: value,
          GANDALF_USER_DATA: join(scratch, "user-data"),
          GANDALF_HIDDEN: "1",
        });
        expect(result.code).toBe(1);
        expect(result.stderr).toContain("GANDALF_HOME must be an absolute path");
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    });
  }

  it("launchApp and gandalfCli reject a relative home and any folder not strictly inside the OS temp dir", async () => {
    await expect(launchApp({ home: "relative/home" })).rejects.toThrow("absolute");
    for (const home of [homedir(), REPO_ROOT, "/", tmpdir()]) {
      await expect(launchApp({ home })).rejects.toThrow("not inside the OS temp dir");
      await expect(gandalfCli(home, ["status"])).rejects.toThrow("not inside the OS temp dir");
    }
  });
});

describe("the lever records video", () => {
  it("fails fast, naming the missing ffmpeg, when Playwright has none", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "gandalf-no-ffmpeg-"));
    try {
      const script = [
        `const { launchApp } = await import(${JSON.stringify(LEVER)});`,
        `await launchApp({ home: ${JSON.stringify(scratch)}, recordVideo: { dir: ${JSON.stringify(scratch)} } });`,
      ].join("\n");
      const result = await new Promise<{ readonly killed: boolean; readonly stderr: string }>(
        (resolve) => {
          execFile(
            process.execPath,
            ["--import", "tsx", "--input-type=module", "-e", script],
            {
              cwd: APP_DIR,
              env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: join(scratch, "browsers") },
              timeout: 20_000,
            },
            (error, _stdout, stderr) => resolve({ killed: error?.killed === true, stderr }),
          );
        },
      );
      expect(result.killed).toBe(false);
      expect(result.stderr).toContain(
        `recordVideo needs Playwright's ffmpeg at ${join(scratch, "browsers")}/`,
      );
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it("writes a non-empty webm of the window when recordVideo is set", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gandalf-video-"));
    try {
      await withHome("empty", (home) =>
        withApp({ home, recordVideo: { dir } }, async (app) => {
          await app.page.getByText("The library is empty.").waitFor({ timeout: 10_000 });
          await app.page.waitForTimeout(500);
        }),
      );
      const videos = (await readdir(dir)).filter((name) => name.endsWith(".webm"));
      expect(videos).toHaveLength(1);
      expect((await stat(join(dir, videos[0] ?? ""))).size).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
