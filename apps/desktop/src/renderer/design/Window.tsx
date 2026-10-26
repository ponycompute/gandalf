import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";

interface WindowProps {
  readonly sidebar: ReactNode;
  readonly sidebarShown: boolean;
  readonly onToggleSidebar: () => void;
  readonly toolbar: ReactNode;
  readonly children: ReactNode;
  /**
   * A second floating glass panel on the right, mirrored from the sidebar, such as Skill detail.
   * It fills the height it is given.
   */
  readonly inspector?: ReactNode;
}

/** Marks the sides where content is scrolled out of view, so gd-scroll-edge fades them. */
function markHiddenSides(scroller: HTMLElement): void {
  const { scrollLeft, scrollWidth, clientWidth } = scroller;
  scroller.toggleAttribute("data-hidden-left", scrollLeft > 0);
  scroller.toggleAttribute("data-hidden-right", scrollLeft + clientWidth < scrollWidth - 1);
}

/**
 * The sidebar's show/hide button, right of the traffic lights in both states like Finder's, so it
 * never moves under the pointer.
 */
function SidebarToggle({
  shown,
  onToggle,
}: {
  readonly shown: boolean;
  readonly onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={shown ? "Hide Sidebar" : "Show Sidebar"}
      aria-controls="gd-sidebar"
      aria-expanded={shown}
      title={`${shown ? "Hide" : "Show"} Sidebar (⌃⌘S)`}
      data-sidebar-toggle
      onClick={onToggle}
      className="no-drag absolute top-[15px] left-[84px] z-30 grid size-7 place-items-center rounded-md text-label-secondary hover:bg-glass-selection hover:text-label focus-visible:outline-2 focus-visible:outline-focus-ring"
    >
      <svg
        className="size-4"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        aria-hidden="true"
      >
        <rect x="1.5" y="2.5" width="13" height="11" rx="2" />
        <path d="M6 2.5v11" />
      </svg>
    </button>
  );
}

export function Window({
  sidebar,
  sidebarShown,
  onToggleSidebar,
  toolbar,
  children,
  inspector = null,
}: WindowProps) {
  const scroller = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (scroller.current !== null) markHiddenSides(scroller.current);
  });
  useEffect(() => {
    const element = scroller.current;
    if (element === null) return;
    const mark = () => markHiddenSides(element);
    const resized = new ResizeObserver(mark);
    resized.observe(element);
    element.addEventListener("scroll", mark, { passive: true });
    return () => {
      resized.disconnect();
      element.removeEventListener("scroll", mark);
    };
  }, []);
  return (
    <div className="relative flex h-full">
      <div className={sidebarShown ? "contents" : "hidden"}>{sidebar}</div>
      {/* After the list, so Tab reaches the sections first; it draws over the sidebar's top. */}
      <SidebarToggle shown={sidebarShown} onToggle={onToggleSidebar} />
      {/* Without the sidebar the toolbar starts past the traffic lights and the toggle. */}
      <main
        className={`relative min-w-0 flex-1 bg-content ${sidebarShown ? "" : "[--gd-toolbar-start:124px]"}`}
      >
        {toolbar}
        <div
          ref={scroller}
          className="gd-scroll-edge absolute inset-0 overflow-auto pt-toolbar-height"
        >
          {children}
        </div>
      </main>
      {/*
       * Beside the content from 900 px, where the matrix keeps a skill column and two agents. A
       * narrower window floats the inspector over the content, under the toolbar so Sync stays in
       * reach, rather than squeezing the matrix to a sliver; Close or Escape gives it back. It
       * starts right at the toolbar's edge, with no inset above, so no column header shows over it.
       */}
      {inspector === null ? null : (
        <div className="flex flex-none p-glass-inset max-[899px]:absolute max-[899px]:top-toolbar-height max-[899px]:right-0 max-[899px]:bottom-0 max-[899px]:z-20 max-[899px]:pt-0">
          {inspector}
        </div>
      )}
      {/*
       * Electron reads drag regions in document order, so the toolbar's drag region, which reaches
       * under the toggle while the sidebar is hidden, would swallow its clicks. This no-drag patch
       * comes last and gives them back; clicks pass through it to the toggle.
       */}
      <div
        aria-hidden
        className="no-drag pointer-events-none absolute top-[15px] left-[84px] size-7"
      />
    </div>
  );
}
