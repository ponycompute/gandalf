import { execFile } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import type { Locator } from "playwright";
import { describe, expect, it } from "vitest";
import { planError } from "../../../packages/cli/src/render";
import { listTree, withHome } from "./homes";
import { findOnPath, isExecutable } from "../src/main/path";
import { gandalfCli, withApp, type App } from "./lever";

// The gitSource fixture runs the core's git in this process. Keep it off the system git config, as
// the lever does for the app and the CLI; HOME is the lane's own.
process.env.GIT_CONFIG_NOSYSTEM = "1";

const run = promisify(execFile);

/** Homebrew's git on Apple silicon, which main must prefer over /usr/bin's from a Finder launch. */
const HOMEBREW_GIT = await stat("/opt/homebrew/bin/git").then(
  (file) => file.isFile(),
  () => false,
);

/** Runs git in a lane's HOME with no system or user config but the lane's. */
async function git(home: string, cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run(
    "git",
    ["-c", "user.name=gandalf-e2e", "-c", "user.email=e2e@gandalf.invalid", ...args],
    { cwd, env: { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: "1" } },
  );
  return stdout.trim();
}

/** Turns on main's check for updates, half a second after the window shows. */
const CHECK_SOON = { GANDALF_UPDATE_CHECKS: "on", GANDALF_FIRST_UPDATE_CHECK_MS: "500" };

/** A Library menu item as the menu bar shows it now. */
function menuItem(app: App, id: string) {
  return app.electron.evaluate(({ Menu }, at) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(at);
    return item === null || item === undefined ? null : { label: item.label, enabled: item.enabled };
  }, id);
}

/** Picks a menu bar item as a click on it would. */
async function clickMenuItem(app: App, id: string): Promise<void> {
  await app.electron.evaluate(({ Menu }, at) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(at);
    if (item === null || item === undefined) throw new Error(`no menu item ${at}`);
    item.click();
  }, id);
}

function skillMd(name: string, description: string, body = ""): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;
}

async function writeSkill(dir: string, contents: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), contents);
  return dir;
}

function exists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false,
  );
}

/** Commits `files` in the fixture's work tree on `branch` and pushes it to the bare repo. */
async function commit(
  home: string,
  branch: string,
  files: Readonly<Record<string, string>>,
): Promise<string> {
  const work = join(home, "repo-work");
  const current = await git(home, work, "rev-parse", "--abbrev-ref", "HEAD");
  if (current !== branch) {
    const known = await git(home, work, "branch", "--list", branch);
    await git(home, work, "checkout", "--quiet", ...(known === "" ? ["-b"] : []), branch);
  }
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(join(work, path, ".."), { recursive: true });
    await writeFile(join(work, path), contents);
  }
  await git(home, work, "add", ".");
  await git(home, work, "commit", "--quiet", "-m", `change ${branch}`);
  await git(home, work, "push", "--quiet", join(home, "review.git"), branch);
  return git(home, work, "rev-parse", "HEAD");
}

async function openInstall(app: App): Promise<Locator> {
  await app.countLine();
  await app.page
    .getByRole("navigation", { name: "Sections" })
    .getByRole("button", { name: "Install" })
    .click();
  const form = app.page.getByRole("form", { name: "Install a skill" });
  await form.waitFor();
  await form.getByRole("button", { name: "Local Folder" }).click();
  return form;
}

async function chooseGit(form: Locator, url: string, ref = "", subpath = ""): Promise<void> {
  await form.getByRole("button", { name: "Git Repository" }).click();
  await form.getByLabel("Repository", { exact: true }).fill(url);
  await form.getByLabel("Branch or tag").fill(ref);
  await form.getByLabel("Folder", { exact: true }).fill(subpath);
}

/** Clicks Install, waits for the sync sheet, and applies it. */
async function installAndApply(app: App, form: Locator): Promise<void> {
  await form.getByRole("button", { name: "Install" }).click();
  await app.sheet().waitFor();
  await app.applySheet();
}

const inspector = (app: App, name: string) =>
  app.page.getByRole("complementary", { name, exact: true });

/** Picks an item from the detail's ··· menu. */
async function chooseAction(panel: Locator, item: string): Promise<void> {
  await panel.getByRole("button", { name: /^More actions for / }).click();
  await panel.getByRole("menuitem", { name: item }).click();
}

async function select(app: App, name: string): Promise<Locator> {
  await app.page.locator(`[role="option"][data-skill="${name}"]`).click();
  const panel = inspector(app, name);
  await panel.waitFor();
  return panel;
}

/** The text after a term in Skill detail's facts, such as the commit. */
function fact(panel: Locator, term: string): Promise<string> {
  return panel
    .locator("dt", { hasText: new RegExp(`^${term}$`) })
    .locator("xpath=following-sibling::dd[1]")
    .innerText();
}

async function listJson(home: string): Promise<string> {
  return JSON.stringify((await gandalfCli(home, ["skills", "list"])).json)
    .replaceAll(home, "~")
    .replace(/"installedAt":"[^"]+"/g, "");
}

describe("Install puts a skill in the library from a folder or git", () => {
  it("installs a local folder into every agent, as the CLI's install does", async () => {
    await withHome("twoAgents", async (viaCli) => {
      await withHome("twoAgents", async (viaApp) => {
        for (const home of [viaCli, viaApp]) {
          await writeSkill(join(home, "src/notes"), skillMd("notes", "Project notes"));
        }
        expect(
          (await gandalfCli(viaCli, ["skills", "install", join(viaCli, "src/notes")])).code,
        ).toBe(0);
        await withApp({ home: viaApp }, async (app) => {
          const form = await openInstall(app);
          // A cancelled panel leaves the field as it was.
          await app.stubFolderPanel(null);
          await form.getByRole("button", { name: "Choose…" }).click();
          expect(await form.getByLabel("Folder", { exact: true }).inputValue()).toBe("");
          await app.stubFolderPanel(join(viaApp, "src/notes"));
          await form.getByRole("button", { name: "Choose…" }).click();
          // The chosen folder is written with ~, as the app writes every path in the home folder.
          await expect
            .poll(() => form.getByLabel("Folder", { exact: true }).inputValue())
            .toBe("~/src/notes");
          await form.getByRole("button", { name: "Install" }).click();
          const sheet = app.sheet();
          await sheet.waitFor();
          expect(await sheet.getByRole("heading", { level: 2 }).textContent()).toBe(
            "Install notes?",
          );
          await app.applySheet();
          // The app goes to the library with the new row selected and its detail open.
          await inspector(app, "notes").waitFor();
          expect(await app.cellStatus("notes", "Claude Code")).toBe("● Linked");
          expect(await app.cellStatus("notes", "Cursor")).toBe("● Linked");
          expect(await app.countLine()).toBe("2 skills");
        });
        expect(await listJson(viaApp)).toBe(await listJson(viaCli));
        expect(await listTree(join(viaApp, ".gandalf/skills"))).toEqual(
          await listTree(join(viaCli, ".gandalf/skills")),
        );
      });
    });
  });

  it("installs from git with a ref and a subpath and shows the pinned commit", async () => {
    await withHome("gitSource", async (home) => {
      const pinned = await commit(home, "release", {
        "skills/lint/SKILL.md": skillMd("lint", "Lint the diff", "release"),
      });
      // A later commit on main must not be what a ref of release installs.
      await commit(home, "main", { "skills/lint/SKILL.md": skillMd("lint", "Lint", "main") });
      await withApp({ home }, async (app) => {
        const form = await openInstall(app);
        await chooseGit(form, join(home, "review.git"), "release", "skills/lint");
        // Watch the button for its fetching state, however briefly a local fetch shows it.
        await app.page.evaluate(() => {
          const seen = ((window as { busySeen?: string[] }).busySeen = [] as string[]);
          new MutationObserver(() => {
            for (const button of document.querySelectorAll("button[aria-busy=true]")) {
              seen.push(button.textContent ?? "");
            }
          }).observe(document.body, { subtree: true, childList: true, attributes: true });
        });
        await installAndApply(app, form);
        const panel = inspector(app, "lint");
        await panel.waitFor();
        expect(await fact(panel, "Commit")).toBe(pinned.slice(0, 12));
        expect(await fact(panel, "Branch or tag")).toBe("release");
        expect(await fact(panel, "Folder")).toBe("skills/lint");
        expect(await panel.getByRole("region", { name: "SKILL.md" }).innerText()).toContain(
          "release",
        );
        const busy = await app.page.evaluate(() => (window as { busySeen?: string[] }).busySeen);
        expect(busy).toContain("Fetching…");
      });
    });
  });

  it("updates a git skill to the new commit and keeps its links", async () => {
    await withHome("gitSource", async (home) => {
      const before = await git(home, join(home, "repo-work"), "rev-parse", "HEAD");
      await withApp({ home }, async (app) => {
        await app.countLine();
        const panel = await select(app, "review");
        expect(await fact(panel, "Commit")).toBe(before.slice(0, 12));
        const after = await commit(home, "main", {
          "skills/review/SKILL.md": skillMd("review", "Review a PR", "v2"),
        });
        await chooseAction(panel, "Check for Updates");
        const sheet = app.sheet();
        await sheet.waitFor();
        expect(await sheet.getByRole("heading", { level: 2 }).textContent()).toBe("Update review?");
        expect(await sheet.innerText()).toContain(
          `${join(home, "review.git").replace(home, "~")} · ${before.slice(0, 7)} → ${after.slice(0, 7)}`,
        );
        await app.applySheet();
        await expect.poll(() => fact(panel, "Commit")).toBe(after.slice(0, 12));
        await expect
          .poll(() => panel.getByRole("region", { name: "SKILL.md" }).innerText())
          .toContain("v2");
      });
      for (const agent of [".claude", ".cursor"]) {
        const link = join(home, agent, "skills/review");
        expect(await realpath(link)).toBe(join(home, ".gandalf/skills/review"));
        expect(await readFile(join(link, "SKILL.md"), "utf8")).toContain("v2");
      }
    });
  });

  it("updates a skill from the folder it was installed from", async () => {
    await withHome("twoAgents", async (home) => {
      await withApp({ home }, async (app) => {
        await app.countLine();
        const panel = await select(app, "demo");
        await writeFile(join(home, "src/demo/SKILL.md"), skillMd("demo", "A demo skill", "v2"));
        await chooseAction(panel, "Check for Updates");
        const sheet = app.sheet();
        await sheet.waitFor();
        expect(await sheet.getByRole("heading", { level: 2 }).textContent()).toBe("Update demo?");
        expect(await sheet.innerText()).toContain("~/src/demo · the folder changed");
        await app.applySheet();
        await expect
          .poll(() => panel.getByRole("region", { name: "SKILL.md" }).innerText())
          .toContain("v2");
      });
      expect(await readFile(join(home, ".claude/skills/demo/SKILL.md"), "utf8")).toContain("v2");
    });
  });

  it("finds a new version by itself, and the count in the toolbar line opens Update All", async () => {
    await withHome("twoAgents", async (home) => {
      await writeFile(join(home, "src/demo/SKILL.md"), skillMd("demo", "A demo skill", "v2"));
      await withApp({ home, env: CHECK_SOON }, async (app) => {
        await app.countLine();
        const count = app.page.getByRole("status").getByRole("button", { name: "1 update" });
        await count.waitFor();
        await app.page.getByRole("button", { name: "Update demo" }).waitFor();
        expect(await menuItem(app, "updateAll")).toEqual({ label: "Update 1 Skill…", enabled: true });
        await count.click();
        const sheet = app.sheet();
        await sheet.waitFor();
        expect(await sheet.getByRole("heading", { level: 2 }).textContent()).toBe("Update demo?");
        expect(await sheet.innerText()).toContain("~/src/demo · the folder changed");
        await app.applySheet();
        await count.waitFor({ state: "detached" });
        expect(await app.page.getByRole("button", { name: "Update demo" }).count()).toBe(0);
        expect(await menuItem(app, "updateAll")).toEqual({ label: "Update All…", enabled: false });
      });
      expect(await readFile(join(home, ".claude/skills/demo/SKILL.md"), "utf8")).toContain("v2");
    });
  });

  it("updates one skill from its row's New version badge, without selecting the row", async () => {
    await withHome("twoAgents", async (home) => {
      await writeFile(join(home, "src/demo/SKILL.md"), skillMd("demo", "A demo skill", "v2"));
      await withApp({ home, env: CHECK_SOON }, async (app) => {
        await app.countLine();
        const badge = app.page.getByRole("button", { name: "Update demo" });
        await badge.waitFor();
        await badge.hover();
        expect(await badge.innerText()).toBe("Update");
        await badge.click();
        const sheet = app.sheet();
        await sheet.waitFor();
        expect(await sheet.getByRole("heading", { level: 2 }).textContent()).toBe("Update demo?");
        expect(await sheet.getByRole("button", { name: "Update", exact: true }).count()).toBe(1);
        await app.applySheet();
        await badge.waitFor({ state: "detached" });
        expect(await inspector(app, "demo").count()).toBe(0);
      });
      expect(await readFile(join(home, ".claude/skills/demo/SKILL.md"), "utf8")).toContain("v2");
    });
  });

  it("says every skill is up to date after Check for Updates in the Library menu", async () => {
    await withHome("twoAgents", async (home) => {
      await withApp({ home }, async (app) => {
        await app.countLine();
        expect(await menuItem(app, "checkForUpdates")).toEqual({
          label: "Check for Updates",
          enabled: true,
        });
        await clickMenuItem(app, "checkForUpdates");
        const sheet = app.sheet();
        await sheet.waitFor();
        expect(await sheet.getByRole("heading", { level: 2 }).textContent()).toBe(
          "Every skill is up to date",
        );
        expect(await sheet.innerText()).toContain(
          "gandalf checked 1 skill from git and folders. None has a newer version.",
        );
        await sheet.getByRole("button", { name: "Done" }).click();
        await sheet.waitFor({ state: "hidden" });
      });
    });
  });

  it("removes a skill into ~/.gandalf/trash and unlinks it from every agent", async () => {
    await withHome("twoAgents", async (home) => {
      await withApp({ home }, async (app) => {
        await app.countLine();
        const panel = await select(app, "demo");
        await chooseAction(panel, "Remove from Library…");
        const sheet = app.sheet();
        await sheet.waitFor();
        expect(await sheet.getByRole("heading", { level: 2 }).textContent()).toBe("Remove demo");
        await app.applySheet();
        await app.page.getByText("The library is empty.").waitFor();
        expect(await panel.count()).toBe(0);
      });
      const trash = join(home, ".gandalf/trash");
      const trashed = await readdir(trash, { recursive: true });
      expect(trashed.some((path) => path.endsWith("demo/SKILL.md"))).toBe(true);
      expect(await exists(join(home, ".gandalf/skills/demo"))).toBe(false);
      for (const agent of [".claude", ".cursor"]) {
        expect(await exists(join(home, agent, "skills/demo"))).toBe(false);
      }
    });
  });
});

describe("Install says what is wrong on the form and keeps it editable", () => {
  it("says a folder has no SKILL.md and changes nothing", async () => {
    await withHome("twoAgents", async (home) => {
      await mkdir(join(home, "src/empty"), { recursive: true });
      await writeFile(join(home, "src/empty/README.md"), "not a skill");
      const before = await listTree(home);
      await withApp({ home }, async (app) => {
        const form = await openInstall(app);
        const folder = form.getByLabel("Folder", { exact: true });
        await folder.fill("~/src/empty");
        await form.getByRole("button", { name: "Install" }).click();
        const help = form.getByText(
          "No SKILL.md in this folder. Choose a folder that contains one.",
        );
        await help.waitFor();
        expect(await folder.getAttribute("aria-invalid")).toBe("true");
        // Focus moves from the Install button to the field to fix.
        await expect
          .poll(() => folder.evaluate((field) => field === document.activeElement))
          .toBe(true);
        expect(await app.sheet().isVisible()).toBe(false);
        // Still editable: a new path clears the error, and a good one installs.
        await writeSkill(join(home, "src/good"), skillMd("good", "A good skill"));
        await folder.fill("~/src/good");
        expect(await help.count()).toBe(0);
        expect(await folder.getAttribute("aria-invalid")).toBeNull();
        await folder.fill("~/src/empty");
        await form.getByRole("button", { name: "Install" }).click();
        await help.waitFor();
        await app.settle();
      });
      const after = await listTree(home);
      expect(after.filter((line) => !line.startsWith("src/good"))).toEqual(before);
    });
  });

  it("shows nameTaken in the sheet in the CLI's words", async () => {
    await withHome("twoAgents", async (home) => {
      await writeSkill(join(home, "elsewhere/demo"), skillMd("demo", "Another demo"));
      const cli = await gandalfCli(home, ["skills", "install", join(home, "elsewhere/demo")]);
      expect(cli.code).not.toBe(0);
      const refused = (cli.json as { error: Parameters<typeof planError>[0] }).error;
      expect(refused.kind).toBe("nameTaken");
      // What the CLI prints for it without --json.
      const words = planError(refused);
      expect(words).toBe("the library already has a different skill named demo");
      await withApp({ home }, async (app) => {
        const form = await openInstall(app);
        await form.getByLabel("Folder", { exact: true }).fill(join(home, "elsewhere/demo"));
        await form.getByRole("button", { name: "Install" }).click();
        const sheet = app.sheet();
        await sheet.waitFor();
        expect((await sheet.innerText()).toLowerCase()).toContain(words);
        await sheet.getByRole("button", { name: "Close" }).click();
        await sheet.waitFor({ state: "hidden" });
        expect(await form.getByLabel("Folder", { exact: true }).inputValue()).toBe(
          join(home, "elsewhere/demo"),
        );
      });
    });
  });

  it("shows git's error for an unreachable repository and stays editable", async () => {
    await withHome("gitSource", async (home) => {
      await withApp({ home }, async (app) => {
        const form = await openInstall(app);
        const nowhere = join(home, "nowhere.git");
        await chooseGit(form, nowhere);
        await form.getByRole("button", { name: "Install" }).click();
        await form
          .getByText(
            "gandalf could not fetch this repository. Check the URL and the branch or tag, then click Install.",
          )
          .waitFor();
        // git's own message, with ~ for the home folder.
        expect(await form.innerText()).toContain("~/nowhere.git");
        expect(await form.innerText()).not.toContain(home);
        expect(
          await app.page.evaluate(() => document.activeElement?.getAttribute("aria-invalid")),
        ).toBe("true");
        expect(await app.sheet().isVisible()).toBe(false);
        const url = form.getByLabel("Repository", { exact: true });
        expect(await url.isEditable()).toBe(true);
        expect(await form.getByRole("button", { name: "Install" }).isEnabled()).toBe(true);
        await url.fill(join(home, "review.git"));
        await form.getByLabel("Folder", { exact: true }).fill("skills/review");
        await form.getByRole("button", { name: "Install" }).click();
        // The fixture installed review from this origin already, so the plan only re-records it.
        await app.sheet().waitFor();
      });
    });
  });

  /** Launches with a Finder-like PATH, installs from git, and returns main's git line. */
  const installWithMinimalPath = () =>
    withHome("gitSource", (home) =>
      withApp({ home, env: { PATH: "/usr/bin:/bin" } }, async (app) => {
        const form = await openInstall(app);
        await commit(home, "main", { "skills/lint/SKILL.md": skillMd("lint", "Lint the diff") });
        await chooseGit(form, join(home, "review.git"), "", "skills/lint");
        await installAndApply(app, form);
        await inspector(app, "lint").waitFor();
        return app.log().find((entry) => entry.startsWith("gandalf: git "));
      }),
    );

  it("installs from git when launched with a minimal PATH, and logs the git it runs", async () => {
    const line = await installWithMinimalPath();
    const git = line?.slice("gandalf: git ".length) ?? "";
    expect(git).toMatch(/^\/.+\/git$/);
    expect((await stat(git)).isFile()).toBe(true);
  });

  it.skipIf(!HOMEBREW_GIT)("uses Homebrew's git when launched with a minimal PATH", async () => {
    expect(await installWithMinimalPath()).toBe("gandalf: git /opt/homebrew/bin/git");
  });
});

describe("Skill detail inspects the selected library row", () => {
  it("scrolls a 2000-line SKILL.md inside the inspector, not the window", async () => {
    await withHome("twoAgents", async (home) => {
      const body = Array.from({ length: 2000 }, (_, n) => `Line ${n + 1} of the handbook.`);
      await writeSkill(
        join(home, "src/handbook"),
        skillMd("handbook", "House rules", body.join("\n")),
      );
      expect((await gandalfCli(home, ["skills", "install", join(home, "src/handbook")])).code).toBe(
        0,
      );
      await withApp({ home }, async (app) => {
        await app.countLine();
        const panel = await select(app, "handbook");
        const text = panel.getByRole("region", { name: "About handbook" });
        await text.getByText("Line 2000 of the handbook.").waitFor({ state: "attached" });
        const sizes = await text.evaluate((element) => ({
          scrollHeight: element.scrollHeight,
          clientHeight: element.clientHeight,
          scrollWidth: element.scrollWidth,
          clientWidth: element.clientWidth,
        }));
        expect(sizes.scrollHeight).toBeGreaterThan(sizes.clientHeight * 10);
        // Nothing in it scrolls sideways.
        expect(sizes.scrollWidth).toBeLessThanOrEqual(sizes.clientWidth);
        await text.hover();
        await app.page.mouse.wheel(0, 2000);
        await expect.poll(() => text.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
        const page = await app.page.evaluate(() => ({
          documentScroll: document.scrollingElement?.scrollTop ?? 0,
          documentHeight: document.documentElement.scrollHeight,
          innerHeight: window.innerHeight,
          panelBottom: document.querySelector("aside")?.getBoundingClientRect().bottom ?? Infinity,
        }));
        expect(page.documentScroll).toBe(0);
        expect(page.documentHeight).toBeLessThanOrEqual(page.innerHeight);
        expect(page.panelBottom).toBeLessThanOrEqual(page.innerHeight);
      });
    });
  });

  it("reveals the skill's library folder in Finder, and nothing outside the library", async () => {
    await withHome("twoAgents", async (home) => {
      await withApp({ home }, async (app) => {
        const revealed = await app.stubFinder();
        await app.countLine();
        const panel = await select(app, "demo");
        await chooseAction(panel, "Reveal in Finder");
        await expect.poll(revealed).toEqual([join(home, ".gandalf/skills/demo")]);
        for (const path of ["/etc", join(home, ".claude/skills/demo"), join(home, ".gandalf")]) {
          const result = await app.page.evaluate((dir) => window.gandalf.revealSkill(dir), path);
          expect(result).toMatchObject({ ok: false, error: { kind: "badInput", field: "path" } });
        }
        expect(await revealed()).toEqual([join(home, ".gandalf/skills/demo")]);
      });
    });
  });

  it("opens from the keyboard, follows the focused row, and closes with Escape", async () => {
    await withHome("twoAgents", async (home) => {
      await writeSkill(join(home, "src/notes"), skillMd("notes", "Project notes"));
      expect((await gandalfCli(home, ["skills", "install", join(home, "src/notes")])).code).toBe(0);
      await withApp({ home }, async (app) => {
        await app.countLine();
        await app.page.locator('[role="option"][data-skill="demo"]').focus();
        await inspector(app, "demo").waitFor();
        await app.page.keyboard.press("ArrowDown");
        await inspector(app, "notes").waitFor();
        // Tab leaves the list for the inspector's buttons.
        await app.page.keyboard.press("Tab");
        expect(
          await app.page.evaluate(() => document.activeElement?.closest("aside") !== null),
        ).toBe(true);
        await app.page.keyboard.press("Escape");
        await inspector(app, "notes").waitFor({ state: "detached" });
      });
    });
  });
});

/**
 * A git in front of the real one that holds every fetch until release(), or makes it fail with
 * git's words for an unknown ref after fail(). It stands in for a slow or hung network fetch; the
 * repository is still local. `env` is the PATH the app launches with: the fake first, then the
 * Homebrew folders so main does not put them in front of it.
 */
interface SlowGit {
  readonly env: Readonly<Record<string, string>>;
  /** Resolves once a fetch has started and is being held. */
  started(): Promise<void>;
  /** True once a held fetch went on to run git, false while held or after it was killed. */
  passed(): Promise<boolean>;
  hold(): Promise<void>;
  release(): Promise<void>;
  fail(): Promise<void>;
}

async function withSlowGit<T>(work: (git: SlowGit) => Promise<T>): Promise<T> {
  const real = findOnPath("git", process.env.PATH ?? "", isExecutable);
  if (real === null) throw new Error("no git on PATH for the slow git to run");
  const dir = await mkdtemp(join(tmpdir(), "gandalf-slow-git-"));
  const flag = (name: string) => join(dir, name);
  await writeFile(
    flag("git"),
    `#!/bin/sh
for arg; do
  if [ "$arg" = fetch ]; then
    : > "${flag("started")}"
    while [ ! -e "${flag("release")}" ] && [ ! -e "${flag("fail")}" ]; do sleep 0.05; done
    if [ -e "${flag("fail")}" ]; then echo "fatal: couldn't find remote ref nope" >&2; exit 128; fi
    : > "${flag("passed")}"
    break
  fi
done
exec "${real}" "$@"
`,
  );
  await chmod(flag("git"), 0o755);
  const slow: SlowGit = {
    env: { PATH: `${dir}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin` },
    started: () => expect.poll(() => exists(flag("started"))).toBe(true),
    passed: () => exists(flag("passed")),
    hold: async () => {
      for (const name of ["started", "passed", "release", "fail"])
        await rm(flag(name), { force: true });
    },
    release: () => writeFile(flag("release"), ""),
    fail: () => writeFile(flag("fail"), ""),
  };
  try {
    return await work(slow);
  } finally {
    await slow.release();
    await delay(200);
    await rm(dir, { recursive: true, force: true });
  }
}

const sidebar = (app: App, name: string) =>
  app.page.getByRole("navigation", { name: "Sections" }).getByRole("button", { name });

/** The current element's accessible bits, to assert where key focus is. */
function focused(app: App) {
  return app.page.evaluate(() => {
    const element = document.activeElement;
    return {
      tag: element?.tagName.toLowerCase() ?? "",
      id: element?.id ?? "",
      label: element?.getAttribute("aria-label") ?? "",
      skill: element?.getAttribute("data-skill") ?? null,
      text: element?.textContent ?? "",
      invalid: element?.getAttribute("aria-invalid") ?? null,
    };
  });
}

describe("A plan in progress can be cancelled and never lands somewhere else", () => {
  it("cancels a hung fetch with Cancel or Escape, and its late answer opens nothing", async () => {
    await withHome("gitSource", (home) =>
      withSlowGit(async (slow) => {
        await commit(home, "main", { "skills/lint/SKILL.md": skillMd("lint", "Lint the diff") });
        await withApp({ home, env: slow.env }, async (app) => {
          const form = await openInstall(app);
          await chooseGit(form, join(home, "review.git"), "", "skills/lint");
          await form.getByRole("button", { name: "Install" }).click();
          await slow.started();
          const busy = form.locator("button[aria-busy=true]");
          expect(await busy.textContent()).toBe("Fetching…");
          // Switching the segment does not rename what is running.
          await form.getByRole("button", { name: "Local Folder" }).click();
          expect(await busy.textContent()).toBe("Fetching…");
          await form.getByRole("button", { name: "Git Repository" }).click();

          await form.getByRole("button", { name: "Cancel" }).click();
          await busy.waitFor({ state: "detached" });
          expect((await focused(app)).text).toBe("Install");
          await slow.release();
          await delay(1500);
          expect(await app.sheet().isVisible()).toBe(false);
          // Main killed the fetch: released, it never went on to run git.
          expect(await slow.passed()).toBe(false);

          await slow.hold();
          await form.getByRole("button", { name: "Install" }).click();
          await slow.started();
          await app.page.keyboard.press("Escape");
          await busy.waitFor({ state: "detached" });
          await slow.release();
          await delay(1500);
          expect(await app.sheet().isVisible()).toBe(false);

          // Planning again after a cancel works, with the fetch let through.
          await form.getByRole("button", { name: "Install" }).click();
          await app.sheet().waitFor();
          expect(await app.sheet().getByRole("heading", { level: 2 }).textContent()).toBe(
            "Install lint?",
          );
        });
      }),
    );
  });

  it("lets a toggle on the Library replace a hung install, and keeps the form's draft", async () => {
    await withHome("gitSource", (home) =>
      withSlowGit(async (slow) => {
        await withApp({ home, env: slow.env }, async (app) => {
          const form = await openInstall(app);
          await chooseGit(form, join(home, "review.git"), "main", "skills/lint");
          await form.getByRole("button", { name: "Install" }).click();
          await slow.started();
          await sidebar(app, "Library").click();
          const sheet = await app.toggleCell("review", "Claude Code");
          expect(await sheet.getByRole("heading", { level: 2 }).textContent()).toBe(
            "Turn off review for Claude Code",
          );
          await sheet.getByRole("button", { name: "Cancel" }).click();
          await sheet.waitFor({ state: "hidden" });
          await slow.release();
          await delay(1500);
          // The install's answer was dropped with it: no sheet, and still on the Library.
          expect(await sheet.isVisible()).toBe(false);
          expect(await sidebar(app, "Library").getAttribute("aria-current")).toBe("page");
          await sidebar(app, "Install").click();
          expect(await form.getByLabel("Repository", { exact: true }).inputValue()).toBe(
            join(home, "review.git"),
          );
          expect(await form.getByLabel("Branch or tag").inputValue()).toBe("main");
          expect(await form.getByLabel("Folder", { exact: true }).inputValue()).toBe("skills/lint");
          expect(
            await form.getByRole("button", { name: "Install" }).getAttribute("aria-busy"),
          ).toBeNull();
        });
      }),
    );
  });

  it("brings Install back when its plan lands on another screen, sheet or error", async () => {
    await withHome("gitSource", (home) =>
      withSlowGit(async (slow) => {
        await commit(home, "main", { "skills/lint/SKILL.md": skillMd("lint", "Lint the diff") });
        await withApp({ home, env: slow.env }, async (app) => {
          const form = await openInstall(app);
          await chooseGit(form, join(home, "review.git"), "", "skills/lint");
          await form.getByRole("button", { name: "Install" }).click();
          await slow.started();
          await sidebar(app, "Library").click();
          await form.waitFor({ state: "detached" });
          await slow.release();
          await app.sheet().waitFor();
          expect(await sidebar(app, "Install").getAttribute("aria-current")).toBe("page");
          await app.sheet().getByRole("button", { name: "Cancel" }).click();
          await app.sheet().waitFor({ state: "hidden" });

          await slow.hold();
          await form.getByLabel("Branch or tag").fill("nope");
          await form.getByRole("button", { name: "Install" }).click();
          await slow.started();
          await sidebar(app, "Library").click();
          await form.waitFor({ state: "detached" });
          await slow.fail();
          const message = form.getByText(
            "The repository has no branch or tag named nope. Check the name, or leave it empty for the default branch.",
          );
          await message.waitFor();
          expect(await sidebar(app, "Install").getAttribute("aria-current")).toBe("page");
          await expect.poll(async () => (await focused(app)).invalid).toBe("true");
          expect(await form.getByLabel("Branch or tag").getAttribute("aria-invalid")).toBe("true");
          expect(
            await form.getByLabel("Repository", { exact: true }).getAttribute("aria-invalid"),
          ).toBeNull();
          // The error stays with the form across a visit elsewhere, and does not take focus again.
          await sidebar(app, "Library").click();
          await sidebar(app, "Install").click();
          await message.waitFor();
          await delay(300);
          expect(await focused(app)).toMatchObject({ tag: "button", invalid: null });
        });
      }),
    );
  });
});

describe("Install and Skill detail say what went wrong in the right place", () => {
  it("marks Folder for a folder the repository does not have, and refuses a relative URL", async () => {
    await withHome("gitSource", async (home) => {
      await withApp({ home }, async (app) => {
        const form = await openInstall(app);
        await chooseGit(form, join(home, "review.git"), "", "skills/nope");
        await form.getByRole("button", { name: "Install" }).click();
        await form
          .getByText(
            "The repository has no folder by this name. Check the spelling, or leave it empty when SKILL.md is at the top.",
          )
          .waitFor();
        expect(await form.getByLabel("Folder", { exact: true }).getAttribute("aria-invalid")).toBe(
          "true",
        );
        expect(
          await form.getByLabel("Repository", { exact: true }).getAttribute("aria-invalid"),
        ).toBeNull();

        for (const url of ["skills-repo", "../repo"]) {
          await form.getByLabel("Repository", { exact: true }).fill(url);
          await form.getByRole("button", { name: "Install" }).click();
          await form.getByText(/^Enter the repository's URL, such as/).waitFor();
          expect((await focused(app)).invalid).toBe("true");
        }
        expect(await app.sheet().isVisible()).toBe(false);
      });
    });
  });

  it("says a missing folder does not exist", async () => {
    await withHome("twoAgents", async (home) => {
      await withApp({ home }, async (app) => {
        const form = await openInstall(app);
        await form.getByLabel("Folder", { exact: true }).fill("~/src/nowhere");
        await form.getByRole("button", { name: "Install" }).click();
        await form.getByText("No folder at this path. Choose another.").waitFor();
      });
    });
  });

  it("says an update's branch is gone, in Update's words, and writes nothing", async () => {
    await withHome("gitSource", async (home) => {
      await commit(home, "release", { "skills/lint/SKILL.md": skillMd("lint", "Lint the diff") });
      const url = join(home, "review.git");
      const installed = await gandalfCli(home, [
        "skills",
        "install",
        url,
        "--ref",
        "release",
        "--subpath",
        "skills/lint",
      ]);
      expect(installed.code).toBe(0);
      await git(home, url, "branch", "-D", "release");
      const before = await listTree(join(home, ".gandalf/skills"));
      await withApp({ home }, async (app) => {
        await app.countLine();
        const panel = await select(app, "lint");
        await chooseAction(panel, "Check for Updates");
        const sheet = app.sheet();
        await sheet.waitFor();
        const text = await sheet.innerText();
        expect(text).toContain("The branch or tag this skill follows is gone from its repository.");
        expect(text).toContain(
          "Nothing was written. Install the skill again from a branch or tag that exists, or remove it.",
        );
        expect(text).not.toContain("SKILL.md");
      });
      expect(await listTree(join(home, ".gandalf/skills"))).toEqual(before);
    });
  });

  it("wraps a long repository path in the sheet and writes it with ~, under a symlinked HOME", async () => {
    await withHome("gitSource", async (real) => {
      // macOS keeps temp folders under /var, a symlink to /private/var; HOME may use either.
      const home = real.replace(/^\/private\//, "/");
      expect(await realpath(home)).toBe(real);
      const long = join(
        real,
        "afolderwithaverylongnamethatnevercontainsabreak".repeat(3),
        "skills.git",
      );
      await mkdir(join(long, ".."), { recursive: true });
      await commit(real, "main", { "skills/lint/SKILL.md": skillMd("lint", "Lint the diff") });
      await git(real, real, "clone", "--quiet", "--bare", join(real, "review.git"), long);
      await withApp({ home }, async (app) => {
        const form = await openInstall(app);
        // A path as a realpath gives it still gets ~.
        await chooseGit(form, long, "", "skills/lint");
        await form.getByRole("button", { name: "Install" }).click();
        const sheet = app.sheet();
        await sheet.waitFor();
        const title = await sheet.getByRole("heading", { level: 2 }).textContent();
        expect(title).toBe("Install lint?");
        // The skill's source and the step that names the repository wrap inside the sheet.
        await sheet.getByRole("button", { name: /^Show the \d+ changes on disk$/ }).click();
        const source = sheet.getByText(`${long.replace(real, "~")} · skills/lint`, {
          exact: false,
        });
        const step = sheet.getByText(/^Add lint to the library from ~\//);
        expect(await step.textContent()).toContain(long.replace(real, "~"));
        for (const text of [source, step]) {
          const fits = await text.evaluate(
            (element) =>
              element.scrollWidth <= element.clientWidth + 1 &&
              element.getBoundingClientRect().right <=
                (element.closest("dialog")?.getBoundingClientRect().right ?? 0),
          );
          expect(fits).toBe(true);
        }
        expect(await sheet.innerText()).not.toContain(real);
        await sheet.getByRole("button", { name: "Cancel" }).click();

        await app.stubFolderPanel(join(real, "src"));
        await form.getByRole("button", { name: "Local Folder" }).click();
        await form.getByRole("button", { name: "Choose…" }).click();
        await expect
          .poll(() => form.getByLabel("Folder", { exact: true }).inputValue())
          .toBe("~/src");
      });
    });
  });
});

describe("Key focus follows the inspector", () => {
  it("lands in Skill detail after a keyboard install, then on the row it closes back to", async () => {
    await withHome("twoAgents", async (home) => {
      await writeSkill(join(home, "src/notes"), skillMd("notes", "Project notes"));
      await withApp({ home }, async (app) => {
        const form = await openInstall(app);
        await form.getByLabel("Folder", { exact: true }).fill("~/src/notes");
        await app.page.keyboard.press("Enter");
        await app.sheet().waitFor();
        expect((await focused(app)).text).toBe("Install");
        await app.page.keyboard.press("Enter");
        await app.sheet().waitFor({ state: "hidden" });
        await inspector(app, "notes").waitFor();
        await expect.poll(async () => (await focused(app)).id).toBe("skill-detail-title");

        // Escape closes it, and focus goes back to the row, without opening it again.
        await app.page.keyboard.press("Escape");
        await inspector(app, "notes").waitFor({ state: "detached" });
        expect((await focused(app)).skill).toBe("notes");
        await delay(300);
        expect(await inspector(app, "notes").count()).toBe(0);

        const panel = await select(app, "notes");
        await panel.getByRole("button", { name: "Close" }).click();
        await panel.waitFor({ state: "detached" });
        expect((await focused(app)).skill).toBe("notes");
      });
    });
  });

  it("moves focus to the next row after Remove, and clears the selection", async () => {
    await withHome("twoAgents", async (home) => {
      await writeSkill(join(home, "src/notes"), skillMd("notes", "Project notes"));
      expect((await gandalfCli(home, ["skills", "install", join(home, "src/notes")])).code).toBe(0);
      await withApp({ home }, async (app) => {
        await app.countLine();
        const panel = await select(app, "demo");
        await panel.getByRole("button", { name: "More actions for demo" }).focus();
        await app.page.keyboard.press("Enter");
        await app.page.keyboard.press("End");
        await app.page.keyboard.press("Enter");
        await app.sheet().waitFor();
        await app.page.keyboard.press("Enter");
        await app.sheet().waitFor({ state: "hidden" });
        await panel.waitFor({ state: "detached" });
        await expect.poll(async () => (await focused(app)).skill).toBe("notes");
        await expect.poll(() => app.countLine()).toBe("1 skill");
        expect(await app.page.locator("[role=option][aria-selected=true]").count()).toBe(0);
        expect(await inspector(app, "notes").count()).toBe(0);
      });
    });
  });
});

describe("Skill detail puts SKILL.md on content", () => {
  it("keeps SKILL.md on content and the facts on glass, with or without transparency", async () => {
    await withHome("gitSource", async (home) => {
      await withApp({ home }, async (app) => {
        await app.countLine();
        const panel = await select(app, "review");
        await panel.locator("pre").waitFor();
        // The file's name keeps its case, unlike a column header.
        const heading = panel.getByRole("heading", { level: 3, name: "SKILL.md" });
        expect(await heading.innerText()).toBe("SKILL.md");
        expect(await heading.evaluate((h3) => getComputedStyle(h3).textTransform)).toBe("none");
        for (const reduce of [false, true]) {
          await app.setReduceTransparency(reduce);
          // Each text block's nearest painted background, and the aside's own.
          const surfaces = await panel.evaluate((aside) => {
            const paint = (element: Element | null): Element | null => {
              for (let at = element; at !== null; at = at.parentElement) {
                if (getComputedStyle(at).backgroundColor !== "rgba(0, 0, 0, 0)") return at;
              }
              return null;
            };
            const content = getComputedStyle(
              document.querySelector("main") as Element,
            ).backgroundColor;
            return [...aside.querySelectorAll('[aria-label="SKILL.md"] :is(p, pre, h3), dl')].map(
              (block) => {
                const surface = paint(block);
                return {
                  block: block.tagName,
                  onGlass: surface === aside,
                  opaqueContent:
                    surface !== null && getComputedStyle(surface).backgroundColor === content,
                };
              },
            );
          });
          expect(surfaces.length).toBeGreaterThanOrEqual(3);
          for (const surface of surfaces) {
            // The facts sit on the glass with the name, as the design draws them.
            expect(surface, `${surface.block} reduce=${reduce}`).toMatchObject(
              surface.block === "DL" ? { onGlass: true } : { onGlass: false, opaqueContent: true },
            );
          }
          // The name and the buttons stay on the glass panel.
          expect(
            await panel
              .getByRole("heading", { level: 2 })
              .evaluate(
                (heading) =>
                  getComputedStyle(heading.parentElement?.parentElement as Element).backgroundColor,
              ),
          ).toBe("rgba(0, 0, 0, 0)");
        }
      });
    });
  });
});

describe("Skill detail in a narrow window", () => {
  /** Where the matrix, the inspector and the title sit with `name` selected. */
  const layout = (app: App) =>
    app.page.evaluate(() => {
      const box = (selector: string) => {
        const element = document.querySelector(selector);
        if (element === null) throw new Error(`no ${selector}`);
        return element.getBoundingClientRect();
      };
      const title = document.querySelector("header h1");
      const sync = box("header button");
      const atSync = document.elementFromPoint(sync.x + sync.width / 2, sync.y + sync.height / 2);
      return {
        main: box("main").width,
        mainRight: box("main").right,
        aside: { left: box("aside").left, right: box("aside").right },
        sidebarRight: box("nav").right,
        titleWhole: title !== null && title.scrollWidth <= title.clientWidth,
        // The point lands in the toolbar, not the inspector (a disabled Sync passes clicks through).
        syncReachable: atSync?.closest("header") !== null,
        width: window.innerWidth,
      };
    });

  it("keeps the matrix wide and the title whole at 760x640 and the minimum size", async () => {
    await withHome("twoAgents", async (home) => {
      await withApp({ home }, async (app) => {
        await app.countLine();
        await select(app, "demo");
        const minimum = await app.electron.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0]?.getMinimumSize(),
        );
        const [minWidth = 0, minHeight = 0] = minimum ?? [];
        for (const [width, height] of [
          [760, 640],
          [minWidth, minHeight],
        ] as const) {
          await app.resize(width, height);
          const at = await layout(app);
          // The inspector floats over the content: the matrix keeps the window's width.
          expect(at.mainRight, `${width}x${height}`).toBeGreaterThanOrEqual(width - 1);
          expect(at.main, `${width}x${height}`).toBeGreaterThanOrEqual(400);
          expect(at.aside.right).toBeLessThanOrEqual(at.width);
          expect(at.aside.left).toBeGreaterThan(at.sidebarRight);
          expect(at.titleWhole).toBe(true);
          expect(at.syncReachable).toBe(true);
        }
        // Wide enough, it sits beside the matrix again.
        await app.resize(1100, 700);
        const wide = await layout(app);
        expect(wide.main).toBeLessThanOrEqual(wide.aside.left - wide.sidebarRight + 1);
      });
    });
  });
});

describe("Skill detail at the minimum window size", () => {
  it("scrolls its body as one region, so SKILL.md stays reachable under a long description", async () => {
    await withHome("twoAgents", async (home) => {
      const description = `${"A description long enough to wrap onto many lines. ".repeat(3)}End.`;
      expect(description.length).toBeGreaterThanOrEqual(150);
      const body = Array.from({ length: 200 }, (_, n) => `Line ${n + 1}.`).join("\n");
      await writeSkill(join(home, "src/long"), skillMd("long", description, body));
      expect((await gandalfCli(home, ["skills", "install", join(home, "src/long")])).code).toBe(0);
      await withApp({ home }, async (app) => {
        await app.countLine();
        await app.resize(640, 400);
        const panel = await select(app, "long");
        const region = panel.getByRole("region", { name: "About long" });
        await region.getByText("Line 200.").waitFor({ state: "attached" });
        const sizes = await region.evaluate((element) => ({
          scrollHeight: element.scrollHeight,
          clientHeight: element.clientHeight,
          scrollWidth: element.scrollWidth,
          clientWidth: element.clientWidth,
        }));
        expect(sizes.scrollHeight).toBeGreaterThan(sizes.clientHeight);
        expect(sizes.scrollWidth).toBeLessThanOrEqual(sizes.clientWidth);
        // Scrolling the body by the wheel brings the SKILL.md heading to its top edge.
        const heading = panel.getByRole("heading", { level: 3, name: "SKILL.md" });
        const offset = () =>
          heading.evaluate((h3) => {
            const scroller = h3.closest("[role=region]")?.getBoundingClientRect();
            return h3.getBoundingClientRect().top - (scroller?.top ?? Infinity);
          });
        const below = await offset();
        expect(below).toBeGreaterThan(0);
        await region.hover();
        await app.page.mouse.wheel(0, below);
        await expect.poll(offset).toBeLessThan(2);
        expect(await offset()).toBeGreaterThan(-2);
        expect(await panel.locator("pre").evaluate((pre) => pre.clientHeight)).toBeGreaterThan(100);
        const page = await app.page.evaluate(() => ({
          documentScroll: document.scrollingElement?.scrollTop ?? 0,
          panelBottom: document.querySelector("aside")?.getBoundingClientRect().bottom ?? Infinity,
          innerHeight: window.innerHeight,
        }));
        expect(page.documentScroll).toBe(0);
        expect(page.panelBottom).toBeLessThanOrEqual(page.innerHeight);
      });
    });
  });

  it("wraps a long Source and Library path instead of clipping it, at every width", async () => {
    await withHome("twoAgents", async (home) => {
      const folder = join(home, "src", "a-folder-with-a-long-name-and-a-repository-name".repeat(2));
      await writeSkill(folder, skillMd("wrapped", "Wrapped"));
      expect((await gandalfCli(home, ["skills", "install", folder])).code).toBe(0);
      await withApp({ home }, async (app) => {
        await app.countLine();
        const panel = await select(app, "wrapped");
        for (const [width, height] of [
          [960, 640],
          [760, 640],
          [640, 400],
        ] as const) {
          await app.resize(width, height);
          for (const term of ["Source", "Library"]) {
            const path = panel
              .locator("dt", { hasText: new RegExp(`^${term}$`) })
              .locator("xpath=following-sibling::dd[1]/span");
            const fits = await path.evaluate((span) => ({
              whole: span.scrollWidth <= span.clientWidth,
              inside:
                span.getBoundingClientRect().right <=
                (span.closest("aside")?.getBoundingClientRect().right ?? 0),
            }));
            expect(fits, `${term} at ${width}x${height}`).toEqual({ whole: true, inside: true });
          }
          expect(await fact(panel, "Source")).toBe(folder.replace(home, "~"));
        }
      });
    });
  });

  it("keeps the matrix's column headers under the floating inspector at 760 px", async () => {
    await withHome("twoAgents", async (home) => {
      await withApp({ home }, async (app) => {
        await app.countLine();
        await select(app, "demo");
        await app.resize(760, 640);
        // Every header cell that reaches under the inspector is covered by it, from its top edge.
        const peeking = await app.page.evaluate(() => {
          const aside = document.querySelector("aside")?.getBoundingClientRect();
          if (aside === undefined) throw new Error("no inspector");
          return [...document.querySelectorAll("thead th")]
            .map((th) => th.getBoundingClientRect())
            .filter((box) => box.right > aside.left && box.width > 0)
            .filter((box) => box.top < aside.top && box.bottom > box.top)
            .filter((box) => {
              const header = document.querySelector("header")?.getBoundingClientRect();
              return header === undefined || box.bottom > header.bottom;
            }).length;
        });
        expect(peeking).toBe(0);
      });
    });
  });
});

describe("Escape takes the nearest thing first", () => {
  it("closes the inspector during an Update, and cancels the Update only on the next Escape", async () => {
    await withHome("gitSource", (home) =>
      withSlowGit(async (slow) => {
        await withApp({ home, env: slow.env }, async (app) => {
          await app.countLine();
          let panel = await select(app, "review");
          await chooseAction(panel, "Check for Updates");
          await slow.started();
          await panel.getByRole("button", { name: "Cancel" }).focus();
          await app.page.keyboard.press("Escape");
          await panel.waitFor({ state: "detached" });
          // The Update ran on: let through, it opens its sheet, which finds nothing newer.
          await slow.release();
          await app.sheet().waitFor();
          await app.sheet().getByRole("button", { name: "Done" }).click();
          await app.sheet().waitFor({ state: "hidden" });

          await slow.hold();
          panel = await select(app, "review");
          await chooseAction(panel, "Check for Updates");
          await slow.started();
          await panel.getByRole("button", { name: "Cancel" }).focus();
          await app.page.keyboard.press("Escape");
          await panel.waitFor({ state: "detached" });
          // Focus is back on the row, with nothing selected, so this Escape cancels the Update.
          expect((await focused(app)).skill).toBe("review");
          await app.page.keyboard.press("Escape");
          await slow.release();
          await delay(1500);
          expect(await app.sheet().isVisible()).toBe(false);
          expect(await slow.passed()).toBe(false);
          panel = await select(app, "review");
          expect(await panel.locator("[aria-busy=true]").count()).toBe(0);

          // The inspector's Cancel hands focus to the menu Check for Updates was picked from.
          await slow.hold();
          await chooseAction(panel, "Check for Updates");
          await slow.started();
          await panel.getByRole("button", { name: "Cancel" }).click();
          await panel.getByRole("button", { name: "Cancel" }).waitFor({ state: "detached" });
          expect(await focused(app)).toMatchObject({
            tag: "button",
            label: "More actions for review",
          });
          await slow.release();
        });
      }),
    );
  });
});

describe("Install picks skills from a git repository", () => {
  it("lists the repository's skills, installs the chosen ones in one plan, and keeps the rest", async () => {
    await withHome("gitSource", async (home) => {
      await commit(home, "main", {
        "skills/lint/SKILL.md": skillMd("lint", "Lint the diff"),
        "skills/docs/SKILL.md": skillMd("docs", "Write the docs"),
        "skills/notes/SKILL.md": skillMd("notes", "Take notes"),
      });
      await withApp({ home }, async (app) => {
        const form = await openInstall(app);
        await form.getByRole("button", { name: "Git Repository" }).click();
        await form.getByLabel("Repository", { exact: true }).fill(join(home, "review.git"));
        await form.getByRole("button", { name: "Find Skills" }).click();
        const picker = form.getByRole("list", { name: "Skills in this repository" });
        await picker.waitFor();
        expect(await form.getByLabel("Folder", { exact: true }).count()).toBe(0);
        expect(await picker.innerText()).toContain("Already in the library");
        expect(await form.getByLabel("review", { exact: true }).isDisabled()).toBe(true);
        expect(await form.getByLabel("Choose All").isChecked()).toBe(true);
        await form.getByLabel("notes", { exact: true }).uncheck();
        await form.getByRole("button", { name: "Install 2 Skills" }).click();
        await app.sheet().waitFor();
        expect(await app.sheet().getByRole("heading", { level: 2 }).textContent()).toBe(
          "Install 2 skills?",
        );
        expect(
          await app.sheet().getByRole("list", { name: "Skills to install" }).innerText(),
        ).toMatch(/docs[\s\S]*lint/);
        await app.applySheet();
        await inspector(app, "docs").or(inspector(app, "lint")).first().waitFor();
        for (const name of ["docs", "lint"]) {
          expect(await app.cellStatus(name, "Claude Code")).toBe("● Linked");
        }
        expect(await exists(join(home, ".gandalf/skills/notes"))).toBe(false);

        const again = await openInstall(app);
        await again.getByRole("button", { name: "Git Repository" }).click();
        await again.getByRole("button", { name: "Look Again" }).click();
        await expect.poll(() => again.getByLabel("Choose All").isChecked()).toBe(true);
        await again.getByRole("button", { name: "Install 1 Skill" }).waitFor();
      });
    });
  });
});

/** skills.sh as a local server: the trending board and a search, each from `skills`. */
async function withSkillsSh<T>(
  skills: readonly object[],
  body: (site: string) => Promise<T>,
): Promise<T> {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname === "/trending") {
      const json = JSON.stringify({ skills }).replace(/"/g, '\\"');
      response.end(`<html><script>self.__next_f.push([1,"${json}"])</script></html>`);
    } else if (url.pathname === "/api/search") {
      const query = url.searchParams.get("q") ?? "";
      const found = skills.filter((skill) => JSON.stringify(skill).includes(query));
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ skills: found }));
    } else {
      response.statusCode = 404;
      response.end();
    }
  });
  await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
  try {
    return await body(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    await new Promise((closed) => server.close(closed));
  }
}

describe("Install finds a skill on skills.sh and installs it from GitHub", () => {
  it("lists the board, says what each row can do, installs one and says a failure on its row", async () => {
    await withHome("gitSource", async (home) => {
      // GitHub is a folder of bare repositories, so acme/skills is <github>/acme/skills.git.
      const github = join(home, "github");
      const work = join(home, "acme-work");
      await writeSkill(join(work, "skills/lint"), skillMd("lint", "Lint the diff"));
      await git(home, work, "init", "--quiet", "--initial-branch=main");
      await git(home, work, "add", ".");
      await git(home, work, "commit", "--quiet", "-m", "v1");
      await git(home, home, "clone", "--quiet", "--bare", work, join(github, "acme/skills.git"));
      const board = [
        { source: "acme/skills", skillId: "lint", name: "lint", installs: 1234 },
        { source: "acme/review", skillId: "review", name: "review", installs: 99 },
        { source: "uizze.sh", skillId: "ui-taste", name: "ui-taste", installs: 7 },
        { source: "acme/skills", skillId: "gone", name: "gone", installs: 3 },
      ];
      await withSkillsSh(board, async (site) => {
        const env = { GANDALF_SKILLS_SH: site, GANDALF_GITHUB: `file://${github}` };
        await withApp({ home, env }, async (app) => {
          await app.countLine();
          await app.page
            .getByRole("navigation", { name: "Sections" })
            .getByRole("button", { name: "Install" })
            .click();
          const list = app.page.getByRole("list", { name: "Trending on skills.sh" });
          const row = (name: string) => list.getByRole("listitem", { name, exact: true });
          await row("lint").waitFor();
          expect(await row("lint").innerText()).toContain("acme/skills · 1.2K installs today");
          expect(await row("review").innerText()).toContain("Name Taken");
          expect(await row("review").innerText()).toContain("Your library has a review from");
          expect(await row("ui-taste").innerText()).toContain("Not on GitHub");

          await row("gone").getByRole("button", { name: "Install gone" }).click();
          await expect
            .poll(() => row("gone").getByRole("alert").textContent())
            .toBe("The repository no longer has this skill.");
          expect(await app.sheet().count()).toBe(0);

          await row("lint").getByRole("button", { name: "Install lint" }).click();
          await app.sheet().waitFor();
          const tile = app.sheet().getByRole("list", { name: "Skills to install" });
          expect(await tile.innerText()).toContain("Lint the diff");
          expect(await tile.innerText()).toContain("1.2K installs on skills.sh");
          await app.applySheet();
          const panel = inspector(app, "lint");
          await panel.waitFor();
          expect(await fact(panel, "Commit")).toBe(
            (await git(home, work, "rev-parse", "HEAD")).slice(0, 12),
          );

          await app.page
            .getByRole("navigation", { name: "Sections" })
            .getByRole("button", { name: "Install" })
            .click();
          await expect.poll(() => row("lint").innerText()).toContain("In Library");

          await app.page.getByLabel("Search skills.sh").fill("nothing-like-it");
          await app.page.getByText("No skills match “nothing-like-it”").waitFor();
        });
      });
    });
  });
});
