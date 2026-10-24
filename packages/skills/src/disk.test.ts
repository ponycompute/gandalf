import { cp, mkdir, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { COPY_MARKER, classify, contentHash, observeRoot, serializeMarker } from "./disk.js";
import { nodeFs } from "./env.js";
import { at, link, tempHome, writeSkill, writeTree } from "./testkit.js";
import type { SkillName } from "./types.js";

const pdf = "pdf" as SkillName;

async function seed() {
  const home = await tempHome();
  const library = at(home, ".gandalf/skills");
  await writeSkill(`${library}/pdf`, "pdf", { "lib/tool.sh": "echo pdf\n" });
  const libraryHash = await contentHash(nodeFs, at(home, ".gandalf/skills/pdf"));
  const root = at(home, ".cursor/skills");
  await mkdir(root, { recursive: true });
  return { home, library, libraryHash, root, dirs: [library] };
}

describe("classify", () => {
  it("decides ownership from evidence on the entry only", async () => {
    const { library, libraryHash, root, dirs } = await seed();
    await link(`${library}/pdf`, `${root}/linked`);
    await link(`${library}/gone`, `${root}/dangling`);
    await link("/somewhere/else", `${root}/foreign`);
    await writeSkill(`${root}/mine`, "my-notes");
    await writeTree(root, { "readme.txt": "hi", "plain/notes.txt": "no skill here" });
    await cp(`${library}/pdf`, `${root}/copied`, { recursive: true });
    await writeFile(
      `${root}/copied/${COPY_MARKER}`,
      serializeMarker({ skill: pdf, hash: libraryHash }),
    );
    await cp(`${root}/copied`, `${root}/edited`, { recursive: true });
    await writeFile(`${root}/edited/SKILL.md`, "edited by the user");

    const observed = async (name: string) => classify(nodeFs, dirs, at(root, name));
    expect(await observed("nothing")).toEqual({ kind: "absent" });
    expect(await observed("linked")).toEqual({ kind: "link", skill: "pdf", resolves: true });
    expect(await observed("dangling")).toEqual({ kind: "link", skill: "gone", resolves: false });
    expect(await observed("foreign")).toEqual({
      kind: "foreignLink",
      target: "/somewhere/else",
      resolves: false,
    });
    expect(await observed("mine")).toMatchObject({ kind: "skillDir", declaredName: "my-notes" });
    expect(await observed("readme.txt")).toEqual({ kind: "other" });
    expect(await observed("plain")).toEqual({ kind: "other" });
    expect(await observed("copied")).toEqual({
      kind: "cleanCopy",
      skill: "pdf",
      hash: libraryHash,
    });
    expect(await observed("edited")).toMatchObject({ kind: "modifiedCopy", recorded: libraryHash });
  });

  it("treats a marker with a forged hash as a modified copy, never as owned", async () => {
    const { root, dirs } = await seed();
    await writeSkill(`${root}/fake`, "fake");
    await writeFile(
      `${root}/fake/${COPY_MARKER}`,
      serializeMarker({ skill: pdf, hash: `sha256:${"0".repeat(64)}` as never }),
    );
    expect(await classify(nodeFs, dirs, at(root, "fake"))).toMatchObject({ kind: "modifiedCopy" });
  });

  it("lists a root's non-dot children and treats a missing root as empty", async () => {
    const { home, root, dirs } = await seed();
    await writeSkill(`${root}/mine`, "mine");
    await writeTree(root, { ".hidden/SKILL.md": "x" });
    const listing = await observeRoot(nodeFs, dirs, root);
    expect(listing.ok && [...listing.entries.keys()]).toEqual(["mine"]);
    expect(await observeRoot(nodeFs, dirs, at(home, ".nope/skills"))).toEqual({
      ok: true,
      exists: false,
      entries: new Map(),
    });
  });
});

describe("contentHash", () => {
  it("is equal for identical trees and ignores the marker, .git and .DS_Store", async () => {
    const home = await tempHome();
    await writeSkill(`${home}/a`, "s", { "sub/x.txt": "x" });
    await writeSkill(`${home}/b`, "s", {
      "sub/x.txt": "x",
      [COPY_MARKER]: "{}",
      ".DS_Store": "junk",
      ".git/HEAD": "ref",
    });
    expect(await contentHash(nodeFs, at(home, "a"))).toBe(await contentHash(nodeFs, at(home, "b")));
  });

  it("changes with bytes, names, nested files and link targets", async () => {
    const home = await tempHome();
    const variants: Record<string, Record<string, string>> = {
      base: { "sub/x.txt": "x" },
      bytes: { "sub/x.txt": "y" },
      renamed: { "sub/y.txt": "x" },
      nested: { "sub/x.txt": "x", "sub/deeper/z.txt": "z" },
    };
    for (const [name, files] of Object.entries(variants))
      await writeSkill(`${home}/${name}`, "s", files);
    await writeSkill(`${home}/linked`, "s", { "sub/x.txt": "x" });
    await link("target-a", `${home}/linked/ref`);
    const hashes = await Promise.all(
      [...Object.keys(variants), "linked"].map((name) => contentHash(nodeFs, at(home, name))),
    );
    expect(new Set(hashes).size).toBe(hashes.length);
  });
});
