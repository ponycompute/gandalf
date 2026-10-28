import { lstat, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withHome } from "./homes";
import { gandalfCli, withApp } from "./lever";

function exists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false,
  );
}

describe("A project's sidebar row copies library skills into a project through the sheet", () => {
  it("adds a project, copies demo into its agents' folders, takes it out and forgets the project", async () => {
    await withHome("twoAgents", async (home) => {
      const project = join(home, "work/api");
      await mkdir(project, { recursive: true });
      await withApp({ home }, async (app) => {
        await app.countLine();
        const sidebar = app.page.getByRole("navigation", { name: "Sections" });
        await app.stubFolderPanel(project);
        await sidebar.getByRole("button", { name: "Add Project…" }).click();
        await expect.poll(() => app.sheet().innerText()).toContain("Set Up api");
        await app.applySheet();
        // The project it set up opens in its own sidebar row, which shows as the current one.
        const entry = sidebar.getByRole("button", { name: "api", exact: true });
        await expect.poll(() => entry.getAttribute("aria-current")).toBe("page");
        const group = app.page.getByRole("list", { name: "Project api" });
        await group.waitFor();
        expect(await group.getByRole("checkbox").count()).toBeGreaterThan(1);
        // The toolbar counts the project's own skills and agents, not the library's.
        await app.page.getByText("0 skills · 2 agents", { exact: true }).waitFor();

        await group.getByRole("button", { name: "Add a skill to api" }).click();
        await app.page.getByRole("menuitem", { name: "demo" }).click();
        const sheet = app.sheet();
        await expect.poll(() => sheet.innerText()).toContain("Copy demo into Claude Code in api");
        expect(await sheet.innerText()).toContain("Copy demo into Cursor in api");
        await app.applySheet();
        const row = group.getByRole("listitem", { name: "demo", exact: true });
        await expect.poll(() => row.innerText()).toContain("Copied in Claude Code in api");
        await app.page.getByText("1 skill · 2 agents", { exact: true }).waitFor();
        expect(await readFile(join(project, ".claude/skills/demo/SKILL.md"), "utf8")).toContain(
          "A demo skill",
        );
        expect(await exists(join(project, ".cursor/skills/demo/SKILL.md"))).toBe(true);

        await row.getByRole("button", { name: "Remove demo from api" }).click();
        await expect.poll(() => app.sheet().innerText()).toContain("Move gandalf's copy of demo");
        await app.applySheet();
        await group.getByText("No skills yet.").waitFor();
        expect(await exists(join(project, ".claude/skills/demo"))).toBe(false);

        await sidebar.getByRole("button", { name: "Library" }).click();
        await entry.click();
        await group.getByRole("button", { name: "Forget api" }).click();
        await app.applySheet();
        await entry.waitFor({ state: "detached" });
        await expect
          .poll(() => sidebar.getByRole("button", { name: "Library" }).getAttribute("aria-current"))
          .toBe("page");
      });
      const cli = await gandalfCli(home, ["projects"]);
      expect((cli.json as { projects: readonly unknown[] }).projects).toEqual([]);
    });
  });
});
