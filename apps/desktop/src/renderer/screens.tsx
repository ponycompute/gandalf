import type { ReactNode } from "react";
import { AiMagicIcon, Settings01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

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

interface Place {
  readonly title: string;
  readonly icon: ReactNode;
}

export const SCREEN_ORDER = ["library", "discover", "install"] as const;

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
} as const satisfies Record<Screen, Place>;

/** The sections Settings shows in the sidebar in place of the screens. */
export const SETTING_ORDER = ["general", "agents"] as const;

export type Setting = (typeof SETTING_ORDER)[number];

export const SETTINGS = {
  general: {
    title: "General",
    icon: <HugeiconsIcon icon={Settings01Icon} size={16} aria-hidden />,
  },
  agents: { title: "Agents", icon: <HugeiconsIcon icon={AiMagicIcon} size={16} aria-hidden /> },
} as const satisfies Record<Setting, Place>;

/** Everything the window can show, each screen and each section of Settings. */
export type View = Screen | Setting;

export const VIEW_ORDER = [...SCREEN_ORDER, ...SETTING_ORDER] as const;

export const VIEWS: Readonly<Record<View, Place>> = { ...SCREENS, ...SETTINGS };

export function isSetting(view: View): view is Setting {
  return (SETTING_ORDER as readonly string[]).includes(view);
}

/** ⌘, opens Settings, as in every Mac app. */
export function isSettingsShortcut(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
): boolean {
  return event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && event.key === ",";
}
