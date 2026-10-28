import { Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  forwardRef,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

export interface MenuItem {
  readonly label: string;
  /** A 16px glyph before the label, in the label's color. */
  readonly icon?: ReactNode;
  readonly onSelect: () => void;
  readonly disabled?: boolean;
  readonly destructive?: boolean;
  /** Draws a separator above the item. */
  readonly separated?: boolean;
  /** Makes the item a checkbox with a checkmark, as a Mac menu marks the choices that are on. */
  readonly checked?: boolean;
}

interface MenuProps {
  /** The button's accessible name, such as "More actions for demo". */
  readonly label: string;
  /** The button's face: an icon, or a word on a small push button such as "Edit…". */
  readonly face: { readonly icon: ReactNode } | { readonly text: string };
  readonly items: readonly MenuItem[];
}

const ITEMS = '[role="menuitem"], [role="menuitemcheckbox"]';
const FACE = {
  icon: "grid size-6 place-items-center rounded-md text-label-secondary hover:bg-glass-selection aria-expanded:bg-glass-selection",
  text: "h-control-height-small rounded-full bg-control px-2 text-callout whitespace-nowrap text-label shadow-control active:bg-control-pressed",
} as const;

function step(items: HTMLElement[], from: number, by: number): HTMLElement | undefined {
  for (let n = 1; n <= items.length; n++) {
    const item = items[(from + by * n + items.length * n) % items.length];
    if (item?.getAttribute("aria-disabled") !== "true") return item;
  }
  return undefined;
}

/**
 * A pull-down behind an icon button, as a Mac toolbar's ··· menu: the arrow keys move through the
 * items, Return or a click picks one, and Escape or a click elsewhere closes it, handing focus back
 * to the button. Escape stops here, so a panel around the menu stays open.
 */
export const Menu = forwardRef<HTMLButtonElement, MenuProps>(function Menu(
  { label, face, items },
  forwarded,
) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const own = useRef<HTMLButtonElement | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const setButton = (element: HTMLButtonElement | null) => {
    own.current = element;
    if (typeof forwarded === "function") forwarded(element);
    else if (forwarded !== null) forwarded.current = element;
  };

  useEffect(() => {
    if (!open) return;
    const all = [...(list.current?.querySelectorAll<HTMLElement>(ITEMS) ?? [])];
    step(all, -1, 1)?.focus();
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!list.current?.contains(target) && !own.current?.contains(target)) setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const close = () => {
    setOpen(false);
    own.current?.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const all = [...event.currentTarget.querySelectorAll<HTMLElement>(ITEMS)];
    const at = all.findIndex((item) => item === document.activeElement);
    const next = {
      ArrowDown: () => step(all, at, 1),
      ArrowUp: () => step(all, at === -1 ? 0 : at, -1),
      Home: () => step(all, -1, 1),
      End: () => step(all, 0, -1),
    }[event.key];
    if (next !== undefined) {
      event.preventDefault();
      next()?.focus();
    } else if (event.key === "Escape" || event.key === "Tab") {
      event.preventDefault();
      close();
    }
  };

  return (
    <span className="relative inline-flex">
      <button
        ref={setButton}
        type="button"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((current) => !current)}
        className={`no-drag ${"icon" in face ? FACE.icon : FACE.text}`}
      >
        {"icon" in face ? face.icon : face.text}
      </button>
      {open ? (
        <div
          ref={list}
          id={menuId}
          role="menu"
          aria-label={label}
          onKeyDown={onKeyDown}
          className="absolute top-7 right-0 z-30 flex min-w-48 flex-col rounded-[10px] bg-control p-[5px] text-body shadow-popover"
        >
          {items.map((item) => (
            <div key={item.label} className="contents">
              {item.separated ? (
                <div role="separator" className="mx-2 my-[5px] h-px bg-separator" />
              ) : null}
              <div
                role={item.checked === undefined ? "menuitem" : "menuitemcheckbox"}
                tabIndex={-1}
                aria-checked={item.checked}
                aria-disabled={item.disabled ? true : undefined}
                onClick={() => {
                  if (item.disabled) return;
                  close();
                  item.onSelect();
                }}
                onPointerEnter={(event) => {
                  if (!item.disabled) event.currentTarget.focus();
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  event.currentTarget.click();
                }}
                className={`flex h-6 cursor-default items-center gap-2 rounded-[5px] pr-3 pl-2 whitespace-nowrap outline-none focus:bg-glass-selection aria-disabled:text-label-disabled ${item.destructive ? "text-status-conflict" : ""}`}
              >
                {item.checked === undefined ? null : (
                  <span aria-hidden className="grid size-4 flex-none place-items-center">
                    {item.checked ? <HugeiconsIcon icon={Tick02Icon} size={14} /> : null}
                  </span>
                )}
                {item.icon === undefined ? null : (
                  <span aria-hidden className="grid size-4 flex-none place-items-center">
                    {item.icon}
                  </span>
                )}
                {item.label}
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </span>
  );
});
