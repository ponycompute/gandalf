import { useEffect, useReducer } from "react";
import { invoke } from "../invoke";
import { IDLE, tokenOf, writeFlow, type Flow, type FlowEvent } from "./writeFlow";

/**
 * Runs the IPC call each state asks for and feeds its result back in. A plan that fails refreshes
 * the snapshot once, since a refused plan usually means the disk changed under the matrix. An apply
 * does not: main pushes a snapshot 100 ms after every apply that reaches it, whatever the outcome,
 * and an apply that never reached main wrote nothing. `refresh` must be stable, or the effect would
 * run again for the same state and send its call twice. A plan the flow left before it answered,
 * cancelled or replaced, is cancelled in main too, so a fetch that hangs does not run on.
 */
export function useWriteFlow(refresh: () => void): readonly [Flow, (event: FlowEvent) => void] {
  const [flow, dispatch] = useReducer(writeFlow, IDLE);
  useEffect(() => {
    let current = true;
    const send = (event: FlowEvent) => {
      if (current) dispatch(event);
    };
    switch (flow.kind) {
      case "planning":
      case "replanning": {
        let answered = false;
        void invoke(() => window.gandalf.plan(flow.intent)).then((result) => {
          answered = true;
          send({ kind: "planned", result });
          if (current && (!result.ok || !result.value.ok)) refresh();
        });
        return () => {
          current = false;
          if (!answered) void invoke(() => window.gandalf.cancelPlan());
        };
      }
      case "applying":
        void invoke(() => window.gandalf.apply(tokenOf(flow.plan))).then((result) =>
          send({ kind: "applied", result }),
        );
        break;
    }
    return () => {
      current = false;
    };
  }, [flow, refresh]);
  return [flow, dispatch];
}
