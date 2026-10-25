import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AbsPath, AgentId, Revision, SkillName, Snapshot } from "@gandalf/skills";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Result } from "../shared/ipc";
import {
  DEBOUNCE_MS,
  MAX_WAIT_MS,
  nodeWatchFs,
  watchDisk,
  type DirIdentity,
  type WatchFs,
} from "./watch";

const HOME = "/h";
const CLAUDE = "/h/.claude";
const SKILLS = "/h/.claude/skills";
const GANDALF = "/h/.gandalf";
const LIBRARY = "/h/.gandalf/skills";

const OPENCODE_SKILLS = "/h/.config/opencode/skills";

function snapshotOf({
  roots = [SKILLS],
  skills = [] as readonly string[],
  claudeSkills = SKILLS,
} = {}): Snapshot {
  const path = (value: string) => value as AbsPath;
  const agent = (id: string, skillsDir: string, installed: boolean) => ({
    id: id as AgentId,
    displayName: id,
    installed,
    skillsDir: path(skillsDir),
    scanDirs: [],
    mode: "auto" as const,
    overridden: false,
    readError: null,
  });
  return {
    revision: 1 as Revision,
    libraryDir: path(LIBRARY),
    agents: [agent("claude_code", claudeSkills, true), agent("opencode", OPENCODE_SKILLS, false)],
    roots: roots.map((root) => ({
      path: path(root),
      role: "target" as const,
      readers: ["claude_code" as AgentId],
      targets: ["claude_code" as AgentId],
    })),
    skills: skills.map((dir) => ({
      name: dir.split("/").at(-1) as SkillName,
      description: null,
      dir: path(dir),
      hash: null,
      source: null,
      installedAt: null,
      cells: [],
      issues: [],
    })),
    entries: [],
    problems: [],
    watchPaths: [GANDALF, LIBRARY, ...roots, CLAUDE].map(path),
  };
}

interface FakeHandle {
  readonly dir: string;
  readonly recursive: boolean;
  readonly onEvent: (name: string | null) => void;
  readonly onError: () => void;
  closed: boolean;
  /** Its folder was deleted. A watch that outlives its folder is not relied on. */
  dead: boolean;
}

/**
 * Directories by path, each with an inode; a symlinked one also names its realpath. `links` are
 * symlinks whose target may be missing, by link path.
 */
function fakeDisk(dirs: Record<string, number | DirIdentity>) {
  const links = new Map<string, string>();
  const disk = new Map<string, DirIdentity>();
  const put = (path: string, at: number | DirIdentity) =>
    disk.set(path, typeof at === "number" ? { real: path, ino: at } : at);
  for (const [path, at] of Object.entries(dirs)) put(path, at);
  const handles: FakeHandle[] = [];
  const fs: WatchFs = {
    inspect: async (path) => disk.get(path) ?? null,
    children: async (dir) =>
      [...disk.keys(), ...links.keys()]
        .filter((path) => path.startsWith(`${dir}/`) && !path.slice(dir.length + 1).includes("/"))
        .map((path) => path.slice(dir.length + 1)),
    locate: async (path) => {
      const found = disk.get(path);
      if (found !== undefined) return found.real;
      for (const [link, target] of links) {
        if (path === link || path.startsWith(`${link}/`)) return target + path.slice(link.length);
      }
      return path;
    },
    watch: (dir, recursive, onEvent, onError) => {
      const handle: FakeHandle = { dir, recursive, onEvent, onError, closed: false, dead: false };
      handles.push(handle);
      return {
        close: () => {
          handle.closed = true;
        },
      };
    },
  };
  const open = () => handles.filter((handle) => !handle.closed && !handle.dead);
  return {
    fs,
    put,
    link: (path: string, target: string) => links.set(path, target),
    remove: (path: string) => {
      disk.delete(path);
      for (const handle of handles) if (handle.dir === path) handle.dead = true;
    },
    /** The open watches as "<dir> recursive|children", sorted. */
    watched: () =>
      open()
        .map((handle) => `${handle.dir} ${handle.recursive ? "recursive" : "children"}`)
        .sort(),
    /** Watches of deleted folders that were never closed. */
    leaked: () => handles.filter((handle) => handle.dead && !handle.closed).map(({ dir }) => dir),
    /** Fires a change named `name` on the open watch of `dir`. */
    change: (dir: string, name: string | null) => {
      const handle = open().find((candidate) => candidate.dir === dir);
      if (handle === undefined) throw new Error(`nothing watches ${dir}`);
      handle.onEvent(name);
    },
  };
}

const okRead = (snapshot: Snapshot): Result<Snapshot> => ({ ok: true, value: snapshot });
const STATE = `${GANDALF}/state.json`;
const corrupt: Result<Snapshot> = {
  ok: false,
  error: { kind: "stateCorrupt", path: STATE, reason: "not JSON" },
};

function setup(
  dirs: Record<string, number | DirIdentity>,
  initial: Snapshot | Result<Snapshot> = snapshotOf(),
) {
  const disk = fakeDisk(dirs);
  const asResult = (read: Snapshot | Result<Snapshot>) => ("ok" in read ? read : okRead(read));
  let next = asResult(initial);
  let gate: Promise<void> | null = null;
  const reads = { count: 0 };
  const pushed: Result<Snapshot>[] = [];
  const watcher = watchDisk({
    home: HOME,
    snapshot: async () => {
      reads.count += 1;
      const result = next;
      if (gate !== null) await gate;
      return result;
    },
    push: (result) => pushed.push(result),
    fs: disk.fs,
  });
  return {
    disk,
    watcher,
    reads,
    pushed,
    willRead: (read: Snapshot | Result<Snapshot>) => {
      next = asResult(read);
    },
    /** Holds every read from now until the returned function runs. */
    holdReads: () => {
      let release = () => {};
      gate = new Promise<void>((done) => {
        release = () => {
          gate = null;
          done();
        };
      });
      return release;
    },
    /** The renderer's first read and the read after its watches start. Counts start from here. */
    boot: async () => {
      await watcher.snapshot();
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
      reads.count = 0;
      pushed.length = 0;
    },
  };
}

const ALL = { [HOME]: 1, [CLAUDE]: 2, [SKILLS]: 3, [GANDALF]: 4, [LIBRARY]: 5 };

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("watchDisk", () => {
  it("watches the library and skills folders whole, and HOME and agent folders for children only", async () => {
    const { disk, boot } = setup(ALL);
    await boot();
    expect(disk.watched()).toEqual([
      "/h children",
      "/h/.claude children",
      "/h/.claude/skills recursive",
      "/h/.gandalf recursive",
    ]);
  });

  it("watches a folder that does not exist yet from its nearest existing parent", async () => {
    const { disk, boot } = setup(
      { [HOME]: 1, [CLAUDE]: 2, "/h/.config": 6 },
      snapshotOf({ roots: [] }),
    );
    await boot();
    expect(disk.watched()).toEqual(["/h children", "/h/.claude children", "/h/.config children"]);
  });

  it("never watches / for a symlink whose top-level folder is missing", async () => {
    const gone = `${LIBRARY}/gone`;
    const { disk, boot } = setup({ ...ALL, "/": 0 });
    disk.link(gone, "/nowhere/gone");
    await boot();
    expect(disk.watched()).not.toContain("/ children");
    expect(disk.watched()).toContain("/h/.gandalf recursive");
  });

  it("watches a library skill behind a symlink at its realpath", async () => {
    const linked = `${LIBRARY}/mine`;
    const { disk, boot } = setup(
      { ...ALL, [linked]: { real: "/src/mine", ino: 9 }, [`${LIBRARY}/kept`]: 8 },
      snapshotOf({ skills: [linked, `${LIBRARY}/kept`] }),
    );
    await boot();
    expect(disk.watched()).toContain("/src/mine recursive");
    expect(disk.watched()).not.toContain(`${LIBRARY}/kept recursive`);
  });

  it("watches an agent folder for its name only when its skills dir is moved out of it", async () => {
    const MINE = "/h/mine";
    const moved = snapshotOf({ roots: [MINE], claudeSkills: MINE });
    const { disk, reads, boot } = setup({ ...ALL, [MINE]: 6 }, moved);
    await boot();
    expect(disk.watched()).toEqual(["/h children", "/h/.gandalf recursive", "/h/mine recursive"]);
    disk.change(HOME, ".claude");
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(reads.count).toBe(1);
    expect(() => disk.change(CLAUDE, "projects/-tmp/session.jsonl")).toThrow("nothing watches");
  });

  it("sees the target of a library symlink deleted and created again", async () => {
    const linked = `${LIBRARY}/mine`;
    const CODE = "/h/code";
    const target = `${CODE}/mine`;
    const withMine = snapshotOf({ skills: [linked] });
    const { disk, reads, willRead, boot } = setup(
      { ...ALL, [CODE]: 20, [target]: 21, [linked]: { real: target, ino: 21 } },
      withMine,
    );
    disk.link(linked, target);
    await boot();
    expect(disk.watched()).toContain("/h/code children");

    disk.change(target, "SKILL.md");
    disk.remove(target);
    disk.remove(linked);
    willRead(snapshotOf());
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(reads.count).toBe(1);
    expect(disk.watched()).not.toContain("/h/code/mine recursive");

    disk.put(target, 22);
    disk.put(linked, { real: target, ino: 22 });
    willRead(withMine);
    disk.change(CODE, "mine");
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 3);
    expect(reads.count).toBe(3);
    expect(disk.watched()).toContain("/h/code/mine recursive");
  });

  it("sees a skills folder linked outside HOME deleted and created again", async () => {
    const OUT = "/elsewhere/out";
    const target = `${OUT}/skills`;
    const { disk, reads, willRead, boot } = setup({
      ...ALL,
      "/elsewhere": 40,
      [OUT]: 41,
      [target]: 42,
      [SKILLS]: { real: target, ino: 42 },
    });
    disk.link(SKILLS, target);
    await boot();
    expect(disk.watched()).toEqual(
      expect.arrayContaining(["/elsewhere children", "/elsewhere/out children"]),
    );

    disk.remove(target);
    disk.remove(SKILLS);
    willRead(snapshotOf({ roots: [] }));
    disk.change(OUT, "skills");
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(reads.count).toBe(1);

    disk.put(target, 43);
    disk.put(SKILLS, { real: target, ino: 43 });
    willRead(snapshotOf());
    disk.change(OUT, "skills");
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 3);
    expect(disk.watched()).toContain("/elsewhere/out/skills recursive");
  });

  it("sees the missing target of a skills symlink repointed while running get created", async () => {
    const ELSEWHERE = "/h/elsewhere";
    const first = `${ELSEWHERE}/t1`;
    const missing = `${ELSEWHERE}/missing`;
    const { disk, reads, willRead, boot } = setup({
      ...ALL,
      [ELSEWHERE]: 50,
      [first]: 51,
      [SKILLS]: { real: first, ino: 51 },
    });
    disk.link(SKILLS, first);
    await boot();

    disk.remove(SKILLS);
    disk.link(SKILLS, missing);
    willRead(snapshotOf({ roots: [] }));
    disk.change(CLAUDE, "skills");
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(reads.count).toBe(1);

    disk.put(missing, 52);
    disk.put(SKILLS, { real: missing, ino: 52 });
    willRead(snapshotOf());
    disk.change(ELSEWHERE, "missing");
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 3);
    expect(disk.watched()).toContain("/h/elsewhere/missing recursive");
    const before = reads.count;
    disk.change(missing, "demo");
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(reads.count).toBe(before + 1);
  });

  it("hears a folder whose configured path differs in case from the disk", async () => {
    const { disk, reads, boot } = setup(
      ALL,
      snapshotOf({ roots: [], claudeSkills: "/h/Mine/skills" }),
    );
    await boot();
    disk.change(HOME, "mine");
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(reads.count).toBe(1);
  });

  it("reads one snapshot for a burst of changes, 100 ms after the last", async () => {
    const { disk, reads, pushed, boot } = setup(ALL);
    await boot();
    for (let n = 0; n < 5; n += 1) {
      disk.change(SKILLS, `demo/file-${n}`);
      await vi.advanceTimersByTimeAsync(20);
    }
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS - 21);
    expect(reads.count).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(reads.count).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(reads.count).toBe(1);
    expect(pushed).toHaveLength(1);
  });

  it("reads once a second while a writer never pauses", async () => {
    const { disk, reads, boot } = setup(ALL);
    await boot();
    const writing = async (ms: number) => {
      for (let at = 0; at < ms; at += 50) {
        disk.change(SKILLS, "demo/log");
        await vi.advanceTimersByTimeAsync(50);
      }
    };
    await writing(MAX_WAIT_MS - 50);
    expect(reads.count).toBe(0);
    await writing(50);
    expect(reads.count).toBe(1);
    await writing(MAX_WAIT_MS * 2);
    expect(reads.count).toBe(3);
  });

  it("ignores gandalf's own symlink probes, even inside a recursive watch", async () => {
    const { disk, reads, boot } = setup(ALL);
    await boot();
    disk.change(SKILLS, ".gandalf-probe-1f2e");
    disk.change(SKILLS, "nested/.gandalf-probe-1f2e");
    disk.change(HOME, ".gandalf-probe-9a8b");
    await vi.advanceTimersByTimeAsync(1000);
    expect(reads.count).toBe(0);
    disk.change(SKILLS, "demo/SKILL.md");
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(reads.count).toBe(1);
  });

  it("ignores files beside the folders it watches for children", async () => {
    const { disk, reads, boot } = setup(ALL);
    await boot();
    disk.change(HOME, ".zsh_history");
    disk.change(HOME, "Library");
    disk.change(CLAUDE, "history.jsonl");
    disk.change(CLAUDE, "projects");
    await vi.advanceTimersByTimeAsync(1000);
    expect(reads.count).toBe(0);
    disk.change(CLAUDE, "skills");
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(reads.count).toBe(1);
    disk.change(HOME, ".config");
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(reads.count).toBe(2);
    disk.change(HOME, null);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(reads.count).toBe(3);
  });

  it("reads nothing while this app applies, then exactly one snapshot after", async () => {
    const { disk, watcher, reads, pushed, boot } = setup(ALL);
    await boot();
    let finish = () => {};
    const applying = watcher.applying(
      () =>
        new Promise<string>((done) => {
          finish = () => done("applied");
        }),
    );
    disk.change(SKILLS, "demo");
    await vi.advanceTimersByTimeAsync(10);
    disk.change(GANDALF, "state.json");
    await vi.advanceTimersByTimeAsync(MAX_WAIT_MS * 2);
    expect(reads.count).toBe(0);
    finish();
    expect(await applying).toBe("applied");
    await vi.advanceTimersByTimeAsync(15);
    disk.change(GANDALF, "lock");
    await vi.advanceTimersByTimeAsync(1000);
    expect(reads.count).toBe(1);
    expect(pushed).toHaveLength(1);
  });

  it("drops a read that an apply overlapped, and pushes only the one after the apply", async () => {
    const { disk, watcher, reads, pushed, willRead, holdReads, boot } = setup(ALL);
    await boot();
    const release = holdReads();
    willRead(snapshotOf({ skills: [`${LIBRARY}/half-written`] }));
    disk.change(SKILLS, "demo");
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(reads.count).toBe(1);
    let finish = () => {};
    const applying = watcher.applying(
      () =>
        new Promise<void>((done) => {
          finish = done;
        }),
    );
    release();
    await vi.advanceTimersByTimeAsync(1000);
    expect(pushed).toHaveLength(0);
    willRead(snapshotOf({ skills: [`${LIBRARY}/written`] }));
    finish();
    await applying;
    await vi.advanceTimersByTimeAsync(1000);
    expect(reads.count).toBe(2);
    expect(pushed).toEqual([okRead(snapshotOf({ skills: [`${LIBRARY}/written`] }))]);
  });

  it("reads once after an apply that throws", async () => {
    const { watcher, reads, boot } = setup(ALL);
    await boot();
    await expect(watcher.applying(() => Promise.reject(new Error("ipc")))).rejects.toThrow("ipc");
    await vi.advanceTimersByTimeAsync(1000);
    expect(reads.count).toBe(1);
  });

  it("reads again when the disk changes during a read", async () => {
    const { disk, reads, holdReads, boot } = setup(ALL);
    await boot();
    const release = holdReads();
    disk.change(SKILLS, "a");
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(reads.count).toBe(1);
    disk.change(SKILLS, "b");
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 3);
    expect(reads.count).toBe(1);
    release();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(reads.count).toBe(2);
  });

  it("pushes a change made between the first read and the watches it starts", async () => {
    const { watcher, reads, pushed, willRead } = setup(ALL);
    const first = await watcher.snapshot();
    willRead(snapshotOf({ skills: [`${LIBRARY}/placed-meanwhile`] }));
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(first).toEqual(okRead(snapshotOf()));
    expect(reads.count).toBe(2);
    expect(pushed).toEqual([okRead(snapshotOf({ skills: [`${LIBRARY}/placed-meanwhile`] }))]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reads.count).toBe(2);
  });

  it("watches a skills folder again after it is deleted and created again", async () => {
    const { disk, reads, willRead, boot } = setup(ALL);
    await boot();

    disk.remove(SKILLS);
    willRead(snapshotOf({ roots: [] }));
    disk.change(CLAUDE, "skills");
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(disk.watched()).not.toContain("/h/.claude/skills recursive");
    expect(disk.leaked()).toEqual([]);

    disk.put(SKILLS, 30);
    willRead(snapshotOf());
    disk.change(CLAUDE, "skills");
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 3);
    expect(disk.watched()).toContain("/h/.claude/skills recursive");

    const before = reads.count;
    disk.change(SKILLS, "demo/SKILL.md");
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(reads.count).toBe(before + 1);
  });

  it("replaces the watch of a folder deleted and created again inside one burst", async () => {
    const { disk, reads, boot } = setup(ALL);
    await boot();
    disk.change(SKILLS, null);
    disk.remove(SKILLS);
    disk.put(SKILLS, 31);
    disk.change(CLAUDE, "skills");
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 3);
    expect(disk.leaked()).toEqual([]);
    const before = reads.count;
    disk.change(SKILLS, "demo/SKILL.md");
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(reads.count).toBe(before + 1);
    expect(disk.watched().filter((line) => line === "/h/.claude/skills recursive")).toHaveLength(1);
  });

  it("reads once more when a change makes it watch a new folder, to see writes it missed", async () => {
    const { disk, reads, willRead, boot } = setup(
      { [HOME]: 1, [CLAUDE]: 2 },
      snapshotOf({ roots: [] }),
    );
    await boot();
    disk.put(SKILLS, 3);
    willRead(snapshotOf());
    disk.change(CLAUDE, "skills");
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(reads.count).toBe(1);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(reads.count).toBe(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(reads.count).toBe(2);
  });

  it("reads only once after its own apply, even when that makes it watch a new folder", async () => {
    const { disk, watcher, reads, willRead, boot } = setup(
      { [HOME]: 1, [CLAUDE]: 2 },
      snapshotOf({ roots: [] }),
    );
    await boot();
    await watcher.applying(async () => {
      disk.put(SKILLS, 3);
      willRead(snapshotOf());
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(disk.watched()).toContain("/h/.claude/skills recursive");
    expect(reads.count).toBe(1);
  });

  it("keeps its watches through a failed read, so fixing state.json refreshes", async () => {
    const { disk, reads, pushed, willRead, boot } = setup(ALL);
    await boot();
    const watching = disk.watched();
    willRead(corrupt);
    disk.change(GANDALF, "state.json");
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(pushed).toEqual([corrupt]);
    expect(disk.watched()).toEqual(watching);
    willRead(snapshotOf());
    disk.change(GANDALF, "state.json");
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(reads.count).toBe(2);
    expect(pushed).toEqual([corrupt, okRead(snapshotOf())]);
  });

  it("watches the state file it cannot read at launch, so fixing it refreshes", async () => {
    const { disk, reads, pushed, willRead, boot } = setup(ALL, corrupt);
    await boot();
    expect(disk.watched()).toEqual(["/h children", "/h/.gandalf recursive"]);
    disk.change(HOME, ".zsh_history");
    await vi.advanceTimersByTimeAsync(1000);
    expect(reads.count).toBe(0);
    willRead(snapshotOf());
    disk.change(GANDALF, "state.json");
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(reads.count).toBe(1);
    expect(pushed).toEqual([okRead(snapshotOf())]);
    expect(disk.watched()).toContain("/h/.claude/skills recursive");
  });

  it("reads a failing snapshot no faster than the debounce allows, and not at all when idle", async () => {
    const { disk, reads, willRead, boot } = setup(ALL);
    await boot();
    willRead(corrupt);
    disk.change(GANDALF, "state.json");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reads.count).toBe(1);
    for (let at = 0; at < 3000; at += 10) {
      disk.change(GANDALF, "state.json");
      await vi.advanceTimersByTimeAsync(10);
    }
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reads.count).toBe(1 + 3000 / MAX_WAIT_MS);
  });

  it("reads nothing while the disk stays the same", async () => {
    const { reads, boot } = setup(ALL);
    await boot();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reads.count).toBe(0);
  });

  it("closes every watch and reads nothing after close", async () => {
    const { disk, watcher, reads, boot } = setup(ALL);
    await boot();
    disk.change(SKILLS, "demo");
    watcher.close();
    await vi.advanceTimersByTimeAsync(1000);
    expect(disk.watched()).toEqual([]);
    expect(reads.count).toBe(0);
  });
});

describe("nodeWatchFs.locate", () => {
  it("follows symlinks through to a missing tail, and stops on a loop", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "gandalf-locate-")));
    try {
      await mkdir(join(root, "real"));
      await symlink("real", join(root, "relative"));
      await symlink(join(root, "relative/gone/deeper"), join(root, "dangling"));
      await symlink("loop", join(root, "loop"));
      expect(await nodeWatchFs.locate(join(root, "relative"))).toBe(join(root, "real"));
      expect(await nodeWatchFs.locate(join(root, "dangling/skills"))).toBe(
        join(root, "real/gone/deeper/skills"),
      );
      expect(await nodeWatchFs.locate(join(root, "missing/skills"))).toBe(
        join(root, "missing/skills"),
      );
      expect(await nodeWatchFs.locate(join(root, "loop/x"))).toBe(join(root, "loop/x"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
