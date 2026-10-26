import type { ReactNode } from "react";

interface Segment<T extends string> {
  readonly value: T;
  readonly label: string;
  /** Shown in place of the label, which then names the segment and is its tooltip. */
  readonly icon?: ReactNode;
}

interface SegmentedControlProps<T extends string> {
  /** What the segments choose between, for assistive technology. */
  readonly label: string;
  readonly segments: readonly Segment<T>[];
  readonly value: T;
  readonly onChange: (value: T) => void;
}

/** Picks one of two to four modes. The track and the selected segment are capsules. */
export function SegmentedControl<T extends string>({
  label,
  segments,
  value,
  onChange,
}: SegmentedControlProps<T>) {
  return (
    <div
      role="group"
      aria-label={label}
      className="inline-flex gap-0.5 rounded-full bg-separator p-0.5"
    >
      {segments.map((segment) => (
        <button
          key={segment.value}
          type="button"
          aria-pressed={segment.value === value}
          aria-label={segment.icon === undefined ? undefined : segment.label}
          title={segment.icon === undefined ? undefined : segment.label}
          onClick={() => onChange(segment.value)}
          className={`no-drag h-5 rounded-full aria-pressed:bg-control aria-pressed:font-semibold aria-pressed:shadow-control motion-safe:transition-[color,background-color] motion-safe:duration-150 motion-safe:ease-out ${segment.icon === undefined ? "px-3" : "grid w-8 place-items-center text-label-secondary aria-pressed:text-label"}`}
        >
          {segment.icon ?? segment.label}
        </button>
      ))}
    </div>
  );
}
