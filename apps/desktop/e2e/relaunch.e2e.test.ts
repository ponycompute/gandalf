import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withHome } from "./homes";
import { withApp, type App } from "./lever";

const sections = (app: App) => app.page.getByRole("navigation", { name: "Sections" });

const windowSize = (app: App) =>
  app.electron.evaluate(
    ({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.getSize(),
    app.windowId,
  );

describe("A relaunch opens where the last launch quit", () => {
  it("keeps the window size and the selected screen in userData", async () => {
    await withHome("twoAgents", async (home) => {
      const userData = await mkdtemp(join(tmpdir(), "gandalf-relaunch-"));
      try {
        await withApp({ home, userData }, async (app) => {
          await app.countLine();
          expect(await windowSize(app)).toEqual([960, 640]);
          await app.resize(1100, 720);
          await sections(app).getByRole("button", { name: "Agents" }).click();
          await app.page.getByRole("list", { name: "Agents" }).waitFor();
        });
        expect(JSON.parse(await readFile(join(userData, "window.json"), "utf8"))).toEqual({
          width: 1100,
          height: 720,
        });
        await withApp({ home, userData }, async (app) => {
          await app.page.getByRole("list", { name: "Agents" }).waitFor();
          expect(await windowSize(app)).toEqual([1100, 720]);
          expect(
            await sections(app)
              .getByRole("button", { name: "Agents" })
              .getAttribute("aria-current"),
          ).toBe("page");
        });
      } finally {
        await rm(userData, { recursive: true, force: true });
      }
    });
  });
});
