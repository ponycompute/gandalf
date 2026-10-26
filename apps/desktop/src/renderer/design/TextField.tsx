import type { ComponentProps } from "react";

interface TextFieldProps extends Omit<ComponentProps<"input">, "type"> {
  /** Set in `path` for URLs, refs and paths. */
  readonly mono?: boolean;
}

/** One line of input. An error sets aria-invalid, which turns the border to status-conflict. */
export function TextField({ mono = false, className = "", ...props }: TextFieldProps) {
  return (
    <input
      type="text"
      spellCheck={false}
      autoCorrect="off"
      autoCapitalize="off"
      className={`h-control-height min-w-0 rounded-md border border-field-border bg-content px-2 text-label select-text placeholder:text-label-secondary aria-invalid:border-status-conflict ${mono ? "font-mono text-path" : ""} ${className}`}
      {...props}
    />
  );
}

interface FieldHelpProps {
  readonly id: string;
  /** Replaces the help, in status-conflict, when set. */
  readonly error: string | null;
  readonly help: string | null;
}

/** The line under a field: its help, or the error in its place. */
export function FieldHelp({ id, error, help }: FieldHelpProps) {
  if (error === null && help === null) return null;
  return (
    <span
      id={id}
      aria-live="polite"
      className={`text-callout select-text ${error === null ? "text-label-secondary" : "text-status-conflict"}`}
    >
      {error ?? help}
    </span>
  );
}
