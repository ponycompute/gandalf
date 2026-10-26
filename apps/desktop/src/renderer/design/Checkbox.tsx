import type { ComponentProps } from "react";

type CheckboxProps = Omit<ComponentProps<"input">, "type">;

export function Checkbox({ className = "", ...props }: CheckboxProps) {
  return <input type="checkbox" className={`gd-check ${className}`} {...props} />;
}
