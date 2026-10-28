import type { KeyboardEvent, ReactNode } from "react";

export interface SourceItem<V extends string> {
  readonly id: V;
  readonly title: string;
  readonly icon: ReactNode;
}

/** A titled list of rows below the items, such as the projects, with a button that adds one. */
export interface SourceGroup {
  readonly heading: string;
  /** An icon button beside the heading; its title is the button's accessible name. */
  readonly add: SourceAction;
  readonly items: readonly SourceItem<string>[];
  readonly current: string | null;
  readonly onSelect: (id: string) => void;
}

interface SourceListProps<V extends string> {
  readonly items: readonly SourceItem<V>[];
  /** Null while a row of `group` is the one shown. */
  readonly current: V | null;
  readonly windowFocused: boolean;
  readonly onSelect: (id: V) => void;
  /** A button above the items, such as Settings' Back. */
  readonly before?: SourceAction;
  /** A heading between `before` and the items. */
  readonly heading?: string;
  readonly group?: SourceGroup;
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

/** The arrow keys walk the rows; a group's add button is reached by pointer only, as in Finder. */
function moveFocus(event: KeyboardEvent<HTMLElement>): void {
  const items = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-row]")];
  const at = items.findIndex((item) => item === document.activeElement);
  const target = targetIndex(event.key, at, items.length);
  if (target === null) return;
  event.preventDefault();
  items[target]?.focus();
}

// Semibold in the label color, so a heading reads over any wallpaper the glass lets through.
const HEADING = "px-2 pt-3 pb-1 text-subheadline font-semibold text-label";

const ROW =
  "no-drag flex h-row-height items-center gap-2 rounded-md px-2 text-left motion-safe:transition-[color,background-color] motion-safe:duration-150 motion-safe:ease-out";

interface ItemRowProps {
  readonly item: SourceItem<string>;
  readonly current: boolean;
  readonly selected: string;
  readonly onSelect: () => void;
}

function ItemRow({ item, current, selected, onSelect }: ItemRowProps) {
  return (
    <button
      type="button"
      data-row
      aria-current={current ? "page" : undefined}
      tabIndex={current ? 0 : -1}
      onClick={onSelect}
      className={`${ROW} ${current ? selected : ""}`}
    >
      {item.icon}
      <span className="min-w-0 flex-1 truncate">{item.title}</span>
    </button>
  );
}

function ActionRow({ action }: { readonly action: SourceAction }) {
  return (
    <button type="button" data-row tabIndex={-1} onClick={action.onClick} className={ROW}>
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
  group,
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
        <h2 className={HEADING}>{heading}</h2>
      )}
      {items.map((item) => (
        <ItemRow
          key={item.id}
          item={item}
          current={item.id === current}
          selected={selected}
          onSelect={() => onSelect(item.id)}
        />
      ))}
      {group === undefined ? null : (
        <>
          <h2 className={`flex items-center ${HEADING}`}>
            <span className="flex-1">{group.heading}</span>
            <button
              type="button"
              tabIndex={-1}
              aria-label={group.add.title}
              title={group.add.title}
              onClick={group.add.onClick}
              className="no-drag rounded-sm hover:bg-glass-selection"
            >
              {group.add.icon}
            </button>
          </h2>
          {group.items.map((item) => (
            <ItemRow
              key={item.id}
              item={item}
              current={item.id === group.current}
              selected={selected}
              onSelect={() => group.onSelect(item.id)}
            />
          ))}
        </>
      )}
      {after === undefined ? null : (
        <div className="mt-auto flex flex-col">
          <ActionRow action={after} />
        </div>
      )}
    </nav>
  );
}
