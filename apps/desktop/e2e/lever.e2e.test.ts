import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { launchApp } from "./lever";

type Failure = "none" | "firstWindow" | "windowId" | "close";

const electron = vi.hoisted(() => ({
  fail: "none" as Failure,
  launches: [] as { userData: string; closed: boolean }[],
}));

vi.mock("playwright", () => ({
  _electron: {
    launch: async (options: { env: Record<string, string> }) => {
      const launch = { userData: options.env.GANDALF_USER_DATA ?? "", closed: false };
      electron.launches.push(launch);
      const page = {
        screenshot: async ({ path }: { path: string }) => writeFile(path, "png"),
        waitForTimeout: async () => {},
      };
      return {
        process: () => ({ stdout: null }),
        firstWindow: async () => {
          if (electron.fail === "firstWindow") throw new Error("no first window");
          return page;
        },
        evaluate: async () => {
          if (electron.fail === "windowId") throw new Error("no window id");
          return 1;
        },
        close: async () => {
          launch.closed = true;
          if (electron.fail === "close") throw new Error("close failed");
        },
      };
    },
  },
}));

describe("launchApp cleanup", () => {
  let home = "";

  beforeEach(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), "gandalf-lever-")));
    electron.launches.length = 0;
  });

  afterEach(async () => {
    electron.fail = "none";
    await rm(home, { recursive: true, force: true });
  });

  for (const failure of ["firstWindow", "windowId"] as const) {
    it(`stops Electron and removes userData when ${failure} fails`, async () => {
      electron.fail = failure;
      await expect(launchApp({ home })).rejects.toThrow();
      const [launch] = electron.launches;
      expect(launch?.closed).toBe(true);
      expect(launch?.userData).not.toBe("");
      expect(existsSync(launch?.userData ?? "")).toBe(false);
    });
  }

  it("removes userData even when Electron fails to close", async () => {
    const app = await launchApp({ home, autoManage: "ask" });
    electron.fail = "close";
    await expect(app.close()).rejects.toThrow("close failed");
    expect(existsSync(electron.launches[0]?.userData ?? "")).toBe(false);
  });

  it("creates the default shots dir only when a shot is taken", async () => {
    const app = await launchApp({ home, autoManage: "ask" });
    try {
      expect(existsSync(app.shots)).toBe(false);
      const shot = await app.shot("probe");
      expect(existsSync(shot)).toBe(true);
    } finally {
      await app.close();
      await rm(app.shots, { recursive: true, force: true });
    }
  });
});
