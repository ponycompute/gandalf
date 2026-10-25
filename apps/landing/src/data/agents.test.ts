import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveAgents } from "../../../../packages/skills/src/agents";
import type { AbsPath } from "../../../../packages/skills/src/types";
import { AGENTS } from "./agents";

const HOME = "/home" as AbsPath;

describe("the landing page's agent list", () => {
  it("names every agent in the registry with its default skills folder", () => {
    const { agents } = resolveAgents(
      {
        home: HOME,
        gandalfDir: `${HOME}/.gandalf` as AbsPath,
        installed: [],
        realpaths: new Map(),
      },
      {},
    );
    const registry = agents
      .map((agent) => ({
        id: agent.id,
        name: agent.displayName,
        dir: agent.skillsDir.replace(HOME, "~"),
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
    const page = AGENTS.map(({ id, name, dir }) => ({ id, name, dir })).sort((a, b) =>
      a.id.localeCompare(b.id),
    );
    expect(page).toEqual(registry);
  });

  it("has a logo file for every agent", () => {
    for (const agent of AGENTS) {
      expect(
        existsSync(join(import.meta.dirname, "../../public/agents", agent.logo)),
        agent.logo,
      ).toBe(true);
    }
  });
});
