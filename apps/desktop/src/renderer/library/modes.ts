import type { AgentId, Mode, SkillName, Snapshot } from "@gandalf/skills";

/** How each of a skill's ok agents has it, read from the entry in the agent's own folder. */
export type Modes = ReadonlyMap<string, Mode>;

const key = (skill: SkillName, agent: AgentId) => `${agent}/${skill}`;

export function modesOf(snapshot: Snapshot): Modes {
  const targets = new Map(snapshot.roots.map((root) => [root.path, root.targets]));
  const found = new Map<string, Mode>();
  for (const entry of snapshot.entries) {
    if (entry.verdict !== "ok") continue;
    for (const agent of targets.get(entry.root) ?? []) {
      found.set(key(entry.name, agent), entry.observed.kind === "cleanCopy" ? "copy" : "link");
    }
  }
  return found;
}

export function modeOf(modes: Modes, skill: SkillName, agent: AgentId): Mode | undefined {
  return modes.get(key(skill, agent));
}
