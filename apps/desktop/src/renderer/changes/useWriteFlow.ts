import { useEffect, useReducer } from "react";
import { invoke } from "../invoke";
import { IDLE, tokenOf, writeFlow, type Flow, type FlowEvent } from "./writeFlow";

/**
 * Runs the IPC call each state asks for and feeds its result back in. A plan that fails refreshes
 * the snapshot once, since a refused plan usually means the disk changed under the matrix. An apply
 * does not: main pushes a snapshot 100 ms after every apply that reaches it, whatever the outcome,
 * and an apply that never reached main wrote nothing. `refresh` must be stable, or the effect would
 * run again for the same state and send its call twice.
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
        void invoke(() => window.gandalf.plan(flow.intent)).then((result) => {
          send({ kind: "planned", result });
          if (!result.ok || !result.value.ok) refresh();
        });
        break;
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
