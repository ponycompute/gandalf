import { Spinner } from "../design/Spinner";

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

interface UpdateStatusProps {
  readonly checking: boolean;
  /** The skills from git or a folder, which a check looks at. */
  readonly checkable: number;
  readonly pending: number;
  /** Opens Update All. */
  readonly onOpen: () => void;
}

/**
 * The toolbar line's part about updates: that gandalf is checking, or how many skills have a newer
 * version, which opens Update All. Nothing while every skill is up to date.
 */
export function UpdateStatus({ checking, checkable, pending, onOpen }: UpdateStatusProps) {
  if (checking) {
    return (
      <span>
        {" · "}
        <span className="inline-flex items-center gap-1.5">
          <Spinner />
          Checking {plural(checkable, "skill")} for updates…
        </span>
      </span>
    );
  }
  if (pending === 0) return null;
  return (
    <span>
      {" · "}
      <button
        type="button"
        onClick={onOpen}
        className="no-drag text-accent hover:underline focus-visible:underline"
      >
        {plural(pending, "update")}
      </button>
    </span>
  );
}
