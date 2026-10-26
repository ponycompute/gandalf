import { describe, expect, it } from "vitest";
import { BOARD_TTL_MS, boardSkills, openMarket, type MarketOptions } from "./market";

const SITE = "https://skills.example";
const GITHUB = "https://github.example";

/** A fetch that answers from `routes` by URL and records every URL asked for. */
function fakeFetch(routes: Record<string, () => Response>) {
  const asked: string[] = [];
  const fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    asked.push(url);
    const route = routes[url];
    if (route === undefined) throw new TypeError(`fetch failed: ${url}`);
    return route();
  }) as typeof globalThis.fetch;
  return { fetch, asked };
}

function market(routes: Record<string, () => Response>, now = () => 0) {
  const { fetch, asked } = fakeFetch(routes);
  const options: MarketOptions = { site: SITE, github: GITHUB, fetch, now };
  return { market: openMarket(options), asked };
}

/** A board page the way skills.sh ships it: the skills as escaped JSON inside a script. */
function boardPage(skills: readonly object[]): string {
  const json = JSON.stringify({ skills }).replace(/"/g, '\\"');
  return `<html><script>self.__next_f.push([1,"${json}"])</script></html>`;
}

const PDF = { source: "anthropics/skills", skillId: "pdf", name: "pdf", installs: 217105 };

describe("skills.sh search", () => {
  it("asks for the trimmed query and maps each skill to its repository and owner", async () => {
    const url = `${SITE}/api/search?q=pdf%20forms&limit=60`;
    const { market: m, asked } = market({
      [url]: () => Response.json({ skills: [PDF, { source: "uizze.sh", skillId: "ui-taste" }] }),
    });
    const result = await m.search("  pdf forms ");
    expect(asked).toEqual([url]);
    expect(result).toEqual({
      ok: true,
      value: [
        {
          id: "anthropics/skills/pdf",
          source: "anthropics/skills",
          skillId: "pdf",
          name: "pdf",
          installs: 217105,
          repository: `${GITHUB}/anthropics/skills.git`,
          owner: "anthropics",
        },
        {
          id: "uizze.sh/ui-taste",
          source: "uizze.sh",
          skillId: "ui-taste",
          name: "ui-taste",
          installs: 0,
          repository: null,
          owner: null,
        },
      ],
    });
  });

  it("drops entries that are not skills, such as one whose id could be an option", async () => {
    const { market: m } = market({
      [`${SITE}/api/search?q=x&limit=60`]: () =>
        Response.json({ skills: [PDF, { source: "a/b", skillId: "-x" }, null, "pdf"] }),
    });
    const result = await m.search("x");
    expect(result.ok && result.value.map((skill) => skill.id)).toEqual(["anthropics/skills/pdf"]);
  });

  it("says skills.sh could not be reached, or what it answered", async () => {
    const { market: down } = market({});
    expect(await down.search("pdf")).toEqual({
      ok: false,
      error: { kind: "network", message: `fetch failed: ${SITE}/api/search?q=pdf&limit=60` },
    });
    const { market: busy } = market({
      [`${SITE}/api/search?q=pdf&limit=60`]: () => new Response("", { status: 503 }),
    });
    expect(await busy.search("pdf")).toEqual({
      ok: false,
      error: { kind: "network", message: "skills.sh answered 503" },
    });
  });

  it("refuses a blank query without asking", async () => {
    const { market: m, asked } = market({});
    expect(await m.search(" ")).toMatchObject({ ok: false, error: { kind: "badInput" } });
    expect(asked).toEqual([]);
  });
});

describe("skills.sh boards", () => {
  it("reads the skills a board page carries, in order, once each", () => {
    const docx = { source: "anthropics/skills", skillId: "docx", name: "docx", installs: 9 };
    const html = boardPage([PDF, docx, PDF, { source: "a/b", weekly: [1, 2] }]);
    expect(boardSkills(html, GITHUB).map((skill) => skill.id)).toEqual([
      "anthropics/skills/pdf",
      "anthropics/skills/docx",
    ]);
  });

  it("keeps a board for a few minutes, then asks again", async () => {
    let now = 0;
    const { market: m, asked } = market(
      { [`${SITE}/trending`]: () => new Response(boardPage([PDF])) },
      () => now,
    );
    expect(await m.board("trending")).toMatchObject({ ok: true, value: [{ skillId: "pdf" }] });
    now = BOARD_TTL_MS - 1;
    await m.board("trending");
    expect(asked).toHaveLength(1);
    now = BOARD_TTL_MS;
    await m.board("trending");
    expect(asked).toHaveLength(2);
  });

  it("takes a page that lists no skills as skills.sh having changed, and keeps none", async () => {
    const { market: m } = market({ [`${SITE}/`]: () => new Response("<html></html>") });
    expect(await m.board("allTime")).toEqual({
      ok: false,
      error: { kind: "network", message: "skills.sh listed no skills on this board" },
    });
  });

  it("refuses a board it does not know", async () => {
    expect(await market({}).market.board("weekly")).toMatchObject({
      ok: false,
      error: { kind: "badInput", field: "board" },
    });
  });
});

describe("owner avatars", () => {
  const png = () =>
    new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "content-type": "image/png" } });

  it("hands the avatar over as a data URL and keeps it", async () => {
    const { market: m, asked } = market({ [`${GITHUB}/anthropics.png?size=48`]: png });
    expect(await m.avatar("anthropics")).toEqual({
      ok: true,
      value: "data:image/png;base64,iVBORw==",
    });
    await m.avatar("anthropics");
    expect(asked).toHaveLength(1);
  });

  it("answers null for a miss, and asks again next time", async () => {
    const { market: m, asked } = market({
      [`${GITHUB}/lena.png?size=48`]: () => new Response("not found", { status: 404 }),
    });
    expect(await m.avatar("lena")).toEqual({ ok: true, value: null });
    await new Promise((done) => setTimeout(done, 0));
    await m.avatar("lena");
    expect(asked).toHaveLength(2);
  });

  it("answers null without asking for a name that is not a GitHub owner", async () => {
    const { market: m, asked } = market({});
    expect(await m.avatar("../etc")).toEqual({ ok: true, value: null });
    expect(asked).toEqual([]);
  });
});
