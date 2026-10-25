import type { StepResult } from "@gandalf/skills";
import { gandalfDir, stepPath, stepSentence, tilde, type Names } from "../vocabulary";

type Failed = Extract<StepResult, { readonly status: "failed" }>;

/** A step that did not finish, in the sheet's words: the step's sentence, then what happened and what to do. */
export interface Unfinished {
  readonly step: string;
  readonly text: string;
}

interface Said {
  readonly what: string;
  readonly next: string;
}

const SYNC_AGAIN = "Click Sync to see what is left.";

const noPermission = (place: string): Said => ({
  what: `gandalf has no permission to write to ${place}.`,
  next: "Check its permissions in Finder, then click Sync.",
});

/** The errno codes a write can fail with that the user can do something specific about. */
const IO_CODE: Readonly<Record<string, (place: string) => Said>> = {
  EACCES: noPermission,
  EPERM: noPermission,
  ENOSPC: () => ({ what: "The disk is full.", next: "Free up space, then click Sync." }),
  EROFS: (place) => ({
    what: `${place} is on a disk that cannot be written to.`,
    next: "Make the disk writable, then click Sync.",
  }),
  EBUSY: (place) => ({
    what: `Another app is using ${place}.`,
    next: "Quit that app, then click Sync.",
  }),
};

const FAILED = {
  crossDevice: (place, _error, names) => ({
    what: `${place} is on a different disk from ${tilde(gandalfDir(names), names.home)}, and gandalf moves skills only within one disk.`,
    next: "Move it onto the same disk, then click Sync.",
  }),
  io: (place, error) =>
    IO_CODE[/^([A-Z]+):/.exec(error)?.[1] ?? ""]?.(place) ?? {
      what: `gandalf could not write to ${place}.`,
      next: "Click Sync to try again.",
    },
} as const satisfies Record<Failed["reason"], (place: string, error: string, names: Names) => Said>;

/**
 * What the summary says about each step that did not finish. Results come in apply order, which is
 * not the sheet's order, so a skipped step names the step it waited on instead of a number.
 */
export function unfinished(results: readonly StepResult[], names: Names): readonly Unfinished[] {
  return results.flatMap((result) => {
    const step = stepSentence(result.step, names);
    const place = tilde(stepPath(result.step, names).path, names.home);
    switch (result.status) {
      case "done":
      case "alreadyDone":
        return [];
      case "drifted":
        return [
          {
            step,
            text: `did not happen. ${place} changed while gandalf was applying, so gandalf left it alone. ${SYNC_AGAIN}`,
          },
        ];
      case "failed": {
        const { what, next } = FAILED[result.reason](place, result.error, names);
        return [{ step, text: `did not finish. ${what} ${next}` }];
      }
      case "skipped": {
        const blocker = results[result.after]?.step;
        const because =
          blocker === undefined ? "an earlier step" : `“${stepSentence(blocker, names)}”`;
        return [{ step, text: `did not happen, because ${because} did not finish. ${SYNC_AGAIN}` }];
      }
    }
  });
}
