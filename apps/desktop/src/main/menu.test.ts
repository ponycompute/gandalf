import type { MenuItemConstructorOptions } from "electron";
import { describe, expect, it } from "vitest";
import type { MenuCommand } from "../shared/ipc";
import { menuTemplate, parseMenuState, updateLabel, updateSchedule } from "./menu";

function library(template: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  const menu = template.find((item) => item.label === "Library");
  return (menu?.submenu ?? []) as MenuItemConstructorOptions[];
}

function item(template: MenuItemConstructorOptions[], id: string): MenuItemConstructorOptions {
  const found = library(template).find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`no ${id}`);
  return found;
}

describe("menuTemplate", () => {
  it("offers Check for Updates on ⌘R and sends each Library item to the renderer", () => {
    const sent: MenuCommand[] = [];
    const template = menuTemplate(
      { updates: 3, sync: true, checking: false, autoManage: true },
      { send: (command) => sent.push(command), devTools: false },
    );
    expect(library(template).map((entry) => entry.label ?? entry.type)).toEqual([
      "Check for Updates",
      "Update 3 Skills…",
      "separator",
      "Sync",
      "separator",
      "Manage New Skills Automatically",
    ]);
    expect(item(template, "checkForUpdates").accelerator).toBe("CmdOrCtrl+R");
    expect(item(template, "autoManage")).toMatchObject({ type: "checkbox", checked: true });
    for (const id of ["checkForUpdates", "updateAll", "sync", "autoManage"]) {
      expect(item(template, id).enabled).not.toBe(false);
      (item(template, id).click as () => void)();
    }
    expect(sent).toEqual(["checkForUpdates", "updateAll", "sync", "toggleAutoManage"]);
  });

  it("waits while a check runs, and offers Update and Sync only when they have work", () => {
    const template = menuTemplate(
      { updates: 0, sync: false, checking: true, autoManage: false },
      { send: () => undefined, devTools: false },
    );
    expect(item(template, "checkForUpdates").enabled).toBe(false);
    expect(item(template, "updateAll")).toMatchObject({ label: "Update All…", enabled: false });
    expect(item(template, "sync").enabled).toBe(false);
  });

  it("leaves Reload out of View, so ⌘R is Check for Updates", () => {
    const view = (dev: boolean) =>
      (
        menuTemplate(
          { updates: 0, sync: false, checking: false, autoManage: false },
          { send: () => undefined, devTools: dev },
        ).find((entry) => entry.label === "View")?.submenu as MenuItemConstructorOptions[]
      ).map((entry) => entry.role);
    expect(view(false)).toEqual(["togglefullscreen"]);
    expect(view(true)).toEqual(["togglefullscreen", "toggleDevTools"]);
  });
});

describe("updateLabel", () => {
  it("counts the skills, one or many", () => {
    expect(updateLabel(1)).toBe("Update 1 Skill…");
    expect(updateLabel(2)).toBe("Update 2 Skills…");
  });
});

describe("parseMenuState", () => {
  it("takes only a whole count and three flags", () => {
    const flags = { sync: false, checking: true, autoManage: true };
    expect(parseMenuState({ updates: 2, ...flags })).toEqual({ updates: 2, ...flags });
    for (const bad of [null, "x", { updates: -1, ...flags }]) {
      expect(parseMenuState(bad)).toBeNull();
    }
    expect(parseMenuState({ updates: 1.5, ...flags })).toBeNull();
    expect(parseMenuState({ updates: 1, ...flags, sync: "yes" })).toBeNull();
    expect(parseMenuState({ updates: 1, sync: false, checking: false })).toBeNull();
  });
});

describe("updateSchedule", () => {
  it("checks five seconds after launch, then every six hours", () => {
    expect(updateSchedule({})).toEqual({ firstMs: 5_000, everyMs: 6 * 60 * 60 * 1000 });
  });

  it("is off when asked, and takes a first delay that is a whole number of milliseconds", () => {
    expect(updateSchedule({ checks: "off" })).toBeNull();
    expect(updateSchedule({ firstMs: "0" })?.firstMs).toBe(0);
    expect(updateSchedule({ firstMs: "soon" })?.firstMs).toBe(5_000);
  });
});
