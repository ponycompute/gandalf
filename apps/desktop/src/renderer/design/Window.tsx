import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";

interface WindowProps {
  readonly sidebar: ReactNode;
  readonly toolbar: ReactNode;
  readonly children: ReactNode;
}

/** Marks the sides where content is scrolled out of view, so gd-scroll-edge fades them. */
function markHiddenSides(scroller: HTMLElement): void {
  const { scrollLeft, scrollWidth, clientWidth } = scroller;
  scroller.toggleAttribute("data-hidden-left", scrollLeft > 0);
  scroller.toggleAttribute("data-hidden-right", scrollLeft + clientWidth < scrollWidth - 1);
}

export function Window({ sidebar, toolbar, children }: WindowProps) {
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
    <div className="flex h-full">
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
    </div>
  );
}
