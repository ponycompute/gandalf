import type { InputHTMLAttributes } from "react";

type CheckboxProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type">;

export function Checkbox({ className = "", ...props }: CheckboxProps) {
  return <input type="checkbox" className={`gd-check ${className}`} {...props} />;
}
