import { watch } from "node:fs";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { withHome } from "./homes";
import { gandalfCli, withApp, type App } from "./lever";

const SETTLE_MS = 1000;
const IDLE_MS = 15_000;
const CHURN_MS = 10_000;
/** /dev is never on the temp dir's device, so the CLI probes in the folders it plans to write. */
const OTHER_DEVICE_TMPDIR = "/dev";
const PRELOAD = fileURLToPath(new URL("../out/preload/index.cjs", import.meta.url));

async function writeSkill(dir: string, skillMd: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), skillMd);
}

async function cli(home: string, ...args: string[]): Promise<void> {
  const result = await gandalfCli(home, args);
  expect(result.code, result.stderr).toBe(0);
}

/** Resolves with how long it took, from now, for the cell to read `status`. */
async function cellBecomes(app: App, skill: string, agent: string, status: string) {
  const start = Date.now();
  await expect
    .poll(() => app.cellStatus(skill, agent), { timeout: 5000, interval: 20 })
    .toBe(status);
  return Date.now() - start;
}

function snapshotsSince(app: App, mark: number): number {
  return app.timings("snapshot", { after: mark }).length;
}

function rowHeaders(app: App): Promise<string[]> {
  return app.page.getByRole("rowheader").allInnerTexts();
}

/** A temp folder beside the temp HOME, standing in for a folder outside HOME. */
async function withOutside<T>(work: (outside: string) => Promise<T>): Promise<T> {
  const outside = await realpath(await mkdtemp(join(tmpdir(), "gandalf-outside-")));
  try {
    return await work(outside);
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
}

/** Appends to each file in turn for `ms`, as an agent writing its own logs does. */
async function churn(files: readonly string[], ms: number): Promise<void> {
  for (const file of files) await mkdir(join(file, ".."), { recursive: true });
  const until = Date.now() + ms;
  for (let write = 0; Date.now() < until; write += 1) {
    await appendFile(files[write % files.length] ?? "", `${write}\n`);
    await delay(20);
  }
}

describe("refreshing when another program changes the disk", () => {
  it("flips the Cursor cell when the CLI enables and disables demo, without a click", async () => {
    await withHome("twoAgents", (home) =>
      withApp({ home }, async (app) => {
        await app.countLine();
        expect(await app.cellStatus("demo", "Cursor")).toBe("· Off");
        await cli(home, "skills", "enable", "demo", "--agent", "cursor");
        await cellBecomes(app, "demo", "Cursor", "● Linked");
        await cli(home, "skills", "disable", "demo", "--agent", "cursor");
        await cellBecomes(app, "demo", "Cursor", "· Off");
        expect(await app.page.getByRole("checkbox", { name: "demo for Cursor" }).isChecked()).toBe(
          false,
        );
      }),
    );
  });

  it("shows a folder you place by hand as Not managed within one second", async () => {
    await withHome("twoAgents", async (home) => {
      await cli(home, "skills", "disable", "demo", "--agent", "claude_code");
      await withApp({ home }, async (app) => {
        await app.countLine();
        expect(await app.cellStatus("demo", "Claude Code")).toBe("· Off");
        await mkdir(join(home, ".claude/skills/demo"));
        await writeFile(
          join(home, ".claude/skills/demo/SKILL.md"),
          "---\nname: demo\ndescription: mine\n---\n",
        );
        expect(await cellBecomes(app, "demo", "Claude Code", "? Not managed")).toBeLessThan(1000);
      });
    });
  });

  it("shows the new description after SKILL.md in the library is edited", async () => {
    await withHome("twoAgents", (home) =>
      withApp({ home }, async (app) => {
        await app.countLine();
        expect(await rowHeaders(app)).toEqual(["demo\nA demo skill"]);
        const skillMd = join(home, ".gandalf/skills/demo/SKILL.md");
        const before = await readFile(skillMd, "utf8");
        await writeFile(skillMd, before.replace("A demo skill", "A demo skill, edited"));
        await expect.poll(() => rowHeaders(app)).toEqual(["demo\nA demo skill, edited"]);
      }),
    );
  });

  it("shows the first skill installed into an empty HOME", async () => {
    await withHome("empty", (home) =>
      withApp({ home }, async (app) => {
        await app.page.getByText("The library is empty.").waitFor();
        await mkdir(join(home, "src/demo"), { recursive: true });
        await writeFile(
          join(home, "src/demo/SKILL.md"),
          "---\nname: demo\ndescription: A demo skill\n---\n",
        );
        await cli(home, "skills", "install", "src/demo");
        await expect.poll(() => rowHeaders(app)).toEqual(["demo\nA demo skill"]);
        expect(await app.countLine()).toBe("1 skill in 0 agents");
      }),
    );
  });

  it("adds a Codex column when ~/.codex appears", async () => {
    await withHome("twoAgents", (home) =>
      withApp({ home }, async (app) => {
        expect(await app.countLine()).toBe("1 skill in 2 agents");
        await mkdir(join(home, ".codex"));
        await expect
          .poll(() => app.page.getByRole("columnheader").allInnerTexts())
          .toEqual(["SKILL", "CURSOR", "CLAUDE CODE", "CODEX"]);
        expect(await app.countLine()).toBe("1 skill in 3 agents");
        expect(await app.cellStatus("demo", "Codex")).toBe("· Off");
      }),
    );
  });

  it("keeps refreshing after an agent's skills folder is deleted and created again", async () => {
    await withHome("twoAgents", (home) =>
      withApp({ home }, async (app) => {
        await app.countLine();
        expect(await app.cellStatus("demo", "Claude Code")).toBe("● Linked");
        const skills = join(home, ".claude/skills");
        await rm(skills, { recursive: true });
        await cellBecomes(app, "demo", "Claude Code", "○ Will add");
        await mkdir(skills);
        await app.settle();
        await symlink(join(home, ".gandalf/skills/demo"), join(skills, "demo"));
        await cellBecomes(app, "demo", "Claude Code", "● Linked");

        await rm(skills, { recursive: true });
        await mkdir(skills);
        await app.settle();
        expect(await app.cellStatus("demo", "Claude Code")).toBe("○ Will add");
        await symlink(join(home, ".gandalf/skills/demo"), join(skills, "demo"));
        await cellBecomes(app, "demo", "Claude Code", "● Linked");
      }),
    );
  });

  it("shows the library again once a state.json that went corrupt is fixed", async () => {
    await withHome("twoAgents", (home) =>
      withApp({ home }, async (app) => {
        expect(await app.countLine()).toBe("1 skill in 2 agents");
        const state = join(home, ".gandalf/state.json");
        const good = await readFile(state, "utf8");
        await writeFile(state, "{ not json");
        const banner = app.page.getByRole("alert");
        await expect
          .poll(() => banner.textContent())
          .toContain("gandalf cannot read its state file");
        await writeFile(state, good);
        await banner.waitFor({ state: "hidden" });
        expect(await app.countLine()).toBe("1 skill in 2 agents");
      }),
    );
  });

  it("shows the library once a state.json corrupt at launch is fixed", async () => {
    await withHome("twoAgents", async (home) => {
      const state = join(home, ".gandalf/state.json");
      const good = await readFile(state, "utf8");
      await writeFile(state, "{ not json");
      await withApp({ home }, async (app) => {
        const banner = app.page.getByRole("alert");
        await expect
          .poll(() => banner.textContent())
          .toContain("gandalf cannot read its state file");
        await app.settle();
        await writeFile(state, good);
        expect(await app.countLine()).toBe("1 skill in 2 agents");
      });
    });
  });
});

describe("what the watcher does not refresh on", () => {
  it("reads no snapshot while the CLI plans syncs that probe for symlinks in watched folders", async () => {
    await withHome("twoAgents", async (home) => {
      await cli(home, "skills", "enable", "demo", "--agent", "cursor");
      await unlink(join(home, ".cursor/skills/demo"));
      await withApp({ home }, async (app) => {
        await app.countLine();
        await app.settle();
        const probes: string[] = [];
        const seen = watch(home, { recursive: true }, (_event, name) => {
          if (name?.includes(".gandalf-probe-") === true) probes.push(name);
        });
        try {
          const start = app.mark();
          const until = Date.now() + 10_000;
          let runs = 0;
          while (Date.now() < until) {
            const preview = await gandalfCli(home, ["skills", "sync", "--dry-run"], {
              tmpdir: OTHER_DEVICE_TMPDIR,
            });
            expect(preview.code, preview.stderr).toBe(0);
            runs += 1;
          }
          await delay(SETTLE_MS);
          expect(runs).toBeGreaterThan(5);
          expect(probes.length, "the CLI probed inside the temp HOME").toBeGreaterThan(0);
          expect(snapshotsSince(app, start)).toBe(0);
          expect(app.timings("plan", { after: start })).toHaveLength(0);
        } finally {
          seen.close();
        }
      });
    });
  });

  it("reads exactly one snapshot after this app applies, not one per write", async () => {
    await withHome("twoAgents", (home) =>
      withApp({ home }, async (app) => {
        await app.countLine();
        await app.toggleCell("demo", "Cursor");
        await app.settle();
        const applied = app.mark();
        await app.applySheet();
        await cellBecomes(app, "demo", "Cursor", "● Linked");
        await delay(SETTLE_MS);
        expect(app.timings("apply", { after: applied })).toHaveLength(1);
        expect(snapshotsSince(app, applied)).toBe(1);
      }),
    );
  });

  it("reads no snapshot and plans nothing while the disk stays the same", async () => {
    await withHome("realShaped", (home) =>
      withApp({ home }, async (app) => {
        await app.countLine();
        await app.settle();
        const idle = app.mark();
        await delay(IDLE_MS);
        expect(snapshotsSince(app, idle)).toBe(0);
        expect(app.timings("plan", { after: idle })).toHaveLength(0);
      }),
    );
  });

  it("reads no snapshot while files beside the folders it watches churn", async () => {
    await withHome("realShaped", (home) =>
      withApp({ home }, async (app) => {
        await app.countLine();
        await app.settle();
        const churning = app.mark();
        await churn(
          [
            join(home, "Library/Caches/app/blob.bin"),
            join(home, ".claude/projects/-tmp-work/session.jsonl"),
            join(home, ".claude/history.jsonl"),
            join(home, ".zsh_history"),
          ],
          CHURN_MS,
        );
        await delay(SETTLE_MS);
        expect(snapshotsSince(app, churning)).toBe(0);
        expect(app.timings("plan", { after: churning })).toHaveLength(0);
      }),
    );
  });
});

describe("folders moved out of HOME or behind symlinks", () => {
  it("reads no snapshot while Claude Code writes its own files after its skills dir moves", async () => {
    await withHome("twoAgents", async (home) => {
      await mkdir(join(home, "mine"));
      await cli(home, "agents", "configure", "claude_code", "--dir", join(home, "mine"));
      await withApp({ home }, async (app) => {
        await app.countLine();
        expect(await app.cellStatus("demo", "Claude Code")).toBe("● Linked");
        await app.settle();
        const churning = app.mark();
        await churn(
          [
            join(home, ".claude/projects/-tmp-work/session.jsonl"),
            join(home, ".claude/history.jsonl"),
          ],
          CHURN_MS / 2,
        );
        await delay(SETTLE_MS);
        expect(snapshotsSince(app, churning)).toBe(0);
        await unlink(join(home, "mine/demo"));
        await cellBecomes(app, "demo", "Claude Code", "○ Will add");
      });
    });
  });

  it("shows a library skill again after the folder its symlink leads to is deleted and recreated", async () => {
    await withHome("twoAgents", async (home) => {
      const code = join(home, "code/mine");
      const write = (description: string) =>
        writeSkill(code, `---\nname: mine\ndescription: ${description}\n---\n`);
      await write("Mine");
      await symlink(code, join(home, ".gandalf/skills/mine"));
      await withApp({ home }, async (app) => {
        await app.countLine();
        await expect.poll(() => rowHeaders(app)).toContain("mine\nMine");
        await rm(join(home, "code"), { recursive: true });
        await expect.poll(() => rowHeaders(app)).not.toContain("mine\nMine");
        await app.settle();
        await write("Mine, recreated");
        await expect.poll(() => rowHeaders(app)).toContain("mine\nMine, recreated");
      });
    });
  });

  it("keeps refreshing after a skills folder linked outside HOME is deleted and recreated", async () => {
    await withOutside((outside) =>
      withHome("twoAgents", async (home) => {
        const skills = join(home, ".claude/skills");
        const target = join(outside, "skills");
        const linkDemo = () => symlink(join(home, ".gandalf/skills/demo"), join(target, "demo"));
        await mkdir(target);
        await linkDemo();
        await rm(skills, { recursive: true });
        await symlink(target, skills);
        await withApp({ home }, async (app) => {
          await app.countLine();
          expect(await app.cellStatus("demo", "Claude Code")).toBe("● Linked");
          await rm(target, { recursive: true });
          await cellBecomes(app, "demo", "Claude Code", "○ Will add");
          await mkdir(target);
          await app.settle();
          await linkDemo();
          await cellBecomes(app, "demo", "Claude Code", "● Linked");
        });
      }),
    );
  });

  it("sees the missing folder a skills symlink was repointed to once it is created", async () => {
    await withHome("twoAgents", async (home) => {
      const skills = join(home, ".cursor/skills");
      const missing = join(home, "elsewhere/missing");
      await mkdir(join(home, "elsewhere/t1"), { recursive: true });
      await symlink(join(home, "elsewhere/t1"), skills);
      await withApp({ home }, async (app) => {
        await app.countLine();
        await unlink(skills);
        await symlink(missing, skills);
        await app.settle();
        expect(await app.cellStatus("demo", "Cursor")).toBe("· Off");
        await mkdir(missing);
        await app.settle();
        await symlink(join(home, ".gandalf/skills/demo"), join(missing, "demo"));
        await cellBecomes(app, "demo", "Cursor", "− Will remove");
      });
    });
  });
});

describe("an open preview when the disk changes", () => {
  it("says the preview may be out of date, and a stale Apply's banner wins over that", async () => {
    await withHome("twoAgents", (home) =>
      withApp({ home }, async (app) => {
        await app.countLine();
        const sheet = await app.toggleCell("demo", "Cursor");
        await app.settle();
        expect(await sheet.getByRole("status").textContent()).toBe("");
        await cli(home, "skills", "disable", "demo", "--agent", "claude_code");
        const notice = sheet.getByRole("status");
        await expect
          .poll(() => notice.textContent())
          .toBe(
            [
              "◐",
              "May be out of date",
              "The disk changed after gandalf made this preview. Apply checks it again and writes nothing if the plan no longer matches.",
            ].join(""),
          );
        expect(await sheet.getByRole("button", { name: "Apply" }).isEnabled()).toBe(true);

        await sheet.getByRole("button", { name: "Apply" }).click();
        await expect
          .poll(() => notice.textContent())
          .toContain("Disk changed since the preview. Nothing was written.");
        await cli(home, "skills", "enable", "demo", "--agent", "claude_code");
        await cellBecomes(app, "demo", "Claude Code", "● Linked");
        await delay(SETTLE_MS);
        expect(await notice.textContent()).toContain("Disk changed since the preview.");
        expect(await notice.textContent()).not.toContain("May be out of date");
        expect(await app.cellStatus("demo", "Cursor")).toBe("· Off");
      }),
    );
  });

  it("does not mark a preview planned after a change the window had not shown yet", async () => {
    await withHome("twoAgents", (home) =>
      withApp({ home }, async (app) => {
        await app.countLine();
        const before = await app.page.evaluate(() => window.gandalf.snapshot());
        await cli(home, "skills", "disable", "demo", "--agent", "claude_code");
        await cellBecomes(app, "demo", "Claude Code", "· Off");
        await app.settle();
        await app.pushSnapshot(before);
        expect(await app.cellStatus("demo", "Claude Code")).toBe("● Linked");
        const sheet = await app.toggleCell("demo", "Cursor");
        const now = await app.page.evaluate(() => window.gandalf.snapshot());
        await app.pushSnapshot(now);
        await cellBecomes(app, "demo", "Claude Code", "· Off");
        await delay(SETTLE_MS);
        expect(await sheet.getByRole("status").textContent()).toBe("");
      }),
    );
  });

  it("does not mark the preview when a pushed snapshot shows the same disk", async () => {
    await withHome("twoAgents", (home) =>
      withApp({ home }, async (app) => {
        await app.countLine();
        const sheet = await app.toggleCell("demo", "Cursor");
        const same = await app.page.evaluate(() => window.gandalf.snapshot());
        await app.pushSnapshot(same);
        await delay(SETTLE_MS);
        expect(await sheet.getByRole("status").textContent()).toBe("");
      }),
    );
  });
});

describe("who hears about a change", () => {
  it("tells the app's own page, and not a window showing another page", async () => {
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
        await page.evaluate(() => {
          const heard: unknown[] = [];
          Object.assign(window, { heard });
          window.gandalf.onSnapshot((result) => heard.push(result));
        });
        await cli(home, "skills", "enable", "demo", "--agent", "cursor");
        await cellBecomes(app, "demo", "Cursor", "● Linked");
        await delay(SETTLE_MS);
        expect(
          await page.evaluate(() => (window as unknown as { heard: unknown[] }).heard),
        ).toEqual([]);
      }),
    );
  });
});
