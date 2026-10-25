import { cp, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  nodeEnv,
  openGandalf,
  parseIntent,
  type AdoptPick,
  type AdoptVariant,
  type Plan,
} from "@gandalf/skills";
import { afterEach, describe, expect, it } from "vitest";
import { seedHome } from "../../../e2e/homes";
import { ignoredPicks, withPick } from "./adoptPick";

let home = "";

afterEach(async () => {
  if (home !== "") await rm(home, { recursive: true, force: true });
  home = "";
});

async function adoptPlan(pick: readonly AdoptPick[]): Promise<Plan> {
  const outcome = await openGandalf(nodeEnv({ home })).plan(
    parseIntent({ kind: "adopt", names: ["review"], pick }),
  );
  if (!outcome.ok) throw new Error(`expected a plan, got ${outcome.error.kind}`);
  return outcome.plan;
}

/** The two versions of review on adoptChoice: Claude Code's, then Cursor's. */
async function reviewVariants(): Promise<{ claude: AdoptVariant; cursor: AdoptVariant }> {
  home = await seedHome("adoptChoice");
  const [choice] = (await adoptPlan([])).notDone;
  if (choice?.kind !== "needsChoice") throw new Error("expected a version choice");
  const byRoot = (dir: string) => choice.variants.find((v) => v.at[0]?.root.endsWith(dir));
  const claude = byRoot("/.claude/skills");
  const cursor = byRoot("/.cursor/skills");
  if (claude === undefined || cursor === undefined) throw new Error("expected both variants");
  return { claude, cursor };
}

const pickOf = (variant: AdoptVariant): AdoptPick => ({
  name: "review" as AdoptPick["name"],
  kind: "hash",
  hash: variant.hash,
});

describe("ignoredPicks", () => {
  it("finds nothing when the plan adopts the version picked", async () => {
    const { cursor } = await reviewVariants();
    const plan = await adoptPlan([pickOf(cursor)]);
    expect(plan.steps.some((step) => step.kind === "adoptMove")).toBe(true);
    expect(ignoredPicks(plan)).toEqual([]);
  });

  it("names the version the core adopts when the picked copy was deleted first", async () => {
    const { claude, cursor } = await reviewVariants();
    await rm(join(home, ".cursor/skills/review"), { recursive: true });
    const plan = await adoptPlan([pickOf(cursor)]);
    // The core sees one version left and adopts it without asking.
    expect(plan.notDone).toEqual([]);
    expect(ignoredPicks(plan)).toEqual([
      { name: "review", picked: cursor.hash, adopted: claude.hash, from: claude.at[0] },
    ]);
    const accepted = withPick(plan.intent, {
      name: "review" as AdoptPick["name"],
      kind: "hash",
      hash: claude.hash,
    });
    expect(ignoredPicks(await adoptPlan(accepted.kind === "adopt" ? accepted.pick : []))).toEqual(
      [],
    );
  });

  it("names the library's version when the library took the name first", async () => {
    const { claude, cursor } = await reviewVariants();
    const first = await adoptPlan([pickOf(claude)]);
    await openGandalf(nodeEnv({ home })).apply(first);
    await rm(join(home, ".cursor/skills/review"), { recursive: true });
    await cp(join(home, ".gandalf/skills/review"), join(home, ".cursor/skills/review"), {
      recursive: true,
    });
    const plan = await adoptPlan([pickOf(cursor)]);
    expect(ignoredPicks(plan)).toEqual([
      { name: "review", picked: cursor.hash, adopted: claude.hash, from: null },
    ]);
  });
});
