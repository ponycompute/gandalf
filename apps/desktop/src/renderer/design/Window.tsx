import type { ReactNode } from "react";

interface WindowProps {
  readonly sidebar: ReactNode;
  readonly toolbar: ReactNode;
  readonly children: ReactNode;
}

export function Window({ sidebar, toolbar, children }: WindowProps) {
  return (
    <div className="flex h-full">
      {sidebar}
      <main className="relative min-w-0 flex-1 bg-content">
        {toolbar}
        <div className="gd-scroll-edge absolute inset-0 overflow-auto pt-toolbar-height">
          {children}
        </div>
      </main>
    </div>
  );
}
