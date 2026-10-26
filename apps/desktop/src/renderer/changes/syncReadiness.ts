import { useEffect, useMemo, useState } from "react";
import type { Intent, Plan, PlanError, Snapshot } from "@gandalf/skills";
import { contentKey, type AppError } from "../../shared/ipc";
import { invoke } from "../invoke";
import { NOT_DONE } from "../vocabulary";

export const SYNC_ALL: Intent = { kind: "sync", skills: "all" };

export type SyncReadiness =
  | { readonly kind: "unknown" }
  | { readonly kind: "planned"; readonly plan: Plan }
  | { readonly kind: "refused"; readonly error: PlanError }
  | { readonly kind: "failed"; readonly error: AppError };

export interface SyncEnablement {
  readonly enabled: boolean;
  /** Why Sync is disabled, for the toolbar's count line. Null while enabled or not yet known. */
  readonly reason: string | null;
}

function counted(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

const REOPEN = "Sync is unavailable. Reopen gandalf to try again";

const FAILED = {
  stateCorrupt: "gandalf cannot read its state file. Fix it, then reopen gandalf",
  git: REOPEN,
  badInput: REOPEN,
  network: REOPEN,
  internal: REOPEN,
} as const satisfies Record<AppError["kind"], string>;

export function syncEnablement(readiness: SyncReadiness): SyncEnablement {
  switch (readiness.kind) {
    case "unknown":
      return { enabled: false, reason: null };
    case "refused":
      return { enabled: false, reason: REOPEN };
    case "failed":
      return { enabled: false, reason: FAILED[readiness.error.kind] };
    case "planned": {
      const { steps, notDone } = readiness.plan;
      if (steps.length > 0) return { enabled: true, reason: null };
      const conflicts = notDone.filter((item) => NOT_DONE[item.kind].verdict === "conflict");
      const blocked = notDone.length - conflicts.length;
      const parts = [
        "Nothing to sync",
        conflicts.length === 0 ? null : counted(conflicts.length, "conflict", "conflicts"),
        blocked === 0 ? null : `${blocked} blocked`,
      ];
      return { enabled: false, reason: parts.filter((part) => part !== null).join(" · ") };
    }
  }
}

/**
 * Plans a full sync whenever the snapshot's content changes, so the toolbar can say why Sync is
 * disabled. Planning writes probe symlinks into agent folders, so a pushed snapshot with the same
 * content must not plan again, or a folder watcher would loop. While a new plan is in flight the
 * last one stands, so the toolbar does not blink or announce twice.
 */
export function useSyncReadiness(snapshot: Snapshot | null): SyncReadiness {
  const key = useMemo(() => (snapshot === null ? null : contentKey(snapshot)), [snapshot]);
  const [planned, setPlanned] = useState<SyncReadiness>({ kind: "unknown" });
  useEffect(() => {
    if (key === null) return;
    let current = true;
    void invoke(() => window.gandalf.plan(SYNC_ALL)).then((result) => {
      if (!current) return;
      const value: SyncReadiness = !result.ok
        ? { kind: "failed", error: result.error }
        : result.value.ok
          ? { kind: "planned", plan: result.value.plan }
          : { kind: "refused", error: result.value.error };
      setPlanned(value);
    });
    return () => {
      current = false;
    };
  }, [key]);
  return key === null ? { kind: "unknown" } : planned;
}
