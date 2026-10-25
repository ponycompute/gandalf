import { chmod, lstat, mkdir, readlink, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { Locator } from "playwright";
import { describe, expect, it } from "vitest";
import { listTree, withHome } from "./homes";
import { gandalfCli, holdLock, withApp, type App } from "./lever";

interface CellJson {
  readonly agent: string;
  readonly enabled: boolean;
  readonly verdict: string;
}

async function cliCells(home: string, skill: string): Promise<readonly CellJson[]> {
  const skills = (await gandalfCli(home, ["skills", "list"])).json as readonly {
    readonly name: string;
    readonly cells: readonly CellJson[];
  }[];
  return skills.find((entry) => entry.name === skill)?.cells ?? [];
}

const cellOf = (cells: readonly CellJson[], agent: string) =>
  cells.find((cell) => cell.agent === agent);

/** Each change list row as "glyph word | path | sentence", the path as its tooltip spells it. */
function rowTexts(scope: Locator): Promise<string[]> {
  return scope.getByRole("listitem").evaluateAll((items) =>
    items.map((item) => {
      const [status, body] = [...item.children];
      const word = [...(status?.children ?? [])].map((part) => part.textContent).join(" ");
      const path = body?.querySelector("[title]")?.getAttribute("title") ?? "";
      return [word, path, body?.lastElementChild?.textContent ?? ""].join(" | ");
    }),
  );
}

function exists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false,
  );
}

function style(locator: Locator, property: string): Promise<string> {
  return locator.evaluate(
    (element, name) => getComputedStyle(element).getPropertyValue(name),
    property,
  );
}

const SUMMARY = /^\d+ done, \d+ already done, \d+ drifted, \d+ failed, \d+ skipped/;

async function summary(app: App): Promise<string> {
  const line = app.page.getByRole("status").getByText(SUMMARY);
  await line.waitFor();
  return (await line.textContent()) ?? "";
}

/** The toolbar's count line, with the reason Sync is disabled once it is known. */
function toolbarStatus(app: App): Promise<string> {
  return app.page.locator("header").getByRole("status").innerText();
}

/** Waits until the toolbar has planned a sync for what is on screen and says why Sync is off. */
async function syncSettled(app: App, reason: string): Promise<void> {
  await expect.poll(() => toolbarStatus(app)).toMatch(new RegExp(` · ${reason}$`));
}

/** Records each text the toolbar's live region takes from now on, the way a screen reader hears it. */
async function watchToolbarStatus(app: App): Promise<void> {
  await app.page
    .locator("header")
    .getByRole("status")
    .evaluate((region) => {
      const seen: string[] = [];
      Object.assign(window, { toolbarStatusChanges: seen });
      let last = region.textContent;
      new MutationObserver(() => {
        if (region.textContent === last) return;
        last = region.textContent;
        seen.push(last ?? "");
      }).observe(region, { childList: true, characterData: true, subtree: true });
    });
}

function toolbarStatusChanges(app: App): Promise<readonly string[]> {
  return app.page.evaluate(
    () => (window as unknown as { toolbarStatusChanges: readonly string[] }).toolbarStatusChanges,
  );
}

const SETTLE_MS = 500;
const PRELOAD = fileURLToPath(new URL("../out/preload/index.cjs", import.meta.url));

/** Exactly one snapshot read after `mark`, once any late ones would have printed. */
async function oneSnapshotSince(app: App, mark: number): Promise<void> {
  await app.timing("snapshot", { after: mark });
  await delay(SETTLE_MS);
  expect(app.timings("snapshot", { after: mark })).toHaveLength(1);
}

describe("toggling a cell in the library matrix", () => {
  it("links demo into Cursor through the preview, as the CLI would", async () => {
    await withHome("twoAgents", async (home) => {
      await withHome("twoAgents", async (cliHome) => {
        await withApp({ home }, async (app) => {
          await app.countLine();
          await syncSettled(app, "Nothing to sync");
          expect(await app.cellStatus("demo", "Cursor")).toBe("· Off");
          const toggled = app.mark();
          const sheet = await app.toggleCell("demo", "Cursor");
          expect(await sheet.getByRole("heading", { level: 2 }).textContent()).toBe(
            "Turn on demo for Cursor",
          );
          expect(await rowTexts(sheet)).toEqual([
            "○ Create | ~/.cursor/skills | Create the skills folder for Cursor",
            "○ Link | ~/.cursor/skills/demo → ~/.gandalf/skills/demo | Link demo into Cursor",
            "◐ Save | ~/.gandalf/state.json | Save demo as on for Cursor and Claude Code",
          ]);
          expect(await app.page.evaluate(() => document.activeElement?.textContent)).toBe("Apply");
          expect(await app.timing("plan", { after: toggled })).toBeGreaterThan(0);
          const applied = app.mark();
          await app.applySheet();

          await expect.poll(() => app.cellStatus("demo", "Cursor")).toBe("● Linked");
          const cursor = app.page.getByRole("checkbox", { name: "demo for Cursor" });
          expect(await cursor.isChecked()).toBe(true);
          expect(await summary(app)).toBe("3 done, 0 already done, 0 drifted, 0 failed, 0 skipped");
          expect(await app.timing("apply", { after: applied })).toBeGreaterThan(0);
          await oneSnapshotSince(app, applied);
          expect(await readlink(join(home, ".cursor/skills/demo"))).toBe(
            join(home, ".gandalf/skills/demo"),
          );
          expect(cellOf(await cliCells(home, "demo"), "cursor")).toEqual({
            agent: "cursor",
            enabled: true,
            verdict: "ok",
          });
        });

        const cli = await gandalfCli(cliHome, ["skills", "enable", "demo", "--agent", "cursor"]);
        expect(cli.code).toBe(0);
        const listed = async (at: string) => {
          const skills = (await gandalfCli(at, ["skills", "list"])).json as readonly object[];
          const unseeded = skills.map((skill) => ({ ...skill, installedAt: "seeded" }));
          return JSON.stringify(unseeded).replaceAll(at, "~");
        };
        expect(await listed(home)).toBe(await listed(cliHome));
      });
    });
  });

  it("removes demo from Claude Code and shows the cell Off", async () => {
    await withHome("twoAgents", (home) =>
      withApp({ home }, async (app) => {
        await app.countLine();
        const sheet = await app.toggleCell("demo", "Claude Code");
        expect(await sheet.getByRole("heading", { level: 2 }).textContent()).toBe(
          "Turn off demo for Claude Code",
        );
        expect(await rowTexts(sheet)).toEqual([
          "− Remove | ~/.claude/skills/demo | Remove demo from Claude Code",
          "◐ Save | ~/.gandalf/state.json | Save demo as off for all agents",
        ]);
        await app.applySheet();
        await expect.poll(() => app.cellStatus("demo", "Claude Code")).toBe("· Off");
        expect(await exists(join(home, ".claude/skills/demo"))).toBe(false);
        expect(cellOf(await cliCells(home, "demo"), "claude_code")).toMatchObject({
          enabled: false,
          verdict: "off",
        });
      }),
    );
  });

  it("fits Move to Trash in the word column when it trashes gandalf's copy", async () => {
    await withHome("twoAgents", async (home) => {
      const copy = await gandalfCli(home, ["agents", "configure", "claude_code", "--mode", "copy"]);
      expect(copy.code).toBe(0);
      await withApp({ home }, async (app) => {
        await app.countLine();
        const sheet = await app.toggleCell("demo", "Claude Code");
        expect(await rowTexts(sheet)).toContainEqual(
          "− Move to Trash | ~/.claude/skills/demo | Move gandalf's copy of demo in Claude Code to the Trash",
        );
        const words = await sheet
          .getByRole("listitem")
          .evaluateAll((items) =>
            items.map((item) => [
              item.firstElementChild?.scrollWidth,
              item.firstElementChild?.clientWidth,
            ]),
          );
        for (const [scroll, client] of words) expect(scroll).toBeLessThanOrEqual(client ?? 0);
      });
    });
  });

  it("toggles with Space, cancels with Escape without writing, and applies with Enter", async () => {
    await withHome("twoAgents", (home) =>
      withApp({ home }, async (app) => {
        const { page } = app;
        await app.countLine();
        const before = await listTree(home);
        await page.keyboard.press("Tab");
        await page.keyboard.press("Tab");
        const focused = () =>
          page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
        expect(await focused()).toBe("demo for Cursor");
        await page.keyboard.press("ArrowRight");
        expect(await focused()).toBe("demo for Claude Code");
        await page.keyboard.press("ArrowLeft");

        await page.keyboard.press("Space");
        await app.sheet().waitFor();
        await page.keyboard.press("Escape");
        await app.sheet().waitFor({ state: "hidden" });
        expect(await listTree(home)).toEqual(before);
        expect(await focused()).toBe("demo for Cursor");

        await page.keyboard.press("Space");
        await app.sheet().waitFor();
        await page.keyboard.press("Enter");
        await app.sheet().waitFor({ state: "hidden" });
        await expect.poll(() => app.cellStatus("demo", "Cursor")).toBe("● Linked");
      }),
    );
  });
});

describe("moving through the matrix with the keyboard", () => {
  it("moves between rows with the arrows and leaves the grid with one Tab", async () => {
    await withHome("realShaped", (home) =>
      withApp({ home }, async (app) => {
        const { page } = app;
        await app.countLine();
        const focused = () =>
          page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? null);
        const column = await page
          .getByRole("checkbox", { name: / for Cursor$/ })
          .evaluateAll((boxes) => boxes.map((box) => box.getAttribute("aria-label") ?? ""));
        expect(column.length).toBeGreaterThanOrEqual(3);
        await page.getByRole("checkbox", { name: column[0], exact: true }).focus();
        await page.keyboard.press("ArrowDown");
        expect(await focused()).toBe(column[1]);
        await page.keyboard.press("ArrowDown");
        expect(await focused()).toBe(column[2]);
        await page.keyboard.press("ArrowUp");
        expect(await focused()).toBe(column[1]);

        await page.keyboard.press("Tab");
        expect(
          await page.evaluate(() => document.activeElement?.closest("[role=grid]") ?? null),
        ).toBeNull();
        await page.keyboard.press("Shift+Tab");
        expect(await focused()).toBe(column[1]);
      }),
    );
  });
});

describe("applying a preview the disk no longer matches", () => {
  it("shows the fresh plan with a stale banner and writes nothing until Apply again", async () => {
    await withHome("twoAgents", (home) =>
      withApp({ home }, async (app) => {
        await app.countLine();
        const unplaced = await app.page.evaluate(() => window.gandalf.snapshot());
        const sheet = await app.toggleCell("demo", "Cursor");
        const placed = join(home, ".cursor/skills/demo");
        await mkdir(placed, { recursive: true });
        await writeFile(join(placed, "SKILL.md"), "---\nname: demo\ndescription: mine\n---\n");
        const placedBefore = await listTree(placed);
        const before = await listTree(home);
        await expect.poll(() => app.cellStatus("demo", "Cursor")).toBe("? Not managed");
        await app.settle();
        await app.pushSnapshot(unplaced);
        expect(await app.cellStatus("demo", "Cursor")).toBe("· Off");

        const applied = app.mark();
        await sheet.getByRole("button", { name: "Apply" }).click();
        const notice = sheet.getByRole("status");
        await expect
          .poll(() => notice.textContent())
          .toContain("Disk changed since the preview. Nothing was written.");
        expect(await notice.textContent()).toContain("Click Apply to apply it, or Cancel.");
        await oneSnapshotSince(app, applied);
        expect(await app.cellStatus("demo", "Cursor")).toBe("? Not managed");
        expect(await listTree(home)).toEqual(before);
        expect(await rowTexts(sheet)).toContainEqual(expect.stringMatching(/^✗ Conflict \| /));
        expect(await rowTexts(sheet)).not.toContainEqual(expect.stringContaining("Link demo"));

        await app.applySheet();
        await expect.poll(() => app.cellStatus("demo", "Cursor")).toBe("✗ Conflict");
        expect(await listTree(placed)).toEqual(placedBefore);
        expect(cellOf(await cliCells(home, "demo"), "cursor")).toMatchObject({
          enabled: true,
          verdict: "conflict",
        });
      }),
    );
  });

  it("does not apply the fresh plan while Enter is held down", async () => {
    await withHome("twoAgents", (home) =>
      withApp({ home }, async (app) => {
        const { page } = app;
        await app.countLine();
        const sheet = await app.toggleCell("demo", "Cursor");
        const placed = join(home, ".cursor/skills/demo");
        await mkdir(placed, { recursive: true });
        await writeFile(join(placed, "SKILL.md"), "---\nname: demo\ndescription: mine\n---\n");
        const before = await listTree(home);

        const held = app.mark();
        await page.keyboard.down("Enter");
        await expect
          .poll(() => sheet.getByRole("status").textContent())
          .toContain("Disk changed since the preview.");
        expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Apply");
        for (let repeat = 0; repeat < 5; repeat += 1) {
          await page.keyboard.down("Enter");
          await delay(50);
        }
        await page.keyboard.up("Enter");
        await delay(SETTLE_MS);

        expect(app.timings("apply", { after: held })).toHaveLength(1);
        expect(await sheet.isVisible()).toBe(true);
        expect(await sheet.getByRole("button", { name: "Apply" }).isEnabled()).toBe(true);
        expect(await rowTexts(sheet)).toContainEqual(expect.stringMatching(/^✗ Conflict \| /));
        expect(await listTree(home)).toEqual(before);
      }),
    );
  });

  it("disables Apply when the fresh plan leaves only things it cannot do", async () => {
    await withHome("conflict", (home) =>
      withApp({ home }, async (app) => {
        await app.countLine();
        const sheet = await app.toggleCell("demo", "Cursor");
        const cli = await gandalfCli(home, ["skills", "enable", "demo", "--agent", "cursor"]);
        expect(cli.code).toBe(0);
        await sheet.getByRole("button", { name: "Apply" }).click();
        await expect
          .poll(() => sheet.getByRole("status").textContent())
          .toContain("Disk changed since the preview.");
        const notice = (await sheet.getByRole("status").textContent()) ?? "";
        expect(notice).toContain("Nothing in it can be applied. Click Cancel to close it.");
        expect(notice).not.toContain("Click Apply");
        expect(await sheet.getByRole("region", { name: "Not doing" }).isVisible()).toBe(true);
        expect(await sheet.getByRole("listitem").count()).toBe(1);
        expect(await sheet.getByRole("button", { name: "Apply" }).isDisabled()).toBe(true);
        expect(await app.page.evaluate(() => document.activeElement?.textContent)).toBe("Cancel");
        await app.page.keyboard.press("Enter");
        await sheet.waitFor({ state: "hidden" });
        await syncSettled(app, "Nothing to sync · 1 conflict");
        expect(await app.syncButton().isDisabled()).toBe(true);
      }),
    );
  });

  it("says the change no longer applies when the skill was removed meanwhile", async () => {
    await withHome("twoAgents", (home) =>
      withApp({ home }, async (app) => {
        await app.countLine();
        const kept = await app.page.evaluate(() => window.gandalf.snapshot());
        const sheet = await app.toggleCell("demo", "Cursor");
        expect((await gandalfCli(home, ["skills", "remove", "demo"])).code).toBe(0);
        const before = await listTree(home);
        await expect.poll(() => app.page.getByRole("rowheader").count()).toBe(0);
        await app.settle();
        await app.pushSnapshot(kept);
        expect(await app.page.getByRole("rowheader").count()).toBe(1);
        const applied = app.mark();
        await sheet.getByRole("button", { name: "Apply" }).click();
        const banner = sheet.getByRole("alert");
        await banner.waitFor();
        expect(await banner.textContent()).toBe(
          [
            "✗",
            "Disk changed since the preview. Nothing was written.",
            "demo is not in the library.",
            "The change no longer applies. Close this to see the library now.",
          ].join(""),
        );
        expect(await listTree(home)).toEqual(before);
        await oneSnapshotSince(app, applied);
        await sheet.getByRole("button", { name: "Close" }).click();
        await sheet.waitFor({ state: "hidden" });
        expect(await app.page.getByRole("rowheader").count()).toBe(0);
        expect(await app.page.getByText("The library is empty.").isVisible()).toBe(true);
      }),
    );
  });
});

describe("a change the planner refuses", () => {
  it("reads the disk again, so Close shows the library as it is now", async () => {
    await withHome("twoAgents", (home) =>
      withApp({ home }, async (app) => {
        await app.countLine();
        const before = await app.page.evaluate(() => window.gandalf.snapshot());
        expect((await gandalfCli(home, ["skills", "remove", "demo"])).code).toBe(0);
        await expect.poll(() => app.page.getByRole("rowheader").count()).toBe(0);
        await app.pushSnapshot(before);
        expect(await app.page.getByRole("rowheader").count()).toBe(1);
        await app.settle();
        const clicked = app.mark();
        const sheet = await app.toggleCell("demo", "Cursor");
        const banner = sheet.getByRole("alert");
        await banner.waitFor();
        expect(await banner.textContent()).toBe(
          [
            "✗",
            "gandalf cannot plan this change",
            "demo is not in the library.",
            "Nothing was written. Close this to see the library now.",
          ].join(""),
        );
        await oneSnapshotSince(app, clicked);
        await sheet.getByRole("button", { name: "Close" }).click();
        await sheet.waitFor({ state: "hidden" });
        expect(await app.page.getByRole("rowheader").count()).toBe(0);
        expect(await app.page.getByText("The library is empty.").isVisible()).toBe(true);
      }),
    );
  });
});

describe("an apply with a step that cannot write", () => {
  it("names the step in the sheet's words and says what to do, without core's codes", async () => {
    await withHome("twoAgents", async (home) => {
      await chmod(join(home, ".cursor"), 0o555);
      try {
        await withApp({ home }, async (app) => {
          await app.countLine();
          await app.toggleCell("demo", "Cursor");
          await app.applySheet();
          expect(await summary(app)).toBe("1 done, 0 already done, 0 drifted, 1 failed, 1 skipped");
          const list = app.page.getByRole("list", { name: "Did not finish" });
          expect(await list.getByRole("listitem").allInnerTexts()).toEqual([
            "Create the skills folder for Cursor did not finish. gandalf has no permission to write to ~/.cursor/skills. Check its permissions in Finder, then click Sync.",
            "Link demo into Cursor did not happen, because “Create the skills folder for Cursor” did not finish. Click Sync to see what is left.",
          ]);
          const text = await list.innerText();
          for (const word of ["Failed:", "Skipped:", "EACCES", "io:", "step 2", home]) {
            expect(text).not.toContain(word);
          }
          expect(await exists(join(home, ".cursor/skills"))).toBe(false);
        });
      } finally {
        await chmod(join(home, ".cursor"), 0o755);
      }
    });
  });
});

describe("applying while another gandalf holds the lock", () => {
  it("reports the holder and its start time, writes nothing, and goes back on Cancel", async () => {
    await withHome("twoAgents", (home) =>
      withApp({ home }, async (app) => {
        await app.countLine();
        const since = new Date(Math.floor(Date.now() / 1000) * 1000 - 120_000);
        const release = await holdLock(home, { since });
        try {
          const before = await listTree(home);
          const sheet = await app.toggleCell("demo", "Cursor");
          await app.settle();
          const applied = app.mark();
          await sheet.getByRole("button", { name: "Apply" }).click();
          const notice = sheet.getByRole("status");
          await expect.poll(() => notice.textContent()).toContain("Another gandalf");
          const time = new Intl.DateTimeFormat("en-US", {
            dateStyle: "medium",
            timeStyle: "medium",
          }).format(since);
          expect(await notice.textContent()).toBe(
            [
              "◐",
              "Another gandalf is applying changes",
              `Process ${process.pid} has been applying since ${time}.`,
              "Nothing was written. Try again when it finishes.",
            ].join(""),
          );
          await oneSnapshotSince(app, applied);
          expect(await listTree(home)).toEqual(before);
          await sheet.getByRole("button", { name: "Cancel" }).click();
          await sheet.waitFor({ state: "hidden" });
          expect(await app.cellStatus("demo", "Cursor")).toBe("· Off");
        } finally {
          await release();
        }
        await app.toggleCell("demo", "Cursor");
        await app.applySheet();
        await expect.poll(() => app.cellStatus("demo", "Cursor")).toBe("● Linked");
      }),
    );
  });

  it("applies on Try Again once the other gandalf lets go", async () => {
    await withHome("twoAgents", (home) =>
      withApp({ home }, async (app) => {
        await app.countLine();
        const release = await holdLock(home);
        const sheet = await app.toggleCell("demo", "Cursor");
        await sheet.getByRole("button", { name: "Apply" }).click();
        const again = sheet.getByRole("button", { name: "Try Again" });
        await again.waitFor();
        expect(await app.page.evaluate(() => document.activeElement?.textContent)).toBe(
          "Try Again",
        );
        await release();
        await again.click();
        await sheet.waitFor({ state: "hidden" });
        await expect.poll(() => app.cellStatus("demo", "Cursor")).toBe("● Linked");
        expect(await summary(app)).toBe("3 done, 0 already done, 0 drifted, 0 failed, 0 skipped");
      }),
    );
  });
});

describe("an apply that fails over IPC", () => {
  it("shows the error with Close, and the matrix shows the disk as it is", async () => {
    await withHome("twoAgents", (home) =>
      withApp({ home }, async (app) => {
        await app.countLine();
        const sheet = await app.toggleCell("demo", "Cursor");
        await app.electron.evaluate(({ ipcMain }) => ipcMain.removeHandler("gandalf:apply"));
        expect(
          (await gandalfCli(home, ["skills", "enable", "demo", "--agent", "cursor"])).code,
        ).toBe(0);
        await expect.poll(() => app.cellStatus("demo", "Cursor")).toBe("● Linked");
        await app.settle();
        const applied = app.mark();
        await sheet.getByRole("button", { name: "Apply" }).click();
        const banner = sheet.getByRole("alert");
        await banner.waitFor();
        expect(await banner.innerText()).toContain("gandalf hit an unexpected error");
        expect(await sheet.getByRole("button").allInnerTexts()).toEqual(["Close"]);
        await delay(SETTLE_MS);
        expect(app.timings("snapshot", { after: applied })).toHaveLength(0);
        expect(await app.cellStatus("demo", "Cursor")).toBe("● Linked");
        await sheet.getByRole("button", { name: "Close" }).click();
        await sheet.waitFor({ state: "hidden" });
      }),
    );
  });
});

describe("enabling a skill whose name a folder you placed already uses", () => {
  it("lists the conflict as not done and leaves your folder byte-identical", async () => {
    await withHome("conflict", (home) =>
      withApp({ home }, async (app) => {
        await app.countLine();
        const placed = join(home, ".cursor/skills/demo");
        const before = await listTree(placed);
        const sheet = await app.toggleCell("demo", "Cursor");
        const notDoing = sheet.getByRole("region", { name: "Not doing" });
        expect(await rowTexts(notDoing)).toEqual([
          "✗ Conflict | ~/.cursor/skills/demo | A skill you placed there uses this name. gandalf never replaces it. Rename or move it, then Sync.",
        ]);
        await app.applySheet();
        await expect.poll(() => app.cellStatus("demo", "Cursor")).toBe("✗ Conflict");
        expect(await listTree(placed)).toEqual(before);
      }),
    );
  });
});

describe("showing paths in the preview", () => {
  it("keeps the last segment of both sides of a link whole on realShaped", async () => {
    await withHome("realShaped", (home) =>
      withApp({ home }, async (app) => {
        await app.countLine();
        const sheet = await app.toggleCell("deploy-preview", "Codex");
        const path = sheet
          .getByRole("listitem")
          .filter({ hasText: "Link deploy-preview into Codex" })
          .locator("[title]");
        expect(await path.getAttribute("title")).toBe(
          "~/.codex/skills/deploy-preview → ~/.gandalf/skills/deploy-preview",
        );
        const layout = await path.evaluate((element) => {
          const box = element.getBoundingClientRect();
          const parts = [...element.children].map((child) => {
            const part = child.getBoundingClientRect();
            return {
              text: child.textContent,
              whole: child.scrollWidth <= child.clientWidth,
              inside: part.left >= box.left - 0.5 && part.right <= box.right + 0.5,
            };
          });
          return { fits: element.scrollWidth <= element.clientWidth, parts };
        });
        expect(layout.fits).toBe(true);
        const lasts = layout.parts.filter((part) => part.text === "deploy-preview");
        expect(lasts).toHaveLength(2);
        for (const last of lasts) expect(last).toMatchObject({ whole: true, inside: true });
      }),
    );
  });
});

describe("the toolbar Sync button", () => {
  it("puts back links removed by hand and then says there is nothing to sync", async () => {
    await withHome("twoAgents", async (home) => {
      await rm(join(home, ".claude/skills/demo"));
      await withApp({ home }, async (app) => {
        await app.countLine();
        await expect.poll(() => app.syncButton().isEnabled()).toBe(true);
        expect(await app.syncButton().textContent()).toBe("Sync");
        expect(await toolbarStatus(app)).toBe("1 skill in 2 agents");
        await app.syncButton().click();
        const sheet = app.sheet();
        await sheet.waitFor();
        expect(await sheet.getByRole("heading", { level: 2 }).textContent()).toBe(
          "Sync all skills",
        );
        expect(await rowTexts(sheet)).toContainEqual(
          expect.stringContaining("Link demo into Claude Code"),
        );
        await watchToolbarStatus(app);
        await app.applySheet();
        expect(await summary(app)).toBe("1 done, 0 already done, 0 drifted, 0 failed, 0 skipped");
        expect(await readlink(join(home, ".claude/skills/demo"))).toBe(
          join(home, ".gandalf/skills/demo"),
        );
        await syncSettled(app, "Nothing to sync");
        await delay(SETTLE_MS);
        expect(await toolbarStatusChanges(app)).toEqual(["1 skill in 2 agents · Nothing to sync"]);
        expect(await app.syncButton().textContent()).toBe("Sync");
        expect(await app.syncButton().isDisabled()).toBe(true);
        expect(await app.page.getByText("Nothing to do").count()).toBe(0);
      });
    });
  });
});

describe("planning a sync for the toolbar", () => {
  it("keeps the last reason while it plans again after an apply", async () => {
    await withHome("twoAgents", (home) =>
      withApp({ home }, async (app) => {
        await app.countLine();
        await syncSettled(app, "Nothing to sync");
        await watchToolbarStatus(app);
        await app.toggleCell("demo", "Cursor");
        const applied = app.mark();
        await app.applySheet();
        await summary(app);
        await app.timing("plan", { after: applied });
        await delay(SETTLE_MS);
        expect(await toolbarStatusChanges(app)).toEqual([]);
        expect(await toolbarStatus(app)).toBe("1 skill in 2 agents · Nothing to sync");
      }),
    );
  });

  it("plans again only when a pushed snapshot changes what is on disk", async () => {
    await withHome("twoAgents", (home) =>
      withApp({ home }, async (app) => {
        await app.countLine();
        await syncSettled(app, "Nothing to sync");
        const same = await app.page.evaluate(() => window.gandalf.snapshot());
        const pushed = app.mark();
        await app.pushSnapshot(same);
        await delay(SETTLE_MS);
        expect(app.timings("plan", { after: pushed })).toHaveLength(0);

        await rm(join(home, ".claude/skills/demo"));
        const changed = await app.page.evaluate(() => window.gandalf.snapshot());
        await app.pushSnapshot(changed);
        await app.timing("plan", { after: pushed });
        await expect.poll(() => app.syncButton().isEnabled()).toBe(true);
        expect(await toolbarStatus(app)).toBe("1 skill in 2 agents");
      }),
    );
  });
});

describe("the IPC boundary", () => {
  it("answers a forged payload with badInput and writes nothing", async () => {
    await withHome("twoAgents", (home) =>
      withApp({ home }, async (app) => {
        await app.countLine();
        const before = await listTree(home);
        const forged = await app.page.evaluate(() =>
          Promise.all([
            window.gandalf.apply({ intent: { kind: "remove", skill: "../x" }, fingerprint: "x" }),
            window.gandalf.plan({ kind: "remove", skill: "../x" }),
          ]),
        );
        expect(forged).toEqual([
          {
            ok: false,
            error: {
              kind: "badInput",
              field: "fingerprint",
              message: "fingerprint: must be sha256:<64 hex>",
            },
          },
          {
            ok: false,
            error: { kind: "badInput", field: "skill", message: 'skill: not a skill name: "../x"' },
          },
        ]);
        expect(await listTree(home)).toEqual(before);
      }),
    );
  });

  it("refuses a call from a page that is not the app's own", async () => {
    await withHome("twoAgents", (home) =>
      withApp({ home }, async (app) => {
        await app.countLine();
        const other = join(home, "other.html");
        await writeFile(other, "<p>not gandalf</p>");
        const opened = app.electron.waitForEvent("window");
        await app.electron.evaluate(
          ({ BrowserWindow }, [preload, at, page]) => {
            const window = new BrowserWindow({
              show: false,
              webPreferences: {
                preload,
                sandbox: true,
                contextIsolation: true,
                additionalArguments: [`--gandalf-home=${at}`],
              },
            });
            void window.loadFile(page);
          },
          [PRELOAD, home, other] as const,
        );
        const page = await opened;
        await page.waitForLoadState();
        const answer = await page.evaluate(() =>
          window.gandalf.snapshot().then(
            () => "answered",
            (error: unknown) => (error instanceof Error ? error.message : String(error)),
          ),
        );
        expect(answer).toContain("gandalf:snapshot refused a caller outside gandalf");
        expect(await app.page.evaluate(() => window.gandalf.snapshot().then((r) => r.ok))).toBe(
          true,
        );
      }),
    );
  });

  it("gives the renderer the HOME main runs against", async () => {
    await withHome("empty", (home) =>
      withApp({ home }, async (app) => {
        expect(await app.page.evaluate(() => window.gandalf.home)).toBe(home);
      }),
    );
  });
});

describe("the selected row in dark", () => {
  it("puts everything in the row in the selection's text color", async () => {
    await withHome("twoAgents", (home) =>
      withApp({ home }, async (app) => {
        await app.countLine();
        await app.setTheme("dark");
        try {
          await app.page.getByRole("checkbox", { name: "demo for Cursor" }).focus();
          // A hidden window never gets focus; the matrix follows the window's focus events.
          await app.page.evaluate(() => window.dispatchEvent(new Event("focus")));
          const row = app.page.getByRole("row", { name: /^demo / });
          expect(await row.getAttribute("aria-selected")).toBe("true");
          const header = row.getByRole("rowheader");
          const glyphs = row.locator("span[aria-hidden=true]");
          const boxes = row.getByRole("checkbox");
          const description = header.locator("span span").nth(1);
          const colors = async (locator: Locator, property: string) =>
            Promise.all((await locator.all()).map((item) => style(item, property)));

          await expect.poll(() => style(header, "background-color")).toBe("rgb(204, 70, 48)");
          await expect
            .poll(() => colors(glyphs, "color"))
            .toEqual(["rgb(255, 255, 255)", "rgb(255, 255, 255)"]);
          await expect.poll(() => style(description, "color")).toBe("rgb(255, 255, 255)");
          await expect
            .poll(() => colors(boxes, "background-color"))
            .toEqual(["rgba(0, 0, 0, 0)", "rgba(0, 0, 0, 0)"]);
          await expect
            .poll(() => colors(boxes, "border-top-color"))
            .toEqual(["rgb(255, 255, 255)", "rgb(255, 255, 255)"]);
          expect(
            await row
              .locator("[title]")
              .evaluateAll((spans) => spans.map((span) => span.getAttribute("title"))),
          ).toEqual(["Off", "Linked"]);
          expect(await app.cellStatus("demo", "Cursor")).toBe("· Off");

          await app.page.keyboard.press("Space");
          await app.sheet().waitFor();
          expect(await row.getAttribute("data-selection")).toBe("inactive");
          await app.page.keyboard.press("Escape");
          await app.sheet().waitFor({ state: "hidden" });
          expect(await row.getAttribute("data-selection")).toBe("active");

          await app.page.evaluate(() => window.dispatchEvent(new Event("blur")));
          await expect.poll(() => style(header, "background-color")).toBe("rgb(70, 70, 72)");
          const label = "rgb(245, 245, 247)";
          await expect.poll(() => colors(glyphs, "color")).toEqual([label, label]);
          await expect.poll(() => style(description, "color")).toBe(label);
          await expect.poll(() => colors(boxes, "border-top-color")).toEqual([label, label]);
        } finally {
          await app.setTheme("light");
        }
      }),
    );
  });

  it("shows one coral selection, in the sidebar only while it has focus", async () => {
    await withHome("twoAgents", (home) =>
      withApp({ home }, async (app) => {
        await app.countLine();
        await app.page.evaluate(() => window.dispatchEvent(new Event("focus")));
        const library = app.page.getByRole("navigation").getByRole("button", { name: "Library" });
        const row = app.page.getByRole("row", { name: /^demo / });
        const coral = "rgb(204, 70, 48)";

        await app.page.getByRole("checkbox", { name: "demo for Cursor" }).focus();
        expect(await row.getAttribute("data-selection")).toBe("active");
        expect(await style(library, "background-color")).not.toBe(coral);

        await library.focus();
        await expect.poll(() => style(library, "background-color")).toBe(coral);
        expect(await row.getAttribute("data-selection")).toBe("inactive");
      }),
    );
  });
});

describe("a matrix wider than the window", () => {
  it("fades the edges toward hidden agent columns, from the Skill column out, without masking the scrollbars", async () => {
    await withHome("realShaped", (home) =>
      withApp({ home }, async (app) => {
        await app.countLine();
        const scroller = app.page.locator(".gd-scroll-edge");
        const sides = () =>
          scroller.evaluate((element) => [
            element.hasAttribute("data-hidden-left"),
            element.hasAttribute("data-hidden-right"),
          ]);
        expect(await sides()).toEqual([false, true]);
        expect((await style(scroller, "mask-image")).match(/linear-gradient/g)).toHaveLength(1);
        const skill = app.page.getByRole("rowheader").first();
        const before = await skill.boundingBox();

        /** Puts a checkbox under one fade, then shoots it and the Skill column with that side marked and not. */
        const fadeOf = async (side: "left" | "right") => {
          const strip = await scroller.evaluate((element, at) => {
            const view = element.getBoundingClientRect();
            const sticky = element.querySelector("tbody th")?.getBoundingClientRect();
            if (sticky === undefined) throw new Error("no sticky Skill column");
            const boxes = [...element.querySelectorAll("tbody tr:first-child input")];
            const box = boxes[Math.floor(boxes.length / 2)]?.getBoundingClientRect();
            if (box === undefined) throw new Error("no checkbox");
            const edge = at === "left" ? sticky.right : view.right;
            element.scrollLeft += at === "left" ? box.left - edge - 4 : box.right - edge + 4;
            return {
              x: at === "left" ? sticky.right : view.right - 20,
              y: view.top + 52,
              width: 20,
            };
          }, side);
          await delay(SETTLE_MS);
          const attribute = `data-hidden-${side}`;
          expect(
            await scroller.evaluate((element, name) => element.hasAttribute(name), attribute),
          ).toBe(true);
          const shoot = (clip: { x: number; y: number; width: number }) =>
            app.page.screenshot({ clip: { ...clip, height: 300 } });
          const stickyStrip = { x: (before?.x ?? 0) + 4, y: strip.y, width: 20 };
          const marked = [await shoot(strip), await shoot(stickyStrip)];
          await scroller.evaluate((element, name) => element.removeAttribute(name), attribute);
          const unmarked = [await shoot(strip), await shoot(stickyStrip)];
          await scroller.evaluate((element, name) => element.setAttribute(name, ""), attribute);
          return {
            edgeChanged: !marked[0]!.equals(unmarked[0]!),
            stickyChanged: !marked[1]!.equals(unmarked[1]!),
          };
        };

        expect(await fadeOf("right")).toEqual({ edgeChanged: true, stickyChanged: false });
        expect(await fadeOf("left")).toEqual({ edgeChanged: true, stickyChanged: false });
        expect((await skill.boundingBox())?.x).toBe(before?.x);
        await scroller.evaluate((element) => {
          element.scrollLeft = element.scrollWidth;
        });
        await expect.poll(sides).toEqual([true, false]);
      }),
    );
  });

  it("keeps the applied summary in the pane's visible width while the matrix scrolls", async () => {
    await withHome("realShaped", async (home) => {
      await chmod(join(home, ".codex"), 0o555);
      try {
        await withApp({ home }, async (app) => {
          await app.countLine();
          await app.toggleCell("pdf-tools", "Codex");
          await app.applySheet();
          await summary(app);
          expect(
            await app.page
              .getByRole("list", { name: "Did not finish" })
              .getByRole("listitem")
              .count(),
          ).toBeGreaterThan(0);
          const scroller = app.page.locator(".gd-scroll-edge");
          const region = app.page.locator("main").getByRole("status").filter({ hasText: SUMMARY });
          const scrollTo = async (end: boolean) => {
            await scroller.evaluate((element, toEnd) => {
              element.scrollLeft = toEnd ? element.scrollWidth : 0;
            }, end);
            await expect
              .poll(() =>
                scroller.evaluate((element) => [
                  element.hasAttribute("data-hidden-left"),
                  element.hasAttribute("data-hidden-right"),
                ]),
              )
              .toEqual([end, !end]);
          };
          const placement = async () => {
            const view = await scroller.evaluate((element) => {
              const box = element.getBoundingClientRect();
              const left = box.left + element.clientLeft;
              return { left, right: left + element.clientWidth };
            });
            const box = await region.boundingBox();
            if (box === null) throw new Error("the applied summary is not on screen");
            const overflows = await region.evaluate(
              (element) => element.scrollWidth > element.clientWidth,
            );
            return {
              left: box.x,
              width: box.width,
              inside: box.x >= view.left && box.x + box.width <= view.right,
              overflows,
            };
          };

          await scrollTo(false);
          const start = await placement();
          expect(start).toMatchObject({ inside: true, overflows: false });
          await scrollTo(true);
          expect(await placement()).toEqual(start);
        });
      } finally {
        await chmod(join(home, ".codex"), 0o755);
      }
    });
  });
});
