import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";

interface WindowProps {
  readonly sidebar: ReactNode;
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

export function Window({ sidebar, toolbar, children, inspector = null }: WindowProps) {
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
      {sidebar}
      <main className="relative min-w-0 flex-1 bg-content">
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
    </div>
  );
}
