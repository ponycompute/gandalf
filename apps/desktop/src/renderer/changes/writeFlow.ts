import type {
  ApplyOutcome,
  Intent,
  LockHolder,
  Plan,
  PlanError,
  PlanOutcome,
  PlanToken,
  StepResult,
} from "@gandalf/skills";
import type { AppError, Result } from "../../shared/ipc";

/** Why a write did not happen: the planner refused the intent, or the call itself failed. */
export type Failure =
  | { readonly kind: "refused"; readonly error: PlanError }
  | { readonly kind: "error"; readonly error: AppError };

export type Flow =
  | { readonly kind: "idle" }
  | { readonly kind: "planning"; readonly intent: Intent }
  /** `stale` marks a fresh plan that replaced the one the user approved. Nothing was written. */
  | { readonly kind: "previewing"; readonly plan: Plan; readonly stale: boolean }
  | { readonly kind: "applying"; readonly plan: Plan }
  | { readonly kind: "applied"; readonly plan: Plan; readonly results: readonly StepResult[] }
  | { readonly kind: "busy"; readonly plan: Plan; readonly holder: LockHolder }
  | {
      readonly kind: "failed";
      readonly intent: Intent;
      readonly failure: Failure;
      readonly stale: boolean;
    };

export type FlowEvent =
  | { readonly kind: "plan"; readonly intent: Intent }
  | { readonly kind: "planned"; readonly result: Result<PlanOutcome> }
  | { readonly kind: "apply" }
  | { readonly kind: "applied"; readonly result: Result<ApplyOutcome> }
  | { readonly kind: "cancel" };

export const IDLE: Flow = { kind: "idle" };

export function tokenOf(plan: Plan): PlanToken {
  return { intent: plan.intent, fingerprint: plan.fingerprint };
}

/** Returns `flow` itself for an event its state does not take, so callers can see it was ignored. */
export function writeFlow(flow: Flow, event: FlowEvent): Flow {
  switch (event.kind) {
    case "plan":
      return flow.kind === "idle" || flow.kind === "applied"
        ? { kind: "planning", intent: event.intent }
        : flow;
    case "planned":
      return flow.kind === "planning" ? fromPlan(flow.intent, event.result, false) : flow;
    case "apply":
      if (flow.kind === "busy") return { kind: "applying", plan: flow.plan };
      return flow.kind === "previewing" && flow.plan.steps.length > 0
        ? { kind: "applying", plan: flow.plan }
        : flow;
    case "applied":
      return flow.kind === "applying" ? fromApply(flow.plan, event.result) : flow;
    case "cancel":
      return flow.kind === "idle" || flow.kind === "planning" || flow.kind === "applying"
        ? flow
        : IDLE;
  }
}

function fromPlan(intent: Intent, result: Result<PlanOutcome>, stale: boolean): Flow {
  if (!result.ok)
    return { kind: "failed", intent, failure: { kind: "error", error: result.error }, stale };
  const outcome = result.value;
  return outcome.ok
    ? { kind: "previewing", plan: outcome.plan, stale }
    : { kind: "failed", intent, failure: { kind: "refused", error: outcome.error }, stale };
}

function fromApply(plan: Plan, result: Result<ApplyOutcome>): Flow {
  if (!result.ok) return fromPlan(plan.intent, { ok: false, error: result.error }, false);
  const outcome = result.value;
  switch (outcome.kind) {
    case "applied":
      return { kind: "applied", plan, results: outcome.results };
    case "stale":
      return fromPlan(plan.intent, { ok: true, value: outcome.fresh }, true);
    case "busy":
      return { kind: "busy", plan, holder: outcome.holder };
  }
}
