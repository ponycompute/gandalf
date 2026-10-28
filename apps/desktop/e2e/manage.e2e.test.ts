import { cp, lstat, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Locator } from "playwright";
import { describe, expect, it } from "vitest";
import { listTree, withHome } from "./homes";
import { gandalfCli, holdLock, withApp, type App } from "./lever";

interface Variant {
  readonly hash: string;
  readonly at: readonly { readonly root: string; readonly path: string }[];
}

interface SkillJson {
  readonly name: string;
  readonly hash: string | null;
}

async function variantsOf(home: string, name: string): Promise<readonly Variant[]> {
  const cli = await gandalfCli(home, ["skills", "adopt", name, "--dry-run"]);
  const { notDone } = (cli.json as { plan: { notDone: { kind: string; variants?: Variant[] }[] } })
    .plan;
  return notDone.find((item) => item.kind === "needsChoice")?.variants ?? [];
}

async function libraryHash(home: string, name: string): Promise<string | null> {
  const skills = (await gandalfCli(home, ["skills", "list"])).json as readonly SkillJson[];
  return skills.find((skill) => skill.name === name)?.hash ?? null;
}

function exists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false,
  );
}

const AGENT_OF_ROOT: Readonly<Record<string, string>> = {
  ".claude/skills": "Claude Code",
  ".cursor/skills": "Cursor",
};

function agentOf(home: string, variant: Variant): string {
  const root = variant.at[0]?.root.slice(home.length + 1) ?? "";
  return AGENT_OF_ROOT[root] ?? root;
}

const row = (app: App, name: string) => app.page.locator(`[role="option"][data-skill="${name}"]`);

const consent = (app: App) =>
  app.page.getByRole("dialog", { name: "Let gandalf manage your skills?" });

/** Selects a Two versions row and waits for its detail, where the versions and their diff show. */
async function openVersions(app: App, name: string): Promise<Locator> {
  await app.countLine();
  await row(app, name).click();
  const panel = app.page.getByRole("complementary", { name, exact: true });
  await panel.getByRole("region", { name: "Versions" }).waitFor();
  return panel;
}

/** The checked state of the Library menu's Manage New Skills Automatically. */
function menuChecked(app: App): Promise<boolean | undefined> {
  return app.electron.evaluate(
    ({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById("autoManage")?.checked,
  );
}

/** Picks Manage New Skills Automatically as a click on it in the menu bar would. */
async function clickMenu(app: App): Promise<void> {
  await app.electron.evaluate(({ Menu }) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById("autoManage");
    if (item === null || item === undefined) throw new Error("no Manage New Skills item");
    item.click();
  });
}

function luminance(rgb: readonly number[]): number {
  const [r = 0, g = 0, b = 0] = rgb.map((channel) => {
    const c = channel / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: readonly number[], b: readonly number[]): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
}

/** Each added and removed diff line's label color against its own background. */
async function diffContrasts(sheet: Locator): Promise<{ add: number; remove: number }> {
  const pairs = await sheet
    .locator("[data-diff-lines] .bg-diff-add, [data-diff-lines] .bg-diff-remove")
    .evaluateAll((lines) =>
      lines.slice(0, 40).map((line) => {
        const rgb = (value: string) => (value.match(/\d+(\.\d+)?/g) ?? []).slice(0, 3).map(Number);
        const text = line.lastElementChild ?? line;
        return {
          add: line.classList.contains("bg-diff-add"),
          fill: rgb(getComputedStyle(line).backgroundColor),
          ink: rgb(getComputedStyle(text).color),
        };
      }),
    );
  const worst = (add: boolean) =>
    Math.min(
      ...pairs.filter((pair) => pair.add === add).map((pair) => contrast(pair.fill, pair.ink)),
    );
  return { add: worst(true), remove: worst(false) };
}

/** Where the link at `path` points, or null for anything else. */
function linkTarget(path: string): Promise<string | null> {
  return readlink(path).catch(() => null);
}

describe("gandalf manages the skills it finds in agents' own folders", () => {
  it("asks once, and Manage takes every agreeing skill the same way the CLI adopts it", async () => {
    await withHome("adoptChoice", async (viaCli) => {
      await withHome("adoptChoice", async (viaApp) => {
        expect((await gandalfCli(viaCli, ["skills", "adopt", "notes"])).code).toBe(0);
        await withApp({ home: viaApp, autoManage: "ask" }, async (app) => {
          const sheet = consent(app);
          await sheet.waitFor();
          expect(await sheet.innerText()).toContain("Leaves 1 skill whose copies differ");
          expect(await sheet.innerText()).toMatch(/notes[\s\S]*review/);
          expect(await menuChecked(app)).toBe(false);
          await sheet.getByRole("button", { name: "Manage 1 Skill" }).click();
          await sheet.waitFor({ state: "hidden" });
          await expect
            .poll(() => linkTarget(join(viaApp, ".claude/skills/notes")))
            .toBe(join(viaApp, ".gandalf/skills/notes"));
          await expect.poll(() => app.countLine()).toBe("1 skill");
          await expect.poll(() => row(app, "review").innerText()).toContain("Two versions");
          expect(await menuChecked(app)).toBe(true);
          expect(await consent(app).count()).toBe(0);
        });
        const library = (home: string) => listTree(join(home, ".gandalf/skills"));
        expect(await library(viaApp)).toEqual(await library(viaCli));
        for (const home of [viaApp, viaCli]) {
          for (const agent of [".claude", ".codex"]) {
            expect(await readlink(join(home, agent, "skills/notes"))).toBe(
              join(home, ".gandalf/skills/notes"),
            );
          }
        }
        const list = async (home: string) =>
          JSON.stringify((await gandalfCli(home, ["skills", "list"])).json)
            .replaceAll(home, "~")
            .replace(/"installedAt":"[^"]+"/g, "");
        expect(await list(viaApp)).toBe(await list(viaCli));
      });
    });
  });

  it("Not Now leaves every copy where it is, and the menu turns managing on later", async () => {
    await withHome("threeAgreeing", async (home) => {
      await withApp({ home, autoManage: "ask" }, async (app) => {
        const sheet = consent(app);
        await sheet.getByRole("button", { name: "Manage 3 Skills" }).waitFor();
        await sheet.getByRole("button", { name: "Not Now" }).click();
        await sheet.waitFor({ state: "hidden" });
        await app.settle();
        expect(await exists(join(home, ".gandalf/skills/alpha"))).toBe(false);
        expect(await menuChecked(app)).toBe(false);

        await clickMenu(app);
        await expect.poll(() => app.countLine()).toBe("3 skills");
        expect(await menuChecked(app)).toBe(true);
      });
      for (const name of ["alpha", "bravo", "charlie"]) {
        expect(await exists(join(home, ".gandalf/skills", name, "SKILL.md"))).toBe(true);
        for (const agent of [".claude", ".cursor"]) {
          expect((await lstat(join(home, agent, "skills", name))).isSymbolicLink()).toBe(true);
        }
      }
    });
  });

  it("asks nothing again on the next launch once answered", async () => {
    await withHome("threeAgreeing", async (home) => {
      const userData = await mkdtemp(join(tmpdir(), "gandalf-user-data-"));
      try {
        await withApp({ home, userData, autoManage: "ask" }, async (app) => {
          await consent(app).getByRole("button", { name: "Not Now" }).click();
          await consent(app).waitFor({ state: "hidden" });
        });
        await withApp({ home, userData, autoManage: "ask" }, async (app) => {
          await app.countLine();
          await app.settle();
          expect(await consent(app).count()).toBe(0);
          expect(await menuChecked(app)).toBe(false);
        });
      } finally {
        await rm(userData, { recursive: true, force: true });
      }
    });
  });

  it("brings in a skill placed by hand while it runs, without input", async () => {
    await withHome("twoAgents", async (home) => {
      await withApp({ home, autoManage: "on" }, async (app) => {
        expect(await app.countLine()).toBe("1 skill");
        await mkdir(join(home, ".cursor/skills/fresh"), { recursive: true });
        await writeFile(
          join(home, ".cursor/skills/fresh/SKILL.md"),
          "---\nname: fresh\ndescription: Placed just now\n---\n",
        );
        await expect.poll(() => app.countLine()).toBe("2 skills");
        await row(app, "fresh").waitFor();
      });
      expect(await readlink(join(home, ".cursor/skills/fresh"))).toBe(
        join(home, ".gandalf/skills/fresh"),
      );
    });
  });

  it("moves a skill in from ~/.agents/skills and links it into Codex and GitHub Copilot", async () => {
    await withHome("scanRoot", async (home) => {
      await withApp({ home, autoManage: "on" }, async (app) => {
        await expect.poll(() => app.countLine()).toBe("1 skill");
        expect(await app.cellStatus("shared-notes", "Codex")).toBe("● Linked");
        expect(await app.cellStatus("shared-notes", "GitHub Copilot")).toBe("● Linked");
        expect(await app.cellStatus("shared-notes", "Claude Code")).toBe("· Off");
      });
      expect(await exists(join(home, ".gandalf/skills/shared-notes/SKILL.md"))).toBe(true);
      expect(await readlink(join(home, ".agents/skills/shared-notes"))).toBe(
        join(home, ".gandalf/skills/shared-notes"),
      );
    });
  });

  it("waits while another gandalf holds the lock, then manages once the disk changes", async () => {
    await withHome("threeAgreeing", async (home) => {
      const release = await holdLock(home);
      await withApp({ home, autoManage: "on" }, async (app) => {
        await app.countLine();
        await app.settle();
        expect(await exists(join(home, ".gandalf/skills/alpha"))).toBe(false);
        await release();
        await mkdir(join(home, ".cursor/skills/delta"), { recursive: true });
        await writeFile(
          join(home, ".cursor/skills/delta/SKILL.md"),
          "---\nname: delta\ndescription: The delta skill\n---\n",
        );
        await expect.poll(() => app.countLine()).toBe("4 skills");
      });
    });
  });
});

describe("Two versions waits for the user to keep one", () => {
  it("shows both versions of review with a diff, and keeps the one you pick", async () => {
    await withHome("adoptChoice", async (home) => {
      const variants = await variantsOf(home, "review");
      expect(variants).toHaveLength(2);
      const [first, second] = variants as [Variant, Variant];
      const other = first.at[0]?.path ?? "";
      const keptText = await readFile(join(second.at[0]?.path ?? "", "SKILL.md"), "utf8");
      await withApp({ home, autoManage: "on" }, async (app) => {
        await expect.poll(() => app.countLine()).toBe("1 skill");
        expect(await row(app, "review").innerText()).toContain("Two versions");
        const panel = await openVersions(app, "review");
        expect(await panel.innerText()).toContain(
          `${agentOf(home, first)} and ${agentOf(home, second)} each have their own review`,
        );
        const diff = panel.getByRole("figure");
        await diff.waitFor();
        expect(await diff.locator("figcaption").innerText()).toMatch(
          new RegExp(
            `${agentOf(home, first)} · sha256:${first.hash.slice(7, 15)}[\\s\\S]*${agentOf(home, second)} · sha256:${second.hash.slice(7, 15)}`,
          ),
        );
        expect(await diff.locator(".bg-diff-remove").count()).toBeGreaterThan(0);
        expect(await diff.locator(".bg-diff-add").count()).toBeGreaterThan(0);

        await panel
          .getByRole("button", { name: `Keep ${agentOf(home, second)}'s version of review` })
          .click();
        const sheet = app.sheet();
        await sheet.waitFor();
        expect(await sheet.getByRole("heading", { level: 2 }).textContent()).toBe(
          "Keep One Version of review",
        );
        expect(await sheet.innerText()).toContain(
          `Move your copy of review in ${agentOf(home, first)} to the Trash`,
        );
        await app.applySheet();
        await expect.poll(() => app.countLine()).toBe("2 skills");
        await expect.poll(() => row(app, "review").innerText()).not.toContain("Two versions");
      });
      expect(await libraryHash(home, "review")).toBe(second.hash);
      expect(await readFile(join(home, ".gandalf/skills/review/SKILL.md"), "utf8")).toBe(keptText);
      // Both agents read the kept version now, and the other one waits in the Trash.
      for (const path of [other, second.at[0]?.path ?? ""]) {
        expect(await readlink(path)).toBe(join(home, ".gandalf/skills/review"));
      }
      expect(await exists(join(home, ".gandalf/trash"))).toBe(true);
    });
  });

  it("says when SKILL.md is the same in both versions, or differs only in line endings", async () => {
    await withHome("adoptChoice", async (home) => {
      const claude = await readFile(join(home, ".claude/skills/review/SKILL.md"), "utf8");
      await writeFile(join(home, ".cursor/skills/review/SKILL.md"), claude);
      await writeFile(join(home, ".cursor/skills/review/notes.txt"), "only Cursor has this");
      await withApp({ home }, async (app) => {
        const panel = await openVersions(app, "review");
        await panel.getByText("SKILL.md is the same in both. Other files differ.").waitFor();
        expect(await panel.locator("[data-diff-lines]").count()).toBe(0);
      });
    });
    await withHome("adoptChoice", async (home) => {
      const claude = await readFile(join(home, ".claude/skills/review/SKILL.md"), "utf8");
      await writeFile(
        join(home, ".cursor/skills/review/SKILL.md"),
        claude.replaceAll("\n", "\r\n"),
      );
      await withApp({ home }, async (app) => {
        const panel = await openVersions(app, "review");
        const note = panel.locator("[data-diff-note]");
        await note.first().waitFor();
        expect(await note.innerText()).toMatch(
          /SKILL\.md ends its lines with CRLF and .*'s with LF\./,
        );
        expect(await note.innerText()).toContain("Apart from that, the lines are the same.");
        expect(await panel.locator("[data-diff-lines]").count()).toBe(0);
      });
    });
  });

  it("serves readSkillFile only inside skill folders the snapshot shows", async () => {
    await withHome("adoptChoice", async (home) => {
      await withApp({ home }, async (app) => {
        await app.countLine();
        const read = (path: string) =>
          app.page.evaluate((p) => window.gandalf.readSkillFile(p), path);
        expect(await read("/etc/hosts")).toMatchObject({
          ok: false,
          error: { kind: "badInput", field: "path" },
        });
        expect(
          await read(`${home}/.cursor/skills/review/../../../.claude/skills/review/SKILL.md`),
        ).toMatchObject({
          ok: false,
          error: { kind: "badInput" },
        });
        expect(await read(join(home, ".cursor/skills/review/SKILL.md"))).toMatchObject({
          ok: true,
          value: expect.stringContaining("The Cursor variant."),
        });
      });
    });
  });

  it("scrolls a long diff inside its own pane, never the window", async () => {
    await withHome("longDiff", async (home) => {
      await withApp({ home }, async (app) => {
        const panel = await openVersions(app, "handbook");
        const lines = panel.locator("[data-diff-lines]");
        await lines.waitFor();
        const box = await lines.evaluate((element) => ({
          scrollHeight: element.scrollHeight,
          clientHeight: element.clientHeight,
        }));
        expect(box.scrollHeight).toBeGreaterThan(box.clientHeight * 4);
        await lines.hover();
        await app.page.mouse.wheel(0, 2000);
        await expect.poll(() => lines.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
        const outside = await app.page.evaluate(() => ({
          document: document.scrollingElement?.scrollTop ?? 0,
          window: window.scrollY,
          height: document.documentElement.scrollHeight - window.innerHeight,
        }));
        expect(outside).toEqual({ document: 0, window: 0, height: 0 });
      });
    });
  });

  it("caps a diff past the edit cap, says how many changes it hides, and shows them all on request", async () => {
    await withHome("longDiff", async (home) => {
      const body = (variant: string) =>
        Array.from({ length: 1200 }, (_, n) => `Line ${n + 1} of the ${variant} way.`).join("\n");
      const variants = { ".claude": "Claude Code", ".cursor": "Cursor" };
      for (const [dir, variant] of Object.entries(variants)) {
        await writeFile(
          join(home, dir, "skills/handbook/SKILL.md"),
          `---\nname: handbook\ndescription: House rules\n---\n\n${body(variant)}\n`,
        );
      }
      await withApp({ home }, async (app) => {
        const panel = await openVersions(app, "handbook");
        const lines = panel.locator("[data-diff-lines]");
        await lines.waitFor();
        expect(await lines.innerText()).toMatch(/more lines not shown, \d+ of them changed\./);
        const lastLines = lines.getByText(/^Line 1200 of the/);
        expect(await lastLines.count()).toBe(0);
        await lines.getByRole("button", { name: "Show All Lines" }).click();
        await expect.poll(() => lastLines.count()).toBe(2);
        expect(await lines.innerText()).not.toContain("not shown");
      });
    });
  });

  it("keeps diff label text at 4.5:1 on its add and remove fills, light and dark", async () => {
    await withHome("adoptChoice", async (home) => {
      await withApp({ home }, async (app) => {
        const panel = await openVersions(app, "review");
        await panel.getByRole("figure").waitFor();
        for (const theme of ["light", "dark"] as const) {
          await app.setTheme(theme);
          const { add, remove } = await diffContrasts(panel);
          expect(add, `${theme} add`).toBeGreaterThanOrEqual(4.5);
          expect(remove, `${theme} remove`).toBeGreaterThanOrEqual(4.5);
        }
        await app.setTheme("light");
      });
    });
  });
});

describe("Replace trades a folder you placed in gandalf's slot for the library's skill", () => {
  it("explains the conflict in the skill's detail and replaces it only when asked", async () => {
    await withHome("conflict", async (home) => {
      const placed = join(home, ".cursor/skills/demo");
      const before = await listTree(placed);
      expect((await gandalfCli(home, ["skills", "enable", "demo", "--agent", "cursor"])).code).toBe(
        0,
      );
      await withApp({ home, autoManage: "on" }, async (app) => {
        await app.countLine();
        await row(app, "demo").click();
        const problems = app.page
          .getByRole("complementary", { name: "demo", exact: true })
          .getByRole("region", { name: "Problems" });
        await expect
          .poll(() => problems.innerText())
          .toContain(
            "gandalf never writes over a folder it did not put there. Replace moves yours to the Trash and links the library's demo in its place.",
          );
        await app.settle();
        // Managing on its own never touches a folder you placed in a slot.
        expect(await listTree(placed)).toEqual(before);

        await problems.getByRole("button", { name: "Replace…" }).click();
        const sheet = app.sheet();
        await sheet.waitFor();
        expect(await sheet.getByRole("heading", { level: 2 }).textContent()).toBe(
          "Replace Your demo Folders",
        );
        expect(await sheet.innerText()).toContain("Move your copy of demo in Cursor to the Trash");
        await app.applySheet();
        await expect.poll(() => linkTarget(placed)).toBe(join(home, ".gandalf/skills/demo"));
        await expect.poll(() => problems.count()).toBe(0);
      });
      expect(await exists(join(home, ".gandalf/trash"))).toBe(true);
    });
  });

  it("links a copy in gandalf's slot that matches the library by itself", async () => {
    await withHome("twoAgents", async (home) => {
      const placed = join(home, ".cursor/skills/demo");
      await cp(join(home, ".gandalf/skills/demo"), placed, { recursive: true });
      expect((await gandalfCli(home, ["skills", "enable", "demo", "--agent", "cursor"])).code).toBe(
        0,
      );
      await withApp({ home, autoManage: "on" }, async (app) => {
        await expect.poll(() => linkTarget(placed)).toBe(join(home, ".gandalf/skills/demo"));
        expect(await app.countLine()).toBe("1 skill");
      });
    });
  });
});
