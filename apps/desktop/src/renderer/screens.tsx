import type { ReactNode } from "react";

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      className="size-4 flex-none"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const SCREEN_ORDER = ["library", "agents", "discover", "install"] as const;

export type Screen = (typeof SCREEN_ORDER)[number];

export const SCREENS = {
  library: {
    title: "Library",
    icon: (
      <Icon>
        <rect x="2.5" y="2.5" width="4" height="11" rx="1" />
        <rect x="9.5" y="2.5" width="4" height="11" rx="1" />
      </Icon>
    ),
  },
  agents: {
    title: "Agents",
    icon: (
      <Icon>
        <rect x="2.5" y="3.5" width="11" height="9" rx="1.5" />
        <path d="M5 7l2 1.5L5 10M8.5 10H11" />
      </Icon>
    ),
  },
  discover: {
    title: "Discover",
    icon: (
      <Icon>
        <circle cx="7" cy="7" r="4.5" />
        <path d="M10.5 10.5L14 14" />
      </Icon>
    ),
  },
  install: {
    title: "Install",
    icon: (
      <Icon>
        <path d="M8 2.5v8M4.5 7L8 10.5 11.5 7M3 13.5h10" />
      </Icon>
    ),
  },
} as const satisfies Record<Screen, { readonly title: string; readonly icon: ReactNode }>;
