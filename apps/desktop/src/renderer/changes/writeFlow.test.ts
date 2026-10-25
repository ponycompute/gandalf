import type {
  ApplyOutcome,
  Intent,
  LockHolder,
  Plan,
  PlanError,
  PlanOutcome,
  StepResult,
} from "@gandalf/skills";
import { describe, expect, it } from "vitest";
import type { AppError, Result } from "../../shared/ipc";
import { IDLE, tokenOf, writeFlow, type Flow, type FlowEvent } from "./writeFlow";

const intent = {
  kind: "setEnabled",
  skill: "demo",
  enabled: true,
  agents: ["cursor"],
} as unknown as Intent;

function planOf(fingerprint: string, steps: Plan["steps"] = [LINK]): Plan {
  return { intent, steps, notDone: [], fingerprint } as unknown as Plan;
}

const LINK = {
  kind: "link",
  slot: { root: "/h/.cursor/skills", name: "demo" },
  skill: "demo",
} as unknown as Plan["steps"][number];

const preview = planOf(`sha256:${"a".repeat(64)}`);
const fresh = planOf(`sha256:${"b".repeat(64)}`);
const holder = { pid: 4242, since: "2026-10-25T10:00:00.000Z" } as unknown as LockHolder;
const refusal = { kind: "unknownSkill", skill: "demo" } as unknown as PlanError;
const ipcError: AppError = { kind: "internal", message: "boom" };
const results = [{ step: LINK, status: "done" }] as unknown as readonly StepResult[];

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const BASIS = "disk the plan was made from";
const planned = (outcome: PlanOutcome): FlowEvent => ({
  kind: "planned",
  result: ok({ ...outcome, basis: BASIS }),
});
const appliedWith = (outcome: ApplyOutcome): FlowEvent => ({
  kind: "applied",
  result: ok(outcome),
});

const planning: Flow = { kind: "planning", intent };
const previewing: Flow = { kind: "previewing", plan: preview, stale: false, basis: BASIS };
const applying: Flow = { kind: "applying", plan: preview };
const applied: Flow = { kind: "applied", plan: preview, results };
const busy: Flow = { kind: "busy", plan: preview, holder };
const failed: Flow = {
  kind: "failed",
  intent,
  failure: { kind: "error", error: ipcError },
  stale: false,
};

describe("writeFlow", () => {
  it("plans a toggle from idle", () => {
    expect(writeFlow(IDLE, { kind: "plan", intent })).toEqual(planning);
  });

  it("plans the next toggle while the last apply's summary shows", () => {
    expect(writeFlow(applied, { kind: "plan", intent })).toEqual(planning);
  });

  it("previews a plan that planned", () => {
    expect(writeFlow(planning, planned({ ok: true, plan: preview }))).toEqual(previewing);
  });

  it("fails with the refusal when the planner refuses the intent", () => {
    expect(writeFlow(planning, planned({ ok: false, error: refusal }))).toEqual({
      kind: "failed",
      intent,
      failure: { kind: "refused", error: refusal },
      stale: false,
    });
  });

  it("fails with the app error when the plan call itself fails", () => {
    expect(
      writeFlow(planning, { kind: "planned", result: { ok: false, error: ipcError } }),
    ).toEqual(failed);
  });

  it("plans again from a preview with the intent the user chose", () => {
    const picked = { kind: "adopt", names: ["review"], pick: [] } as unknown as Intent;
    const replanning: Flow = { kind: "replanning", intent: picked, plan: preview };
    expect(writeFlow(previewing, { kind: "choose", intent: picked })).toEqual(replanning);
    expect(writeFlow(replanning, planned({ ok: true, plan: fresh }))).toEqual({
      kind: "previewing",
      plan: fresh,
      stale: false,
      basis: BASIS,
    });
    expect(writeFlow(replanning, { kind: "apply" })).toBe(replanning);
  });

  it("closes a preview that is planning again when cancelled, and drops the late answer", () => {
    const picked = { kind: "adopt", names: ["review"], pick: [] } as unknown as Intent;
    const replanning: Flow = { kind: "replanning", intent: picked, plan: preview };
    const cancelled = writeFlow(replanning, { kind: "cancel" });
    expect(cancelled).toEqual(IDLE);
    expect(writeFlow(cancelled, planned({ ok: true, plan: fresh }))).toBe(cancelled);
  });

  it("takes a choice only from an open preview", () => {
    for (const flow of [IDLE, planning, applying, applied, busy, failed]) {
      expect(writeFlow(flow, { kind: "choose", intent })).toBe(flow);
    }
  });

  it("applies a previewed plan", () => {
    expect(writeFlow(previewing, { kind: "apply" })).toEqual(applying);
  });

  it("never applies a plan with no steps", () => {
    const empty: Flow = { ...previewing, plan: planOf(preview.fingerprint, []) };
    expect(writeFlow(empty, { kind: "apply" })).toBe(empty);
  });

  it("shows the results of an apply", () => {
    expect(writeFlow(applying, appliedWith({ kind: "applied", results }))).toEqual(applied);
  });

  it("moves a stale apply straight to previewing the fresh plan, marked stale", () => {
    expect(
      writeFlow(applying, appliedWith({ kind: "stale", fresh: { ok: true, plan: fresh } })),
    ).toEqual({ kind: "previewing", plan: fresh, stale: true, basis: null });
  });

  it("fails with the refusal, marked stale, when the fresh plan is refused", () => {
    expect(
      writeFlow(applying, appliedWith({ kind: "stale", fresh: { ok: false, error: refusal } })),
    ).toEqual({
      kind: "failed",
      intent,
      failure: { kind: "refused", error: refusal },
      stale: true,
    });
  });

  it("reports the lock holder when another gandalf is applying", () => {
    expect(writeFlow(applying, appliedWith({ kind: "busy", holder }))).toEqual(busy);
  });

  it("fails with the app error when the apply call itself fails", () => {
    expect(
      writeFlow(applying, { kind: "applied", result: { ok: false, error: ipcError } }),
    ).toEqual(failed);
  });

  it("retries the same plan from busy", () => {
    expect(writeFlow(busy, { kind: "apply" })).toEqual(applying);
  });

  for (const from of [previewing, busy, failed, applied]) {
    it(`goes back to idle when ${from.kind} is cancelled`, () => {
      expect(writeFlow(from, { kind: "cancel" })).toEqual(IDLE);
    });
  }

  it("keeps a stale preview cancellable", () => {
    expect(writeFlow({ ...previewing, stale: true }, { kind: "cancel" })).toEqual(IDLE);
  });

  const ignored: readonly [Flow, FlowEvent][] = [
    [planning, { kind: "plan", intent }],
    [planning, { kind: "cancel" }],
    [previewing, { kind: "plan", intent }],
    [applying, { kind: "cancel" }],
    [applying, { kind: "apply" }],
    [applying, { kind: "plan", intent }],
    [IDLE, { kind: "apply" }],
    [IDLE, planned({ ok: true, plan: preview })],
    [previewing, appliedWith({ kind: "applied", results })],
    [busy, { kind: "plan", intent }],
    [failed, { kind: "apply" }],
  ];
  for (const [from, event] of ignored) {
    it(`ignores ${event.kind} while ${from.kind}`, () => {
      expect(writeFlow(from, event)).toBe(from);
    });
  }
});

describe("tokenOf", () => {
  it("sends back only the intent and the fingerprint", () => {
    expect(tokenOf(preview)).toEqual({ intent, fingerprint: preview.fingerprint });
    expect(Object.keys(tokenOf(preview)).sort()).toEqual(["fingerprint", "intent"]);
  });
});
