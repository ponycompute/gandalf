import { accessSync, constants, statSync } from "node:fs";

/**
 * Where Homebrew installs git: Apple silicon first, then Intel. A terminal adds them to PATH in the
 * shell profile, but an app opened from Finder starts with only /usr/bin:/bin:/usr/sbin:/sbin.
 */
export const HOMEBREW_BINS = ["/opt/homebrew/bin", "/usr/local/bin"] as const;

/**
 * `path` with each Homebrew folder that exists and is missing put in front, in HOMEBREW_BINS order,
 * so a Finder launch runs the same git as the terminal. `exists` is asked only about those folders.
 * An unset PATH with nothing to add stays unset, since an empty PATH would mean something else.
 */
export function withHomebrew(
  path: string | undefined,
  exists: (dir: string) => boolean,
): string | undefined {
  const dirs = (path ?? "").split(":").filter((dir) => dir !== "");
  const missing = HOMEBREW_BINS.filter((dir) => !dirs.includes(dir) && exists(dir));
  if (path === undefined && missing.length === 0) return undefined;
  return [...missing, ...dirs].join(":");
}

/** The first executable named `command` in a PATH folder, as the shell would run it, or null. */
export function findOnPath(
  command: string,
  path: string,
  isExecutable: (file: string) => boolean,
): string | null {
  for (const dir of path.split(":")) {
    if (dir === "") continue;
    const file = `${dir}/${command}`;
    if (isExecutable(file)) return file;
  }
  return null;
}

export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function isExecutable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return statSync(file).isFile();
  } catch {
    return false;
  }
}
