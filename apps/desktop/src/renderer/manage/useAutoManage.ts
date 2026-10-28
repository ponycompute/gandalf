import { useEffect, useRef } from "react";
import type { Intent, Snapshot } from "@gandalf/skills";
import { contentKey } from "../../shared/ipc";
import { tokenOf } from "../changes/writeFlow";
import { invoke } from "../invoke";
import { adoptAllNames, manageModel } from "./model";

/** The adopt that takes every skill whose copies agree, or null when there is none to take. */
export function adoptAgreeing(snapshot: Snapshot): Intent | null {
  const names = adoptAllNames(manageModel(snapshot));
  return names.length === 0 ? null : { kind: "adopt", names, pick: [] };
}

/**
 * While `on`, a snapshot that shows skills gandalf can take without asking brings them into the
 * library, with no sheet: each moves in and is linked back where it was. Copies that differ wait
 * for the user. Each snapshot is tried once, so a plan that drifts waits for the disk to change, and
 * main's push after the apply shows the result. `idle` holds it off while the user's own write is
 * under way, so the two never race for the lock.
 */
export function useAutoManage(snapshot: Snapshot | null, on: boolean, idle: boolean): void {
  const tried = useRef<string | null>(null);
  const running = useRef(false);
  useEffect(() => {
    if (!on || !idle || snapshot === null || running.current) return;
    const intent = adoptAgreeing(snapshot);
    const key = contentKey(snapshot);
    if (intent === null || tried.current === key) return;
    tried.current = key;
    running.current = true;
    void (async () => {
      const planned = await invoke(() => window.gandalf.plan(intent));
      if (planned.ok && planned.value.ok && planned.value.plan.steps.length > 0) {
        const { plan } = planned.value;
        await invoke(() => window.gandalf.apply(tokenOf(plan)));
      }
      running.current = false;
    })();
  }, [snapshot, on, idle]);
}
