import { describe, expect, it } from "vitest";
import { withHome } from "./homes";
import { withApp } from "./lever";

describe("The Library's agent filter shows one agent's skills and what sits unmanaged in its folders", () => {
  it("filters to Claude Code, adopts a skill it holds unmanaged, and goes back to every agent", async () => {
    await withHome("adoptChoice", async (home) => {
      await withApp({ home }, async (app) => {
        const { page } = app;
        const filter = page.getByRole("button", { name: "Show skills in: All Agents" });
        await filter.click();
        const claude = page.getByRole("menuitemradio", { name: /^Claude Code/ });
        expect(
          await page
            .getByRole("menuitemradio", { name: /^All Agents/ })
            .getAttribute("aria-checked"),
        ).toBe("true");
        expect(await claude.innerText()).toContain("0");
        await claude.click();

        await page.getByRole("button", { name: "Show skills in: Claude Code" }).waitFor();
        await page.getByText("No library skills in Claude Code yet").waitFor();
        await page.getByText("0 of 0 skills in Claude Code · 2 not managed").waitFor();
        const unmanaged = page.getByRole("list", { name: "Not managed in Claude Code" });
        expect(await unmanaged.getByRole("listitem").allInnerTexts()).toEqual([
          expect.stringContaining("notes"),
          expect.stringContaining("review"),
        ]);
        await unmanaged.getByTitle(`~/.claude/skills/notes`).waitFor();

        await unmanaged.getByRole("button", { name: "Adopt notes" }).click();
        await app.applySheet();
        const row = page.locator('[role="option"][data-skill="notes"]');
        await expect.poll(() => row.innerText()).toContain("Linked");
        expect(await unmanaged.getByRole("listitem").allInnerTexts()).toEqual([
          expect.stringContaining("review"),
        ]);
        await page.getByText("1 of 1 skill in Claude Code · 1 not managed").waitFor();

        // Cursor holds its own review and nothing from the library.
        await page.getByRole("button", { name: "Show skills in: Claude Code" }).click();
        await page.getByRole("menuitemradio", { name: /^Cursor/ }).click();
        await page.getByText("No library skills in Cursor yet").waitFor();
        expect(
          await page.getByRole("list", { name: "Not managed in Cursor" }).innerText(),
        ).toContain("review");

        await page.getByRole("button", { name: "Show skills in: Cursor" }).click();
        await page.getByRole("menuitemradio", { name: /^All Agents/ }).click();
        await page.getByText("1 skill", { exact: true }).waitFor();
        await expect.poll(() => row.innerText()).toContain("2 agents");
        expect(await page.getByRole("list", { name: /^Not managed in/ }).count()).toBe(0);
      });
    });
  });
});
