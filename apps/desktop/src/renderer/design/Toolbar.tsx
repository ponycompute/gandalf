import type { ReactNode } from "react";

interface ToolbarProps {
  readonly title: string;
  readonly subtitle: string | null;
  readonly children: ReactNode;
}

export function Toolbar({ title, subtitle, children }: ToolbarProps) {
  return (
    <header className="drag-region absolute inset-x-0 top-0 z-10 flex h-toolbar-height items-center gap-3 pr-3 pl-5">
      <div className="flex min-w-0 flex-1 items-baseline gap-2">
        <h1 className="truncate text-headline">{title}</h1>
        <p role="status" className="truncate text-label-secondary">
          {subtitle}
        </p>
      </div>
      {children}
    </header>
  );
}

export function Capsule({ children }: { readonly children: ReactNode }) {
  return (
    <div className="gd-capsule no-drag inline-flex h-capsule-height flex-none items-center gap-0.5 rounded-full px-1">
      {children}
    </div>
  );
}
