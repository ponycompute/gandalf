import { mkdir, rm } from "node:fs/promises";
import { openGandalf, type AbsPath } from "@gandalf/skills";
import { describe, expect, it } from "vitest";
import { run, tempHome, testEnv, writeSkill } from "../../../../../packages/skills/src/testkit";
import { SYNC_ALL, syncEnablement, type SyncReadiness } from "./syncReadiness";

/** Cursor and Claude Code installed, with demo and notes in the library and on for both. */
async function syncedHome() {
  const home = (await tempHome()) as AbsPath;
  await mkdir(`${home}/.cursor`, { recursive: true });
  await mkdir(`${home}/.claude`, { recursive: true });
  const env = testEnv(home);
  for (const name of ["demo", "notes"]) {
    await writeSkill(`${home}/src/${name}`, name);
    await run(env, {
      kind: "install",
      source: { kind: "local", path: `${home}/src/${name}` as AbsPath },
      agents: "all",
    });
  }
  const readiness = async (): Promise<SyncReadiness> => {
    const outcome = await openGandalf(env).plan(SYNC_ALL);
    return outcome.ok
      ? { kind: "planned", plan: outcome.plan }
      : { kind: "refused", error: outcome.error };
  };
  return { home, readiness };
}

describe("syncEnablement", () => {
  it("enables Sync when the plan has steps, with no reason", async () => {
    const { home, readiness } = await syncedHome();
    await rm(`${home}/.cursor/skills/demo`);
    expect(syncEnablement(await readiness())).toEqual({ enabled: true, reason: null });
  });

  it("says there is nothing to sync on a clean HOME", async () => {
    const { readiness } = await syncedHome();
    expect(syncEnablement(await readiness())).toEqual({
      enabled: false,
      reason: "Nothing to sync",
    });
  });

  it("counts what is left undone by status word when nothing can be synced", async () => {
    const { home, readiness } = await syncedHome();
    await rm(`${home}/.cursor/skills/demo`);
    await writeSkill(`${home}/.cursor/skills/demo`, "demo");
    await rm(`${home}/.gandalf/skills/notes`, { recursive: true });
    expect(syncEnablement(await readiness())).toEqual({
      enabled: false,
      reason: "Nothing to sync · 1 conflict · 1 blocked",
    });
  });

  it("disables Sync without a reason until the plan is known", () => {
    expect(syncEnablement({ kind: "unknown" })).toEqual({ enabled: false, reason: null });
  });

  it("says what to do when the plan cannot be made", () => {
    expect(
      syncEnablement({
        kind: "failed",
        error: { kind: "stateCorrupt", path: "/h/.gandalf/state.json", reason: "bad JSON" },
      }),
    ).toEqual({
      enabled: false,
      reason: "gandalf cannot read its state file. Fix it, then reopen gandalf",
    });
    expect(syncEnablement({ kind: "refused", error: { kind: "badSource", reason: "x" } })).toEqual({
      enabled: false,
      reason: "Sync is unavailable. Reopen gandalf to try again",
    });
  });
});
