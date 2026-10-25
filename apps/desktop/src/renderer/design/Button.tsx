import type { ButtonHTMLAttributes } from "react";

export type ButtonVariant = "default" | "primary" | "destructive" | "borderless";
export type ButtonSize = "regular" | "small" | "capsule";

const VARIANT = {
  default: "bg-control text-label active:bg-control-pressed",
  primary: "bg-primary text-primary-foreground active:brightness-92",
  destructive: "bg-control text-status-conflict active:bg-control-pressed",
  borderless: "bg-transparent text-accent",
} as const satisfies Record<ButtonVariant, string>;

const HEIGHT = {
  regular: "h-control-height",
  small: "h-control-height-small text-callout",
  capsule: "h-7",
} as const satisfies Record<ButtonSize, string>;

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
}

export function Button({
  variant = "default",
  size = "regular",
  className = "",
  type = "button",
  ...props
}: ButtonProps) {
  const padding = variant === "borderless" ? "px-1" : size === "small" ? "px-2" : "px-3";
  const shadow = variant === "borderless" || size === "capsule" ? "" : "shadow-control";
  return (
    <button
      type={type}
      className={`no-drag rounded-full whitespace-nowrap disabled:pointer-events-none disabled:opacity-50 motion-safe:transition-[color,background-color,opacity] motion-safe:duration-150 motion-safe:ease-out ${HEIGHT[size]} ${padding} ${shadow} ${VARIANT[variant]} ${className}`}
      {...props}
    />
  );
}
