import type { ReactNode } from "react";

interface SectionHeadProps {
  /** The small accent link above the title. */
  eyebrow?: { label: string; href: string };
  title: string;
  children?: ReactNode;
}

export function SectionHead({ eyebrow, title, children }: SectionHeadProps) {
  return (
    <div className="head">
      {eyebrow && (
        <a className="eyebrow" href={eyebrow.href}>
          {eyebrow.label}
        </a>
      )}
      <h2>{title}</h2>
      {children && <p>{children}</p>}
    </div>
  );
}
