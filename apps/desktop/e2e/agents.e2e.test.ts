import { chmod, cp, lstat, mkdir, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import type { Locator } from "playwright";
import { describe, expect, it } from "vitest";
import { listTree, withHome } from "./homes";
import { gandalfCli, withApp, type App } from "./lever";

interface AgentJson {
  readonly id: string;
  readonly displayName: string;
  readonly installed: boolean;
  readonly skillsDir: string;
  readonly mode: string;
  readonly overridden: boolean;
  readonly readError: string | null;
}

async function agentsJson(home: string): Promise<readonly AgentJson[]> {
  const cli = await gandalfCli(home, ["agents"]);
  return (cli.json as { agents: readonly AgentJson[] }).agents;
}

async function openAgents(app: App): Promise<Locator> {
  await app.countLine();
  await app.page
    .getByRole("navigation", { name: "Sections" })
    .getByRole("button", { name: "Agents" })
    .click();
  const list = app.page.getByRole("list", { name: "Agents" });
  await list.waitFor();
  return list;
}

const row = (list: Locator, name: string) => list.getByRole("listitem", { name, exact: true });

/** The row's text, with the home folder shown as ~ the way the screen shows it. */
const rowText = async (list: Locator, name: string) => (await row(list, name).innerText()).trim();

function exists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false,
  );
}

async function changeFolder(app: App, list: Locator, agent: string, folder: string) {
  await app.stubFolderPanel(folder);
  await row(list, agent)
    .getByRole("button", { name: `Change Folder for ${agent}` })
    .click();
}

describe("The Agents screen shows every agent and plans its overrides through the sheet", () => {
  it("points Cursor at another folder as the CLI's configure does, and marks it Custom", async () => {
    await withHome("twoAgents", async (home) => {
      const cliHome = `${home}-cli`;
      await cp(home, cliHome, { recursive: true, verbatimSymlinks: true });
      await withApp({ home }, async (app) => {
        // Cursor gets demo too, so a link has to move.
        await app.toggleCell("demo", "Cursor");
        await app.applySheet();
        const list = await openAgents(app);
        await mkdir(join(home, "work/cursor-skills"), { recursive: true });
        await changeFolder(app, list, "Cursor", join(home, "work/cursor-skills"));
        const sheet = app.sheet();
        await sheet.waitFor();
        await expect.poll(() => sheet.innerText()).toContain("Remove demo from Cursor");
        expect(await sheet.innerText()).toContain("Link demo into");
        await app.applySheet();
        await expect.poll(() => rowText(list, "Cursor")).toContain("~/work/cursor-skills");
        expect(await rowText(list, "Cursor")).toContain("Custom");
      });
      await gandalfCli(cliHome, ["skills", "enable", "demo", "--agent", "cursor"]);
      await mkdir(join(cliHome, "work/cursor-skills"), { recursive: true });
      const cli = await gandalfCli(cliHome, [
        "agents",
        "configure",
        "cursor",
        "--dir",
        join(cliHome, "work/cursor-skills"),
      ]);
      expect(cli.code).toBe(0);
      const strip = (agents: readonly AgentJson[], at: string) =>
        JSON.stringify(agents).replaceAll(at, "HOME");
      expect(strip(await agentsJson(home), home)).toBe(strip(await agentsJson(cliHome), cliHome));
      const tree = async (at: string) =>
        (await listTree(join(at, "work"))).map((line) => line.replaceAll(at, "HOME"));
      expect(await tree(home)).toEqual(await tree(cliHome));
    });
  });

  it("resets an override, and the links follow Cursor back to its own folder", async () => {
    await withHome("twoAgents", async (home) => {
      await gandalfCli(home, ["skills", "enable", "demo", "--agent", "cursor"]);
      await mkdir(join(home, "elsewhere"), { recursive: true });
      await gandalfCli(home, ["agents", "configure", "cursor", "--dir", join(home, "elsewhere")]);
      await withApp({ home }, async (app) => {
        const list = await openAgents(app);
        await row(list, "Cursor").getByRole("button", { name: "Reset Cursor" }).click();
        await app.applySheet();
        await expect.poll(() => rowText(list, "Cursor")).toContain("~/.cursor/skills");
        expect(await rowText(list, "Cursor")).not.toContain("Custom");
        expect(
          await row(list, "Cursor").getByRole("button", { name: "Reset Cursor" }).count(),
        ).toBe(0);
      });
      expect(await readlink(join(home, ".cursor/skills/demo"))).toBe(
        join(home, ".gandalf/skills/demo"),
      );
      expect(await exists(join(home, "elsewhere/demo"))).toBe(false);
    });
  });

  it("switches Claude Code to Copy, and its entries become gandalf's copies", async () => {
    await withHome("twoAgents", async (home) => {
      await withApp({ home }, async (app) => {
        const list = await openAgents(app);
        await row(list, "Claude Code")
          .getByRole("group", { name: /Claude Code/ })
          .getByRole("button", { name: "Copy" })
          .click();
        await app.applySheet();
        await expect
          .poll(() =>
            row(list, "Claude Code")
              .getByRole("button", { name: "Copy" })
              .getAttribute("aria-pressed"),
          )
          .toBe("true");
        await app.page
          .getByRole("navigation", { name: "Sections" })
          .getByRole("button", { name: "Library" })
          .click();
        expect(await app.cellStatus("demo", "Claude Code")).toContain("Copied");
      });
      const entry = join(home, ".claude/skills/demo");
      expect((await lstat(entry)).isDirectory()).toBe(true);
      expect(await exists(join(entry, ".gandalf-copy.json"))).toBe(true);
    });
  });

  it("refuses a folder inside ~/.gandalf and writes nothing", async () => {
    await withHome("twoAgents", async (home) => {
      const before = await listTree(home);
      await withApp({ home }, async (app) => {
        const list = await openAgents(app);
        await changeFolder(app, list, "Cursor", join(home, ".gandalf/skills"));
        const alert = row(list, "Cursor").getByRole("alert");
        await alert.waitFor();
        expect(await alert.innerText()).toBe(
          "~/.gandalf/skills is inside ~/.gandalf, where gandalf keeps the library. Choose a folder outside it.",
        );
        expect(await app.sheet().isVisible()).toBe(false);
      });
      expect(await listTree(home)).toEqual(before);
    });
  });

  it("shows a skills folder it cannot read on its row, and every other row still", async () => {
    await withHome("twoAgents", async (home) => {
      const locked = join(home, ".cursor/skills");
      await mkdir(locked, { recursive: true });
      await chmod(locked, 0o000);
      try {
        await withApp({ home }, async (app) => {
          const list = await openAgents(app);
          await expect
            .poll(() => rowText(list, "Cursor"))
            .toContain("gandalf is not allowed to read this folder");
          expect(await list.getByRole("listitem").count()).toBe(13);
          expect(await rowText(list, "Claude Code")).not.toContain("not allowed to read");
        });
      } finally {
        await chmod(locked, 0o755);
      }
    });
  });

  it("lists all 13 agents in registry order, marking those not installed", async () => {
    await withHome("realShaped", async (home) => {
      const order = (await agentsJson(home)).map((agent) => agent.displayName);
      await withApp({ home }, async (app) => {
        const list = await openAgents(app);
        const items = list.getByRole("listitem");
        expect(await items.count()).toBe(13);
        const shown = await items.evaluateAll((nodes) =>
          nodes.map((node) => node.getAttribute("aria-label")),
        );
        expect(shown).toEqual(order);
        for (const agent of await agentsJson(home)) {
          const text = await rowText(list, agent.displayName);
          expect(text).toContain(agent.installed ? "Installed" : "Not installed");
        }
      });
    });
  });

  it("changes nothing on disk when the folder change is cancelled in the sheet", async () => {
    await withHome("twoAgents", async (home) => {
      await mkdir(join(home, "elsewhere"), { recursive: true });
      const before = await listTree(home);
      const state = await readFile(join(home, ".gandalf/state.json"), "utf8");
      await withApp({ home }, async (app) => {
        const list = await openAgents(app);
        await changeFolder(app, list, "Claude Code", join(home, "elsewhere"));
        await app.sheet().waitFor();
        await app.sheet().getByRole("button", { name: "Cancel" }).click();
        await app.sheet().waitFor({ state: "hidden" });
        expect(await rowText(list, "Claude Code")).toContain("~/.claude/skills");
      });
      expect(await listTree(home)).toEqual(before);
      expect(await readFile(join(home, ".gandalf/state.json"), "utf8")).toBe(state);
    });
  });

  it("points two agents at one folder as one root read by both, with one link per skill", async () => {
    await withHome("twoAgents", async (home) => {
      await gandalfCli(home, ["skills", "enable", "demo", "--agent", "cursor"]);
      const shared = join(home, "shared-skills");
      await mkdir(shared, { recursive: true });
      await withApp({ home }, async (app) => {
        const list = await openAgents(app);
        await changeFolder(app, list, "Cursor", shared);
        await app.applySheet();
        await expect.poll(() => rowText(list, "Cursor")).toContain("~/shared-skills");
        await changeFolder(app, list, "Claude Code", shared);
        const sheet = app.sheet();
        await sheet.waitFor();
        const links = (await sheet.innerText()).match(/Link demo into/g) ?? [];
        expect(links.length).toBeLessThanOrEqual(1);
        await app.applySheet();
        for (const agent of ["Cursor", "Claude Code"]) {
          await expect.poll(() => rowText(list, agent)).toContain("Read by Cursor and Claude Code");
        }
      });
      expect(await readlink(join(shared, "demo"))).toBe(join(home, ".gandalf/skills/demo"));
      const roots = (await gandalfCli(home, ["agents"])).json as {
        roots: readonly { path: string; readers: readonly string[] }[];
      };
      expect(roots.roots.filter((root) => root.path === shared)).toEqual([
        expect.objectContaining({ readers: ["cursor", "claude_code"] }),
      ]);
    });
  });

  it("reaches every control from the keyboard, each showing the focus ring", async () => {
    await withHome("twoAgents", async (home) => {
      await gandalfCli(home, ["agents", "configure", "cursor", "--mode", "copy"]);
      await withApp({ home }, async (app) => {
        const list = await openAgents(app);
        const cursor = row(list, "Cursor");
        // From the keyboard, as :focus-visible shows the ring only after a key, never a click.
        const first = cursor.getByRole("button", { name: "Change Folder for Cursor" });
        for (let n = 0; n < 80; n += 1) {
          if (await first.evaluate((element) => element === document.activeElement)) break;
          await app.page.keyboard.press("Tab");
        }
        const reached: string[] = [];
        for (let n = 0; n < 5; n += 1) {
          const focused = await app.page.evaluate(() => {
            const element = document.activeElement as HTMLElement | null;
            return {
              name: element?.getAttribute("aria-label") ?? element?.textContent ?? "",
              outline: element === null ? "" : getComputedStyle(element).outlineStyle,
            };
          });
          reached.push(focused.name);
          expect(focused.outline).toBe("solid");
          await app.page.keyboard.press("Tab");
        }
        expect(reached).toEqual([
          "Change Folder for Cursor",
          "Reset Cursor",
          "Auto",
          "Link",
          "Copy",
        ]);
      });
    });
  });

  it("shows a folder the CLI changes while the screen is open, without input", async () => {
    await withHome("twoAgents", async (home) => {
      await withApp({ home }, async (app) => {
        const list = await openAgents(app);
        await mkdir(join(home, "from-cli"), { recursive: true });
        await gandalfCli(home, ["agents", "configure", "cursor", "--dir", join(home, "from-cli")]);
        await expect.poll(() => rowText(list, "Cursor"), { timeout: 5000 }).toContain("~/from-cli");
        expect(await rowText(list, "Cursor")).toContain("Custom");
      });
    });
  });
});
