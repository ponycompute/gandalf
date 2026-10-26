import type { KeyboardEvent, ReactNode } from "react";

export interface SourceItem<V extends string> {
  readonly id: V;
  readonly title: string;
  readonly icon: ReactNode;
}

interface SourceListProps<V extends string> {
  readonly items: readonly SourceItem<V>[];
  readonly current: V;
  readonly windowFocused: boolean;
  readonly onSelect: (id: V) => void;
  /** A button above the items, such as Settings' Back. */
  readonly before?: SourceAction;
  /** A heading between `before` and the items. */
  readonly heading?: string;
  /** A button pinned to the bottom of the sidebar, such as Settings. */
  readonly after?: SourceAction;
}

interface SourceAction {
  readonly title: string;
  readonly icon: ReactNode;
  readonly onClick: () => void;
}

function targetIndex(key: string, at: number, count: number): number | null {
  switch (key) {
    case "Home":
      return 0;
    case "End":
      return count - 1;
    case "ArrowDown":
      return (at + 1) % count;
    case "ArrowUp":
      return (at - 1 + count) % count;
    default:
      return null;
  }
}

function moveFocus(event: KeyboardEvent<HTMLElement>): void {
  const items = [...event.currentTarget.querySelectorAll("button")];
  const at = items.findIndex((item) => item === document.activeElement);
  const target = targetIndex(event.key, at, items.length);
  if (target === null) return;
  event.preventDefault();
  items[target]?.focus();
}

const ROW =
  "no-drag flex h-row-height items-center gap-2 rounded-md px-2 text-left motion-safe:transition-[color,background-color] motion-safe:duration-150 motion-safe:ease-out";

function ActionRow({ action }: { readonly action: SourceAction }) {
  return (
    <button type="button" tabIndex={-1} onClick={action.onClick} className={ROW}>
      {action.icon}
      <span className="min-w-0 flex-1 truncate">{action.title}</span>
    </button>
  );
}

export function SourceList<V extends string>({
  items,
  current,
  windowFocused,
  onSelect,
  before,
  heading,
  after,
}: SourceListProps<V>) {
  // Coral only while focus is in the sidebar, so the window shows one coral selection at a time.
  const selected = windowFocused
    ? "bg-glass-selection group-focus-within/sources:bg-accent-fill group-focus-within/sources:text-on-accent"
    : "bg-glass-selection";
  return (
    <nav
      id="gd-sidebar"
      aria-label="Sections"
      onKeyDown={moveFocus}
      className="group/sources gd-glass drag-region m-glass-inset flex w-sidebar-width min-w-[180px] flex-none flex-col gap-px rounded-lg p-2 pt-[44px]"
    >
      {before === undefined ? null : <ActionRow action={before} />}
      {heading === undefined ? null : (
        <h2 className="px-2 pt-3 pb-1 text-subheadline text-label-secondary">{heading}</h2>
      )}
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          aria-current={item.id === current ? "page" : undefined}
          tabIndex={item.id === current ? 0 : -1}
          onClick={() => onSelect(item.id)}
          className={`${ROW} ${item.id === current ? selected : ""}`}
        >
          {item.icon}
          <span className="min-w-0 flex-1 truncate">{item.title}</span>
        </button>
      ))}
      {after === undefined ? null : (
        <div className="mt-auto flex flex-col">
          <ActionRow action={after} />
        </div>
      )}
    </nav>
  );
}
