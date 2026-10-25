import { watch as fsWatch } from "node:fs";
import { lstat, readdir, readlink, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, sep } from "node:path";
import type { Snapshot } from "@gandalf/skills";
import type { Result } from "../shared/ipc";

export const DEBOUNCE_MS = 100;
/** A writer that never pauses still refreshes the window this often. */
export const MAX_WAIT_MS = 1000;
const PROBE_PREFIX = ".gandalf-probe-";
const GANDALF_DIR = ".gandalf";
const MAX_LINK_HOPS = 40;

/**
 * A directory to watch. A recursive watch counts every change under it. Any other counts only
 * changes to the direct children in `names`, or to every child when `names` is null.
 */
export interface WatchSpec {
  readonly path: string;
  readonly recursive: boolean;
  readonly names: ReadonlySet<string> | null;
}

/** An existing directory, by its realpath and the inode it had when looked at. */
export interface DirIdentity {
  readonly real: string;
  readonly ino: number;
}

export interface WatchHandle {
  close(): void;
}

export interface WatchFs {
  /** Null when nothing is there or it is not a directory. */
  inspect(path: string): Promise<DirIdentity | null>;
  /** Where `path` leads once every symlink in it is followed, through to a tail that is missing. */
  locate(path: string): Promise<string>;
  /** The names in a directory, or none when it cannot be read. */
  children(dir: string): Promise<readonly string[]>;
  /** May throw, as fs.watch does when the directory vanished since it was inspected. */
  watch(
    dir: string,
    recursive: boolean,
    onEvent: (name: string | null) => void,
    onError: () => void,
  ): WatchHandle;
}

export interface Timers {
  setTimeout(work: () => void, ms: number): unknown;
  clearTimeout(timer: unknown): void;
}

async function locate(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    // Something on the way is missing, so the links are followed by hand as far as they go.
  }
  let rest = path.split(sep).filter((part) => part !== "");
  let at: string = sep;
  let hops = 0;
  while (rest.length > 0) {
    const [part = "", ...tail] = rest;
    const next = join(at, part);
    let target: string | null;
    try {
      target = (await lstat(next)).isSymbolicLink() ? await readlink(next) : null;
    } catch {
      return join(next, ...tail);
    }
    if (target === null || ++hops > MAX_LINK_HOPS) {
      at = next;
      rest = tail;
      continue;
    }
    rest = [...(isAbsolute(target) ? target : join(at, target)).split(sep), ...tail].filter(
      (piece) => piece !== "",
    );
    at = sep;
  }
  return at;
}

export const nodeWatchFs: WatchFs = {
  inspect: async (path) => {
    try {
      const [info, real] = await Promise.all([stat(path), realpath(path)]);
      return info.isDirectory() ? { real, ino: info.ino } : null;
    } catch {
      return null;
    }
  },
  locate,
  children: (dir) => readdir(dir).catch(() => []),
  watch: (dir, recursive, onEvent, onError) => {
    const watcher = fsWatch(dir, { recursive }, (_event, name) => onEvent(name));
    watcher.on("error", onError);
    return watcher;
  },
};

function isInside(path: string, dir: string): boolean {
  return path === dir || path.startsWith(dir.endsWith(sep) ? dir : dir + sep);
}

const tree = (path: string): WatchSpec => ({ path, recursive: true, names: null });

/**
 * Each folder from `path` up to HOME watched in its parent for that one name. A path outside HOME
 * climbs no higher than its top-level folder, because a watch on / would hear every change on the
 * volume.
 */
function ancestry(homes: readonly string[], path: string): WatchSpec[] {
  const stop = homes.find((home) => isInside(path, home)) ?? sep + (path.split(sep)[1] ?? "");
  const specs: WatchSpec[] = [];
  for (let at = path; at !== stop && isInside(at, stop); at = dirname(at)) {
    specs.push({ path: dirname(at), recursive: false, names: new Set([basename(at)]) });
  }
  return specs;
}

/**
 * Everything whose change can change the next snapshot. The roots and gandalf's own folder are
 * watched whole. An agent's detect folder such as ~/.claude is not, because the core only checks
 * that it exists and the agent keeps busy files in it. Every folder that matters is also watched in
 * its parent for its own name, and so is the folder its symlinks lead to, so its appearing,
 * vanishing or pointing elsewhere is seen while unrelated files beside it are not. That covers
 * every entry in the library, since a symlink there whose target is missing is no skill yet. Library
 * skills are watched at their realpath, because writes behind a symlink fire no event on the link
 * side.
 */
async function watchSpecs(fs: WatchFs, home: string, snapshot: Snapshot): Promise<WatchSpec[]> {
  const roots = new Set<string>(snapshot.roots.map((root) => root.path));
  const whole = (path: string) => roots.has(path) || isInside(snapshot.libraryDir, path);
  const entries = await fs.children(snapshot.libraryDir);
  const subjects = new Set<string>([
    snapshot.libraryDir,
    ...snapshot.watchPaths,
    ...snapshot.agents.flatMap((agent) => [agent.skillsDir, ...agent.scanDirs]),
    ...entries.map((name) => join(snapshot.libraryDir, name)),
  ]);
  const [realHome = home, ...targets] = await Promise.all(
    [home, ...subjects].map((path) => fs.locate(path)),
  );
  return [
    ...snapshot.watchPaths.filter(whole).map(tree),
    ...snapshot.skills.map((skill) => tree(skill.dir)),
    ...[...subjects, ...targets].flatMap((path) => ancestry([home, realHome], path)),
  ];
}

/**
 * What to watch after a snapshot that failed: what the last good one named, or gandalf's own folder
 * before there was one, since only a fix there can end the error. The state file is added when the
 * error names it, so fixing it is seen.
 */
function fallbackSpecs(
  home: string,
  result: Extract<Result<Snapshot>, { ok: false }>,
  lastGood: readonly WatchSpec[] | null,
): readonly WatchSpec[] {
  const gandalfDir = join(home, GANDALF_DIR);
  const specs = [...(lastGood ?? [tree(gandalfDir), ...ancestry([home], gandalfDir)])];
  if (result.error.kind === "stateCorrupt") specs.push(...ancestry([home], result.error.path));
  return specs;
}

interface Watched extends DirIdentity {
  readonly recursive: boolean;
  readonly names: ReadonlySet<string> | null;
}

const keyOf = ({ real, ino, recursive }: Watched) => `${recursive ? "r" : "n"}:${ino}:${real}`;

/**
 * Names compare without case or Unicode form, because on a case-insensitive volume a configured path
 * may spell a folder differently from the events. A sibling that differs only so costs one read.
 */
const fold = (name: string) => name.normalize("NFC").toLowerCase();

/**
 * A path that does not exist yet is watched from its nearest existing parent, for its creation,
 * but never from /, so a missing top-level folder goes unwatched.
 */
async function resolve(fs: WatchFs, spec: WatchSpec): Promise<Watched | null> {
  let { path, recursive, names } = spec;
  for (;;) {
    const found = await fs.inspect(path);
    if (found !== null) {
      return { ...found, recursive, names: names && new Set([...names].map(fold)) };
    }
    const parent = dirname(path);
    if (parent === sep || parent === path) return null;
    names = new Set([basename(path)]);
    path = parent;
    recursive = false;
  }
}

function union(
  a: ReadonlySet<string> | null,
  b: ReadonlySet<string> | null,
): ReadonlySet<string> | null {
  return a === null || b === null ? null : new Set([...a, ...b]);
}

/** One watch per directory, minus each one a recursive watch on it or on a parent already covers. */
function uncovered(watched: readonly Watched[]): ReadonlyMap<string, Watched> {
  const merged = new Map<string, Watched>();
  for (const dir of watched) {
    const key = keyOf(dir);
    const seen = merged.get(key);
    merged.set(key, seen === undefined ? dir : { ...dir, names: union(seen.names, dir.names) });
  }
  const trees = watched.filter((dir) => dir.recursive);
  const keep = new Map<string, Watched>();
  for (const [key, dir] of merged) {
    const covered = trees.some(
      (tree) => isInside(dir.real, tree.real) && (tree.real !== dir.real || !dir.recursive),
    );
    if (!covered) keep.set(key, dir);
  }
  return keep;
}

/** Whether an event named `name`, relative to the watched dir, can change the snapshot. */
function counts(dir: Watched, name: string | null): boolean {
  if (name === null) return true;
  if (basename(name).startsWith(PROBE_PREFIX)) return false;
  return dir.recursive || dir.names === null || dir.names.has(fold(name.split(sep)[0] ?? name));
}

export interface DiskWatcherOptions {
  readonly home: string;
  readonly snapshot: () => Promise<Result<Snapshot>>;
  readonly push: (result: Result<Snapshot>) => void;
  readonly fs?: WatchFs;
  readonly timers?: Timers;
}

export interface DiskWatcher {
  /**
   * Reads a snapshot for a caller and watches what it names. When that adds watches, it reads once
   * more after the debounce and pushes it, for changes made before the new watches started.
   */
  snapshot(): Promise<Result<Snapshot>>;
  /** Runs this app's own apply without refreshing on its writes, then pushes one snapshot. */
  applying<T>(work: () => Promise<T>): Promise<T>;
  close(): void;
}

/**
 * Pushes a fresh snapshot 100 ms after the disk last changed, or 1 s after the first change of a
 * burst that does not pause. It never plans, because a plan may write probe links into the folders
 * it watches. The watch set follows each snapshot.
 */
export function watchDisk({
  home,
  snapshot,
  push,
  fs = nodeWatchFs,
  timers = globalThis,
}: DiskWatcherOptions): DiskWatcher {
  const handles = new Map<string, { readonly handle: WatchHandle; dir: Watched }>();
  let lastGood: readonly WatchSpec[] | null = null;
  let closed = false;
  let trailing: unknown = null;
  let deadline: unknown = null;
  let applies = 0;
  let applyRuns = 0;
  let afterApply = false;
  let reading = false;
  let changedWhileReading = false;
  let derived = 0;
  let installed = 0;

  const disarm = () => {
    if (trailing !== null) timers.clearTimeout(trailing);
    if (deadline !== null) timers.clearTimeout(deadline);
    trailing = null;
    deadline = null;
  };

  const arm = () => {
    if (closed || applies > 0) return;
    if (trailing !== null) timers.clearTimeout(trailing);
    trailing = timers.setTimeout(fire, DEBOUNCE_MS);
    deadline ??= timers.setTimeout(fire, MAX_WAIT_MS);
  };

  /** Resolves true when it started watching a directory it did not watch before. */
  const follow = async (result: Result<Snapshot>): Promise<boolean> => {
    const order = ++derived;
    const specs = result.ok
      ? await watchSpecs(fs, home, result.value)
      : fallbackSpecs(home, result, lastGood);
    const resolved = await Promise.all(specs.map((spec) => resolve(fs, spec)));
    if (closed || order < installed) return false;
    installed = order;
    if (result.ok) lastGood = specs;
    const wanted = uncovered(resolved.filter((dir) => dir !== null));
    for (const [key, { handle }] of handles) {
      if (wanted.has(key)) continue;
      handle.close();
      handles.delete(key);
    }
    let gained = false;
    for (const [key, dir] of wanted) {
      const current = handles.get(key);
      if (current !== undefined) {
        current.dir = dir;
        continue;
      }
      try {
        const handle = fs.watch(
          dir.real,
          dir.recursive,
          (name) => {
            const watched = handles.get(key);
            if (watched?.handle === handle && counts(watched.dir, name)) arm();
          },
          () => {
            handle.close();
            if (handles.get(key)?.handle === handle) handles.delete(key);
            arm();
          },
        );
        handles.set(key, { handle, dir });
        gained = true;
      } catch {
        // Gone since it was inspected, or not watchable. Skipped until a later snapshot names it.
      }
    }
    return gained;
  };

  async function fire(): Promise<void> {
    disarm();
    if (closed || applies > 0) return;
    if (reading) {
      changedWhileReading = true;
      return;
    }
    const fromEvents = !afterApply;
    afterApply = false;
    reading = true;
    changedWhileReading = false;
    const runs = applyRuns;
    const result = await snapshot();
    const torn = applyRuns !== runs;
    const gained = !torn && !closed && (await follow(result));
    reading = false;
    if (closed) return;
    if (torn) {
      // An apply ran during the read, so it may show half its writes. The read after it replaces it.
      if (changedWhileReading) arm();
      return;
    }
    push(result);
    // A folder this snapshot made us watch may have changed before its watch started.
    if (changedWhileReading || (fromEvents && gained)) arm();
  }

  return {
    snapshot: async () => {
      const result = await snapshot();
      void follow(result).then((gained) => {
        if (gained) arm();
      });
      return result;
    },
    applying: async (work) => {
      applies += 1;
      applyRuns += 1;
      disarm();
      try {
        return await work();
      } finally {
        applies -= 1;
        if (applies === 0) {
          afterApply = true;
          arm();
        }
      }
    },
    close: () => {
      closed = true;
      disarm();
      for (const { handle } of handles.values()) handle.close();
      handles.clear();
    },
  };
}
