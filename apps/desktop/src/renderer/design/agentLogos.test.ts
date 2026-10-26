import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AGENTS } from "../../../../landing/src/data/agents";
import { LOGOS } from "./AgentLogo";

const DESKTOP = join(import.meta.dirname, "agents");
const LANDING = join(import.meta.dirname, "../../../../landing/public/agents");

describe("the app's agent marks", () => {
  it("are the landing page's marks, byte for byte", () => {
    const used = AGENTS.map((agent) => agent.logo).sort();
    expect(readdirSync(DESKTOP).sort()).toEqual(used);
    for (const logo of used) {
      const same = readFileSync(join(DESKTOP, logo)).equals(readFileSync(join(LANDING, logo)));
      expect(same, logo).toBe(true);
    }
  });

  it("give each agent the landing page's mark and ink", () => {
    const app = Object.entries(LOGOS).map(([id, logo]) => ({
      id,
      logo: logo.file,
      ink: logo.ink,
    }));
    const page = AGENTS.map(({ id, logo, ink }) => ({ id, logo, ink }));
    const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);
    expect(app.sort(byId)).toEqual(page.sort(byId));
  });
});
