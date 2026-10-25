import type { ReactNode } from "react";

export type BannerTone = "change" | "conflict" | "error";

const TONE = {
  change: { role: "status", fill: "bg-change-tint", glyph: "◐", ink: "text-status-change" },
  conflict: { role: "alert", fill: "bg-conflict-tint", glyph: "✗", ink: "text-status-conflict" },
  error: { role: "alert", fill: "bg-conflict-tint", glyph: null, ink: "" },
} as const satisfies Record<
  BannerTone,
  { role: string; fill: string; glyph: string | null; ink: string }
>;

interface BannerProps {
  readonly tone: BannerTone;
  readonly title: string;
  readonly children: ReactNode;
}

export function Banner({ tone, title, children }: BannerProps) {
  const style = TONE[tone];
  return (
    <div role={style.role} className={`flex items-start gap-3 rounded-lg px-4 py-3 ${style.fill}`}>
      {style.glyph === null ? null : (
        <span aria-hidden="true" className={`font-mono font-bold ${style.ink}`}>
          {style.glyph}
        </span>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="font-semibold">{title}</span>
        {children}
      </div>
    </div>
  );
}
