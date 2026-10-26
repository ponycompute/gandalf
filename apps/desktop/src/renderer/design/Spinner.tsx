/**
 * An indeterminate progress mark for work of unknown length, such as a git fetch. It appears after
 * 150 ms and turns without Reduce Motion; with it, it stays a still open ring. The control it sits
 * in carries the words, from the start.
 */
export function Spinner() {
  return (
    <span
      aria-hidden="true"
      className="gd-spinner inline-block size-3 flex-none rounded-full border-2 border-current border-t-transparent"
    />
  );
}
