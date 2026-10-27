import { mkdir } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { gatherAgentFacts, resolveAgents, type AgentOverrides } from "./agents.js";
import { nodeFs } from "./env.js";
import { at, link, tempHome } from "./testkit.js";
import type { AbsPath } from "./types.js";

async function homeWith(dirs: readonly string[]): Promise<AbsPath> {
  const home = await tempHome();
  for (const dir of dirs) await mkdir(at(home, dir), { recursive: true });
  return home;
}

async function resolve(home: AbsPath, overrides: AgentOverrides = {}, extra: AbsPath[] = []) {
  const facts = await gatherAgentFacts(nodeFs, home, at(home, ".gandalf"), extra);
  return resolveAgents(facts, overrides);
}

describe("agents", () => {
  it("counts an agent as installed when its detect dir exists", async () => {
    const home = await homeWith([".cursor", ".config/opencode"]);
    const { agents, roots } = await resolve(home);
    expect(agents.filter((agent) => agent.installed).map((agent) => agent.id)).toEqual([
      "cursor",
      "opencode",
    ]);
    expect(agents).toHaveLength(14);
    expect(roots.map((root) => root.path)).toEqual([
      at(home, ".config/opencode/skills"),
      at(home, ".cursor/skills"),
    ]);
    expect(agents.find((agent) => agent.id === "cursor")).toMatchObject({ mode: "auto" });
  });

  it("counts an agent as installed when any of its detect dirs exists", async () => {
    const xdg = await resolve(await homeWith([".config/kilo"]));
    expect(xdg.agents.find((agent) => agent.id === "kilo_code")?.installed).toBe(true);
    const legacyOnly = await resolve(await homeWith([".kilocode/skills"]));
    expect(legacyOnly.agents.find((agent) => agent.id === "kilo_code")?.installed).toBe(false);
    expect(legacyOnly.roots).toEqual([]);
  });

  it("observes a retired skills dir as a target root that no agent writes to", async () => {
    const home = await homeWith([".gemini/antigravity/skills"]);
    const { roots } = await resolve(home);
    expect(roots).toEqual([
      {
        path: at(home, ".gemini/antigravity/skills"),
        role: "target",
        readers: ["antigravity"],
        targets: [],
      },
      {
        path: at(home, ".gemini/config/skills"),
        role: "target",
        readers: ["antigravity"],
        targets: ["antigravity"],
      },
      // .gemini exists, so Gemini CLI counts as installed too.
      {
        path: at(home, ".gemini/skills"),
        role: "target",
        readers: ["gemini_cli"],
        targets: ["gemini_cli"],
      },
    ]);
  });

  it("shares one scan root between agents that read the same dir", async () => {
    const home = await homeWith([".codex", ".copilot", ".agents/skills"]);
    const { roots } = await resolve(home);
    expect(roots.find((root) => root.path === at(home, ".agents/skills"))).toEqual({
      path: at(home, ".agents/skills"),
      role: "scan",
      readers: ["codex", "github_copilot"],
      targets: [],
    });
  });

  it("turns a shared dir into a target when an override points an agent at it", async () => {
    const home = await homeWith([".cursor", ".codex", ".copilot", ".agents/skills"]);
    const { roots, agents } = await resolve(home, {
      cursor: { skillsDir: at(home, ".agents/skills"), mode: "copy" },
    });
    expect(roots.find((root) => root.path === at(home, ".agents/skills"))).toMatchObject({
      role: "target",
      readers: ["cursor", "codex", "github_copilot"],
      targets: ["cursor"],
    });
    expect(agents.find((agent) => agent.id === "cursor")).toMatchObject({
      mode: "copy",
      overridden: true,
    });
  });

  it("deduplicates aliases of one dir by realpath", async () => {
    const home = await homeWith([".cursor/skills", ".claude"]);
    await link(at(home, ".cursor/skills"), at(home, ".claude/skills"));
    const { roots } = await resolve(home);
    expect(roots).toEqual([
      {
        path: at(home, ".cursor/skills"),
        role: "target",
        readers: ["cursor", "claude_code"],
        targets: ["cursor", "claude_code"],
      },
    ]);
  });

  it("never treats a dir inside ~/.gandalf as a root", async () => {
    const home = await homeWith([".cursor", ".gandalf/skills"]);
    const { roots, agents } = await resolve(home, {
      cursor: { skillsDir: at(home, ".gandalf/skills"), mode: null },
    });
    expect(roots).toEqual([]);
    expect(agents.find((agent) => agent.id === "cursor")).toMatchObject({ guarded: true });
  });

  it("guards an agent dir that is a symlink into ~/.gandalf", async () => {
    const home = await homeWith([".claude", ".gandalf/skills"]);
    await link(at(home, ".gandalf/skills"), at(home, ".claude/skills"));
    const { roots } = await resolve(home);
    expect(roots).toEqual([]);
  });
});
