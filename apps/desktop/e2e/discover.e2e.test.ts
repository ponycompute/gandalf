import { cp, lstat, mkdir, readFile, readlink, rm, writeFile } from "node:fs/promises";
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

async function openDiscover(app: App): Promise<void> {
  await app.countLine();
  await app.page
    .getByRole("navigation", { name: "Sections" })
    .getByRole("button", { name: "Discover" })
    .click();
  await app.page.locator("header").getByText("Discover", { exact: true }).waitFor();
}

const section = (app: App, name: string) => app.page.getByRole("region", { name, exact: true });

/** The names a section lists, each row's first bold line. */
function rowNames(scope: Locator): Promise<string[]> {
  return scope
    .getByRole("listitem")
    .evaluateAll((items) =>
      items.map((item) => item.querySelector(".font-semibold")?.textContent ?? ""),
    );
}

async function adoptFromDiscover(app: App, name: string): Promise<Locator> {
  await section(app, "Not managed")
    .getByRole("button", { name: `Adopt ${name}`, exact: true })
    .click();
  const sheet = app.sheet();
  await sheet.waitFor();
  return sheet;
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

describe("Discover lists what gandalf does not manage and adopts it", () => {
  it("adopts a skill whose copies agree the same way the CLI does", async () => {
    await withHome("adoptChoice", async (viaCli) => {
      await withHome("adoptChoice", async (viaApp) => {
        expect((await gandalfCli(viaCli, ["skills", "adopt", "notes"])).code).toBe(0);
        await withApp({ home: viaApp }, async (app) => {
          await openDiscover(app);
          expect(await rowNames(section(app, "Not managed"))).toEqual(["notes", "review"]);
          const sheet = await adoptFromDiscover(app, "notes");
          expect(await sheet.getByRole("heading", { level: 2 }).textContent()).toBe("Adopt notes");
          await app.applySheet();
          await expect.poll(() => rowNames(section(app, "Not managed"))).toEqual(["review"]);
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

  it("Adopt All moves every agreeing skill into the library and leaves Discover empty", async () => {
    await withHome("threeAgreeing", async (home) => {
      await withApp({ home }, async (app) => {
        await openDiscover(app);
        const all = section(app, "Not managed").getByRole("button", { name: "Adopt 3 Skills" });
        await all.click();
        const sheet = app.sheet();
        await sheet.waitFor();
        expect(await sheet.getByRole("heading", { level: 2 }).textContent()).toBe(
          "Adopt alpha, bravo, and charlie",
        );
        await app.applySheet();
        await app.page.getByText("Nothing to adopt.").waitFor();
        expect(await app.countLine()).toBe("3 skills in 2 agents");
      });
      for (const name of ["alpha", "bravo", "charlie"]) {
        expect(await exists(join(home, ".gandalf/skills", name, "SKILL.md"))).toBe(true);
        for (const agent of [".claude", ".cursor"]) {
          expect((await lstat(join(home, agent, "skills", name))).isSymbolicLink()).toBe(true);
        }
      }
    });
  });

  it("lists a name waiting for a choice as Not managed while another gandalf holds the lock", async () => {
    await withHome("threeAgreeing", async (home) => {
      await withApp({ home }, async (app) => {
        await openDiscover(app);
        await section(app, "Not managed").getByRole("button", { name: "Adopt 3 Skills" }).click();
        const sheet = app.sheet();
        await sheet.waitFor();
        // alpha's copies differ by the time Apply runs, so the fresh plan asks which to keep.
        await writeFile(
          join(home, ".cursor/skills/alpha/SKILL.md"),
          "---\nname: alpha\ndescription: Cursor's own alpha\n---\n",
        );
        await sheet.getByRole("button", { name: "Apply" }).click();
        await sheet.getByText("Choose the version of alpha to adopt").waitFor();
        const release = await holdLock(home);
        try {
          await sheet.getByRole("button", { name: "Apply" }).click();
          await sheet.getByRole("button", { name: "Try Again" }).waitFor();
          expect(await sheet.getByText("Choose the version of alpha to adopt").count()).toBe(0);
          const notDoing = sheet.getByRole("region", { name: "Not doing" });
          expect(await notDoing.innerText()).toMatch(/\?\s+Not managed/);
          expect(await notDoing.innerText()).toContain(
            "The 2 versions of alpha differ, so this change leaves its copies where they are.",
          );
          expect(await sheet.innerText()).not.toContain("✗");
          expect(await sheet.innerText()).not.toContain("above");
        } finally {
          await release();
        }
        await sheet.getByRole("button", { name: "Try Again" }).click();
        await sheet.waitFor({ state: "hidden" });
      });
      expect(await exists(join(home, ".gandalf/skills/alpha"))).toBe(false);
      for (const name of ["bravo", "charlie"]) {
        expect(await exists(join(home, ".gandalf/skills", name, "SKILL.md"))).toBe(true);
      }
    });
  });

  it("leaves a name whose copies differ out of Adopt All", async () => {
    await withHome("adoptChoice", async (home) => {
      await withApp({ home }, async (app) => {
        await openDiscover(app);
        await section(app, "Not managed").getByRole("button", { name: "Adopt 1 Skill" }).click();
        await app.sheet().waitFor();
        expect(await app.sheet().getByRole("heading", { level: 2 }).textContent()).toBe(
          "Adopt notes",
        );
      });
    });
  });

  it("shows both versions of review with a diff, and adopts the one you pick", async () => {
    await withHome("adoptChoice", async (home) => {
      const variants = await variantsOf(home, "review");
      expect(variants).toHaveLength(2);
      const [first, second] = variants as [Variant, Variant];
      const loser = first.at[0]?.path ?? "";
      const pickedText = await readFile(join(second.at[0]?.path ?? "", "SKILL.md"), "utf8");
      const loserBefore = await listTree(loser);
      await withApp({ home }, async (app) => {
        await openDiscover(app);
        const sheet = await adoptFromDiscover(app, "review");
        const diff = sheet.getByRole("figure");
        await diff.waitFor();
        expect(await diff.locator("figcaption").innerText()).toMatch(
          new RegExp(
            `${agentOf(home, first)} · sha256:${first.hash.slice(7, 15)}[\\s\\S]*${agentOf(home, second)} · sha256:${second.hash.slice(7, 15)}`,
          ),
        );
        expect(await diff.locator(".bg-diff-remove").count()).toBeGreaterThan(0);
        expect(await diff.locator(".bg-diff-add").count()).toBeGreaterThan(0);
        expect(await sheet.getByRole("button", { name: "Apply" }).isDisabled()).toBe(true);
        expect(await sheet.innerText()).not.toContain("✗");
        expect(await sheet.getByRole("region", { name: "Not doing" }).count()).toBe(0);
        const wide = (await sheet.boundingBox())?.width;

        await sheet
          .getByRole("button", { name: `Adopt ${agentOf(home, second)}'s Version` })
          .click();
        await sheet.getByRole("button", { name: "Apply" }).and(sheet.locator(":enabled")).waitFor();
        expect(await sheet.getByRole("figure").count()).toBe(0);
        expect((await sheet.boundingBox())?.width).toBe(wide);
        const notDoing = sheet.getByRole("region", { name: "Not doing" });
        // The unpicked copy reads as Discover and the library show it, not as a conflict.
        expect(await notDoing.innerText()).toMatch(/\?\s+Not managed/);
        expect(await sheet.innerText()).not.toContain("✗");
        expect(await notDoing.innerText()).toContain(
          `${agentOf(home, first)} keeps its own version of review. gandalf does not replace a skill you placed.`,
        );
        await app.applySheet();
        // The core leaves the unpicked copy unmanaged, and adopt would take nothing from it.
        const cannot = section(app, "Cannot adopt");
        await expect.poll(() => rowNames(cannot)).toEqual(["review"]);
        expect(await cannot.innerText()).toMatch(/\?\s+Not managed/);
        expect(await cannot.innerText()).toContain(
          `${agentOf(home, first)} keeps its own version of review. gandalf does not replace a skill you placed. To use the library's version there, remove this copy, then Sync.`,
        );
        expect(await cannot.getByRole("button").count()).toBe(0);
        expect(await section(app, "Conflict").count()).toBe(0);
      });
      expect(await libraryHash(home, "review")).toBe(second.hash);
      expect(await readFile(join(home, ".gandalf/skills/review/SKILL.md"), "utf8")).toBe(
        pickedText,
      );
      // The unpicked copy stays byte for byte where you placed it, and gandalf deleted nothing.
      expect(await listTree(loser)).toEqual(loserBefore);
      expect(await exists(join(home, ".gandalf/trash"))).toBe(false);
      // Only the agent whose copy matched the picked version is linked.
      expect(await readlink(second.at[0]?.path ?? "")).toBe(join(home, ".gandalf/skills/review"));
      expect((await lstat(loser)).isDirectory()).toBe(true);
    });
  });

  it("explains a conflict in your words and offers nothing that replaces it", async () => {
    await withHome("conflict", async (home) => {
      const placed = await listTree(join(home, ".cursor/skills/demo"));
      await withApp({ home }, async (app) => {
        await openDiscover(app);
        const cannot = section(app, "Cannot adopt");
        expect(await rowNames(cannot)).toEqual(["demo"]);
        expect(await cannot.innerText()).toContain(
          "Cursor keeps its own version of demo. gandalf does not replace a skill you placed.",
        );
        expect(await cannot.getByRole("button").count()).toBe(0);
        expect(await section(app, "Conflict").count()).toBe(0);
        await gandalfCli(home, ["skills", "enable", "demo", "--agent", "cursor"]);
        const conflicts = section(app, "Conflict");
        await expect
          .poll(() => conflicts.innerText())
          .toContain("A skill you placed there uses this name. gandalf never replaces it.");
        expect(await conflicts.getByRole("button").count()).toBe(0);
        expect(await app.page.getByRole("button", { name: /Adopt/ }).count()).toBe(0);
      });
      expect(await listTree(join(home, ".cursor/skills/demo"))).toEqual(placed);
    });
  });

  it("offers Adopt for a copy in gandalf's slot that matches the library, and links it", async () => {
    await withHome("twoAgents", async (home) => {
      const placed = join(home, ".cursor/skills/demo");
      await cp(join(home, ".gandalf/skills/demo"), placed, { recursive: true });
      expect((await gandalfCli(home, ["skills", "enable", "demo", "--agent", "cursor"])).code).toBe(
        0,
      );
      await withApp({ home }, async (app) => {
        await openDiscover(app);
        expect(await section(app, "Conflict").count()).toBe(0);
        const notManaged = section(app, "Not managed");
        expect(await rowNames(notManaged)).toEqual(["demo"]);
        expect(await notManaged.innerText()).toContain(
          "The library has this same version of demo.",
        );
        const sheet = await adoptFromDiscover(app, "demo");
        expect(await sheet.innerText()).toContain(
          "Move the copy of demo in Cursor that matches the library to the Trash",
        );
        await app.applySheet();
        await app.page.getByText("Nothing to adopt.").waitFor();
      });
      expect(await readlink(placed)).toBe(join(home, ".gandalf/skills/demo"));
    });
  });

  it("offers Adopt for a conflict whose library folder is gone, since adopt takes it", async () => {
    await withHome("conflict", async (home) => {
      const placed = join(home, ".cursor/skills/demo");
      const text = await readFile(join(placed, "SKILL.md"), "utf8");
      expect((await gandalfCli(home, ["skills", "enable", "demo", "--agent", "cursor"])).code).toBe(
        0,
      );
      await rm(join(home, ".gandalf/skills/demo"), { recursive: true });
      await withApp({ home }, async (app) => {
        await openDiscover(app);
        expect(await section(app, "Conflict").count()).toBe(0);
        const notManaged = section(app, "Not managed");
        expect(await rowNames(notManaged)).toEqual(["demo"]);
        expect(await notManaged.textContent()).toContain("~/.cursor/skills/demo");
        const sheet = await adoptFromDiscover(app, "demo");
        expect(await sheet.innerText()).toContain("Move demo from Cursor into the library");
        await app.applySheet();
      });
      expect(await readFile(join(home, ".gandalf/skills/demo/SKILL.md"), "utf8")).toBe(text);
      expect(await readlink(placed)).toBe(join(home, ".gandalf/skills/demo"));
    });
  });

  it("reads a variant again when it is rewritten while the choice is open", async () => {
    await withHome("adoptChoice", async (home) => {
      await withApp({ home }, async (app) => {
        await openDiscover(app);
        const sheet = await adoptFromDiscover(app, "review");
        await sheet.getByRole("figure").waitFor();
        // Keep the variants in the same order, so only their hashes tell the old read from the new.
        const order = (variants: readonly Variant[]) => variants.map((v) => agentOf(home, v));
        const before = order(await variantsOf(home, "review"));
        let rewritten: Variant | undefined;
        for (let attempt = 0; rewritten === undefined; attempt += 1) {
          await writeFile(
            join(home, ".cursor/skills/review/SKILL.md"),
            `---\nname: review\ndescription: Review a PR\n---\n\nThe rewritten Cursor variant.${" ".repeat(attempt)}\n`,
          );
          const now = await variantsOf(home, "review");
          if (order(now).join() === before.join()) {
            rewritten = now.find((variant) => agentOf(home, variant) === "Cursor");
          }
        }
        await sheet.getByRole("button", { name: "Adopt Cursor's Version" }).click();
        await sheet.getByText("The version you picked changed on disk").waitFor();
        const diff = sheet.getByRole("region", { name: "Changes in SKILL.md" });
        await expect.poll(() => diff.innerText()).toContain("The rewritten Cursor variant.");
        expect(await sheet.getByRole("figure").locator("figcaption").innerText()).toContain(
          `Cursor · sha256:${rewritten?.hash.slice(7, 15) ?? "?"}`,
        );
        await sheet.getByRole("button", { name: "Cancel" }).click();
        await sheet.waitFor({ state: "hidden" });
      });
      expect(await exists(join(home, ".gandalf/skills/review"))).toBe(false);
    });
  });

  it("never applies the other version when the one you picked is deleted first", async () => {
    await withHome("adoptChoice", async (home) => {
      const variants = await variantsOf(home, "review");
      const claude = variants.find((variant) => agentOf(home, variant) === "Claude Code");
      await withApp({ home }, async (app) => {
        await openDiscover(app);
        const sheet = await adoptFromDiscover(app, "review");
        await sheet.getByRole("figure").waitFor();
        await rm(join(home, ".cursor/skills/review"), { recursive: true });
        await sheet.getByRole("button", { name: "Adopt Cursor's Version" }).click();
        await sheet.getByText("The version you picked changed on disk").waitFor();
        expect(await sheet.getByRole("status").innerText()).toContain(
          `Only one version of review is left, Claude Code's (sha256:${claude?.hash.slice(7, 15) ?? "?"}), so Apply would adopt it instead of the version you picked. Nothing was written.`,
        );
        const apply = sheet.getByRole("button", { name: "Apply" });
        expect(await apply.isDisabled()).toBe(true);
        expect(await exists(join(home, ".gandalf/skills/review"))).toBe(false);
        await sheet.getByRole("button", { name: "Adopt Claude Code's Version" }).click();
        await apply.and(sheet.locator(":enabled")).waitFor();
        expect(await sheet.getByText("The version you picked changed on disk").count()).toBe(0);
        await app.applySheet();
      });
      expect(await libraryHash(home, "review")).toBe(claude?.hash);
    });
  });

  it("says when SKILL.md is the same in both versions, or differs only in line endings", async () => {
    await withHome("adoptChoice", async (home) => {
      const claude = await readFile(join(home, ".claude/skills/review/SKILL.md"), "utf8");
      await writeFile(join(home, ".cursor/skills/review/SKILL.md"), claude);
      await writeFile(join(home, ".cursor/skills/review/notes.txt"), "only Cursor has this");
      await withApp({ home }, async (app) => {
        await openDiscover(app);
        const sheet = await adoptFromDiscover(app, "review");
        await sheet.getByText("SKILL.md is the same in both. Other files differ.").waitFor();
        expect(await sheet.locator("[data-diff-lines]").count()).toBe(0);
      });
    });
    await withHome("adoptChoice", async (home) => {
      const claude = await readFile(join(home, ".claude/skills/review/SKILL.md"), "utf8");
      await writeFile(
        join(home, ".cursor/skills/review/SKILL.md"),
        claude.replaceAll("\n", "\r\n"),
      );
      await withApp({ home }, async (app) => {
        await openDiscover(app);
        const sheet = await adoptFromDiscover(app, "review");
        await sheet.locator("[data-diff-note]").first().waitFor();
        expect(await sheet.locator("[data-diff-note]").innerText()).toMatch(
          /SKILL\.md ends its lines with CRLF and .*'s with LF\./,
        );
        expect(await sheet.locator("[data-diff-note]").innerText()).toContain(
          "Apart from that, the lines are the same.",
        );
        // Nothing differs once line endings are set aside, so the note shows without a pane.
        expect(await sheet.locator("[data-diff-lines]").count()).toBe(0);
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
        await openDiscover(app);
        expect(await section(app, "Not managed").getByRole("button").allTextContents()).toEqual([
          "Adopt",
        ]);
        const sheet = await adoptFromDiscover(app, "handbook");
        const lines = sheet.locator("[data-diff-lines]");
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
        const dialog = await sheet.boundingBox();
        expect((dialog?.y ?? 0) + (dialog?.height ?? 0)).toBeLessThanOrEqual(640);
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
        await openDiscover(app);
        const sheet = await adoptFromDiscover(app, "handbook");
        const lines = sheet.locator("[data-diff-lines]");
        await lines.waitFor();
        expect(await lines.innerText()).toMatch(/more lines not shown, \d+ of them changed\./);
        // Every line differs, so the diff lists one version's lines, then the other's.
        const lastLines = lines.getByText(/^Line 1200 of the/);
        expect(await lastLines.count()).toBe(0);
        await lines.getByRole("button", { name: "Show All Lines" }).click();
        await expect.poll(() => lastLines.count()).toBe(2);
        expect(await lines.innerText()).not.toContain("not shown");
      });
    });
  });

  it("adopts from ~/.agents/skills and links it into Codex and GitHub Copilot", async () => {
    await withHome("scanRoot", async (home) => {
      await withApp({ home }, async (app) => {
        await openDiscover(app);
        expect(await rowNames(section(app, "Not managed"))).toEqual(["shared-notes"]);
        const sheet = await adoptFromDiscover(app, "shared-notes");
        expect(await sheet.innerText()).toContain(
          "Move shared-notes from ~/.agents/skills into the library",
        );
        await app.applySheet();
        await app.page.getByText("Nothing to adopt.").waitFor();
        await app.page
          .getByRole("navigation", { name: "Sections" })
          .getByRole("button", { name: "Library" })
          .click();
        expect(await app.cellStatus("shared-notes", "Codex")).toBe("● Linked");
        expect(await app.cellStatus("shared-notes", "GitHub Copilot")).toBe("● Linked");
        expect(await app.cellStatus("shared-notes", "Claude Code")).toBe("· Off");
      });
      expect(await exists(join(home, ".gandalf/skills/shared-notes/SKILL.md"))).toBe(true);
      expect(await exists(join(home, ".agents/skills/shared-notes"))).toBe(false);
    });
  });

  it("keeps diff label text at 4.5:1 on its add and remove fills, light and dark", async () => {
    await withHome("adoptChoice", async (home) => {
      await withApp({ home }, async (app) => {
        await openDiscover(app);
        const sheet = await adoptFromDiscover(app, "review");
        await sheet.getByRole("figure").waitFor();
        for (const theme of ["light", "dark"] as const) {
          await app.setTheme(theme);
          const { add, remove } = await diffContrasts(sheet);
          expect(add, `${theme} add`).toBeGreaterThanOrEqual(4.5);
          expect(remove, `${theme} remove`).toBeGreaterThanOrEqual(4.5);
        }
        await app.setTheme("light");
      });
    });
  });

  it("shows a skill placed by hand while Discover is open, without input", async () => {
    await withHome("twoAgents", async (home) => {
      await withApp({ home }, async (app) => {
        await openDiscover(app);
        await app.page.getByText("Nothing to adopt.").waitFor();
        await mkdir(join(home, ".cursor/skills/fresh"), { recursive: true });
        await writeFile(
          join(home, ".cursor/skills/fresh/SKILL.md"),
          "---\nname: fresh\ndescription: Placed just now\n---\n",
        );
        await expect.poll(() => rowNames(section(app, "Not managed"))).toEqual(["fresh"]);
      });
    });
  });
});
