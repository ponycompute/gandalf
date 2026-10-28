import type { MenuItemConstructorOptions } from "electron";
import type { MenuCommand, MenuState } from "../shared/ipc";

/** What the menu shows before the renderer first says: nothing found, nothing to sync. */
export const NO_MENU_STATE: MenuState = {
  updates: 0,
  sync: false,
  checking: false,
  autoManage: false,
};

/** The renderer's menu state, or null for anything else: it arrives over IPC as unknown. */
export function parseMenuState(raw: unknown): MenuState | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { updates, sync, checking, autoManage } = raw as Record<string, unknown>;
  if (typeof updates !== "number" || !Number.isInteger(updates) || updates < 0) return null;
  if (typeof sync !== "boolean" || typeof checking !== "boolean") return null;
  if (typeof autoManage !== "boolean") return null;
  return { updates, sync, checking, autoManage };
}

/** "Update 3 Skills…", or "Update All…" while gandalf has found nothing newer. */
export function updateLabel(updates: number): string {
  if (updates === 0) return "Update All…";
  return `Update ${updates} ${updates === 1 ? "Skill" : "Skills"}…`;
}

interface MenuOptions {
  /** Hands a picked Library item to the renderer. */
  readonly send: (command: MenuCommand) => void;
  /** Adds Toggle Developer Tools to View, for a build run from the source tree. */
  readonly devTools: boolean;
}

/**
 * The menu bar: the Mac's own menus, and Library with gandalf's library-wide actions. View has no
 * Reload, which would take ⌘R from Check for Updates and throw away what the window shows.
 */
export function menuTemplate(
  state: MenuState,
  { send, devTools }: MenuOptions,
): MenuItemConstructorOptions[] {
  return [
    { role: "appMenu" },
    { role: "fileMenu" },
    { role: "editMenu" },
    {
      label: "Library",
      submenu: [
        {
          id: "checkForUpdates",
          label: "Check for Updates",
          accelerator: "CmdOrCtrl+R",
          enabled: !state.checking,
          click: () => send("checkForUpdates"),
        },
        {
          id: "updateAll",
          label: updateLabel(state.updates),
          enabled: state.updates > 0,
          click: () => send("updateAll"),
        },
        { type: "separator" },
        { id: "sync", label: "Sync", enabled: state.sync, click: () => send("sync") },
        { type: "separator" },
        {
          id: "autoManage",
          label: "Manage New Skills Automatically",
          type: "checkbox",
          checked: state.autoManage,
          click: () => send("toggleAutoManage"),
        },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "togglefullscreen" },
        ...(devTools ? [{ role: "toggleDevTools" } as const] : []),
      ],
    },
    { role: "windowMenu" },
  ];
}

/** When gandalf checks for updates by itself. Null when it never does. */
export interface UpdateSchedule {
  /** After the window first shows. */
  readonly firstMs: number;
  /** Between checks after that. */
  readonly everyMs: number;
}

const FIRST_CHECK_MS = 5_000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

/**
 * GANDALF_UPDATE_CHECKS=off turns the checks off, as the end-to-end tests do so a fetch never runs
 * under a test that did not ask for one. GANDALF_FIRST_UPDATE_CHECK_MS moves the first check.
 */
export function updateSchedule(env: {
  readonly checks?: string;
  readonly firstMs?: string;
}): UpdateSchedule | null {
  if (env.checks === "off") return null;
  const first = env.firstMs === undefined ? FIRST_CHECK_MS : Number(env.firstMs);
  return {
    firstMs: Number.isInteger(first) && first >= 0 ? first : FIRST_CHECK_MS,
    everyMs: CHECK_EVERY_MS,
  };
}
