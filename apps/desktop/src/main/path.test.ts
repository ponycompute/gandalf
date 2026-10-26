import { describe, expect, it } from "vitest";
import { findOnPath, withHomebrew } from "./path";

/** An existence check that knows only `dirs`, so no case stats the real /opt/homebrew. */
function only(...dirs: string[]) {
  const asked: string[] = [];
  const exists = (dir: string) => {
    asked.push(dir);
    return dirs.includes(dir);
  };
  return { exists, asked };
}

describe("withHomebrew", () => {
  it("puts both Homebrew folders in front of a Finder launch's PATH when both exist", () => {
    const { exists } = only("/opt/homebrew/bin", "/usr/local/bin");
    expect(withHomebrew("/usr/bin:/bin:/usr/sbin:/sbin", exists)).toBe(
      "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    );
  });

  it("adds only the Homebrew folder that exists", () => {
    expect(withHomebrew("/usr/bin:/bin", only("/usr/local/bin").exists)).toBe(
      "/usr/local/bin:/usr/bin:/bin",
    );
    expect(withHomebrew("/usr/bin:/bin", only("/opt/homebrew/bin").exists)).toBe(
      "/opt/homebrew/bin:/usr/bin:/bin",
    );
  });

  it("leaves PATH as it is without Homebrew", () => {
    expect(withHomebrew("/usr/bin:/bin", only().exists)).toBe("/usr/bin:/bin");
  });

  it("keeps a Homebrew folder already on PATH where it is, and does not ask about it", () => {
    const { exists, asked } = only("/opt/homebrew/bin", "/usr/local/bin");
    expect(withHomebrew("/usr/bin:/opt/homebrew/bin:/bin", exists)).toBe(
      "/usr/local/bin:/usr/bin:/opt/homebrew/bin:/bin",
    );
    expect(asked).toEqual(["/usr/local/bin"]);
  });

  it("asks only about the Homebrew folders", () => {
    const { exists, asked } = only();
    withHomebrew("/usr/bin:/bin", exists);
    expect(asked).toEqual(["/opt/homebrew/bin", "/usr/local/bin"]);
  });

  it("builds a PATH from nothing when PATH is unset or empty", () => {
    expect(withHomebrew(undefined, only("/opt/homebrew/bin").exists)).toBe("/opt/homebrew/bin");
    expect(withHomebrew("", only().exists)).toBe("");
  });

  it("leaves an unset PATH unset when there is no Homebrew folder to add", () => {
    expect(withHomebrew(undefined, only().exists)).toBeUndefined();
  });

  it("drops empty segments, which would otherwise mean the current folder", () => {
    expect(withHomebrew("/usr/bin::/bin:", only().exists)).toBe("/usr/bin:/bin");
  });
});

describe("findOnPath", () => {
  it("returns the first folder's executable, as the shell picks it", () => {
    const executables = new Set(["/opt/homebrew/bin/git", "/usr/bin/git"]);
    const has = (file: string) => executables.has(file);
    expect(findOnPath("git", "/opt/homebrew/bin:/usr/bin", has)).toBe("/opt/homebrew/bin/git");
    expect(findOnPath("git", "/usr/bin:/opt/homebrew/bin", has)).toBe("/usr/bin/git");
  });

  it("returns null when no folder has it", () => {
    expect(findOnPath("git", "/usr/bin:/bin", () => false)).toBeNull();
    expect(findOnPath("git", "", () => true)).toBeNull();
  });
});
