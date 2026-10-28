import type { ReactNode } from "react";

interface SettingsGroupProps {
  readonly title: string;
  /** Names the list for assistive technology when it differs from the heading, such as "Agents". */
  readonly label?: string;
  /** A small control at the heading's trailing edge that acts on the whole group, such as Edit…. */
  readonly action?: ReactNode;
  readonly children: ReactNode;
}

/** A titled, rounded group of settings rows, as System Settings lays them out. */
export function SettingsGroup({ title, label, action, children }: SettingsGroupProps) {
  const heading = (
    <h2 className="px-1 text-subheadline tracking-[0.04em] text-label-secondary uppercase">
      {title}
    </h2>
  );
  return (
    <section className="flex flex-col gap-2">
      {action === undefined ? (
        heading
      ) : (
        <div className="flex items-end justify-between gap-2">
          {heading}
          {action}
        </div>
      )}
      <ul
        aria-label={label ?? title}
        className="overflow-hidden rounded-[10px] border border-separator bg-content [&>li+li]:border-t [&>li+li]:border-separator"
      >
        {children}
      </ul>
    </section>
  );
}

interface SettingRowProps {
  readonly label: string;
  readonly hint?: ReactNode;
  readonly children?: ReactNode;
}

/** One setting: its name and a line on what it does, with the control at the trailing edge. */
export function SettingRow({ label, hint, children }: SettingRowProps) {
  return (
    <li aria-label={label} className="flex min-h-12 items-center gap-3 px-3.5 py-2.5">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span>{label}</span>
        {hint === undefined ? null : (
          <span className="text-callout text-label-secondary">{hint}</span>
        )}
      </div>
      {children}
    </li>
  );
}

/** Settings' content column, which stops widening where a line would get hard to follow. */
export function SettingsPage({ children }: { readonly children: ReactNode }) {
  return <div className="mx-auto flex max-w-[720px] flex-col gap-4 px-5 pt-2 pb-6">{children}</div>;
}
