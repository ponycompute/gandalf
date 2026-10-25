import type { KeyboardEvent } from "react";
import { SCREEN_ORDER, SCREENS, type Screen } from "../screens";

interface SourceListProps {
  readonly current: Screen;
  readonly windowFocused: boolean;
  readonly onSelect: (screen: Screen) => void;
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

export function SourceList({ current, windowFocused, onSelect }: SourceListProps) {
  // Coral only while focus is in the sidebar, so the window shows one coral selection at a time.
  const selected = windowFocused
    ? "bg-glass-selection group-focus-within/sources:bg-accent-fill group-focus-within/sources:text-on-accent"
    : "bg-glass-selection";
  return (
    <nav
      aria-label="Sections"
      onKeyDown={moveFocus}
      className="group/sources gd-glass drag-region m-glass-inset flex w-sidebar-width min-w-[180px] flex-none flex-col gap-px rounded-lg p-2 pt-[44px]"
    >
      {SCREEN_ORDER.map((screen) => (
        <button
          key={screen}
          type="button"
          aria-current={screen === current ? "page" : undefined}
          tabIndex={screen === current ? 0 : -1}
          onClick={() => onSelect(screen)}
          className={`no-drag flex h-row-height items-center gap-2 rounded-md px-2 text-left motion-safe:transition-[color,background-color] motion-safe:duration-150 motion-safe:ease-out ${screen === current ? selected : ""}`}
        >
          {SCREENS[screen].icon}
          <span className="min-w-0 flex-1 truncate">{SCREENS[screen].title}</span>
        </button>
      ))}
    </nav>
  );
}
