import type { Board, MarketSkill, Result } from "../shared/ipc";

/** The skills.sh client's reach: the site, GitHub, and how main fetches. */
export interface MarketOptions {
  /** skills.sh, such as https://skills.sh, without a trailing /. */
  readonly site: string;
  /** Where a source's repository and its owner's avatar live, such as https://github.com. */
  readonly github: string;
  readonly fetch: typeof globalThis.fetch;
  readonly now: () => number;
}

export interface Market {
  search(query: unknown): Promise<Result<readonly MarketSkill[]>>;
  board(board: unknown): Promise<Result<readonly MarketSkill[]>>;
  /** The owner's avatar as a data URL, or null when it cannot be had. Never an error. */
  avatar(owner: unknown): Promise<Result<string | null>>;
}

/** How many results a search asks for, as skills-manager does. */
export const SEARCH_LIMIT = 60;
/** How many entries of a board the renderer gets: the site lists hundreds. */
export const BOARD_LIMIT = 100;
/** How long a board stays fresh: it changes through the day, not by the minute. */
export const BOARD_TTL_MS = 5 * 60 * 1000;
const TIMEOUT_MS = 15_000;
const MAX_AVATAR_BYTES = 256 * 1024;

const BOARD_PATHS: Readonly<Record<Board, string>> = {
  allTime: "/",
  trending: "/trending",
  hot: "/hot",
};

/** A GitHub owner/repo. Anything else, such as a site's own domain, is not a repository gandalf can fetch. */
const REPOSITORY = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const SKILL_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/i;

/** One skill as skills.sh lists it, or null for an entry that is not one. */
export function marketSkill(raw: unknown, github: string): MarketSkill | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { source, skillId, name, installs } = raw as Record<string, unknown>;
  if (typeof source !== "string" || typeof skillId !== "string" || !SKILL_ID.test(skillId)) {
    return null;
  }
  return {
    id: `${source}/${skillId}`,
    source,
    skillId,
    name: typeof name === "string" && name !== "" ? name : skillId,
    installs: typeof installs === "number" && Number.isFinite(installs) ? installs : 0,
    repository: REPOSITORY.test(source) ? `${github}/${source}.git` : null,
    owner: REPOSITORY.test(source) ? (source.split("/")[0] ?? null) : null,
  };
}

/**
 * The skills a board page lists, in its order. The page carries them as escaped JSON in its
 * script, one flat object per skill, so each is cut out by its opening "source" key.
 */
export function boardSkills(html: string, github: string): MarketSkill[] {
  const seen = new Set<string>();
  const skills: MarketSkill[] = [];
  for (const match of html.matchAll(/\{\\"source\\":(?:[^{}\\]|\\.)*\}/g)) {
    let raw: unknown;
    try {
      raw = JSON.parse(match[0].replace(/\\(["\\])/g, "$1"));
    } catch {
      continue;
    }
    const skill = marketSkill(raw, github);
    if (skill === null || seen.has(skill.id)) continue;
    seen.add(skill.id);
    skills.push(skill);
    if (skills.length === BOARD_LIMIT) break;
  }
  return skills;
}

function failure(message: string): Result<never> {
  return { ok: false, error: { kind: "network", message } };
}

function reason(error: unknown): string {
  if (error instanceof Error && error.name === "TimeoutError") return "it did not answer in time";
  return error instanceof Error ? error.message : String(error);
}

export function openMarket(options: MarketOptions): Market {
  const boards = new Map<Board, { readonly at: number; readonly skills: MarketSkill[] }>();
  const avatars = new Map<string, Promise<string | null>>();

  const get = (url: string) => options.fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });

  const fetchAvatar = async (owner: string): Promise<string | null> => {
    try {
      const response = await get(`${options.github}/${owner}.png?size=48`);
      const type = response.headers.get("content-type") ?? "";
      if (!response.ok || !type.startsWith("image/")) return null;
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > MAX_AVATAR_BYTES) return null;
      return `data:${type.split(";")[0]};base64,${bytes.toString("base64")}`;
    } catch {
      return null;
    }
  };

  return {
    async search(query) {
      if (typeof query !== "string" || query.trim() === "") {
        return {
          ok: false,
          error: { kind: "badInput", field: "query", message: "query must be text" },
        };
      }
      const url = `${options.site}/api/search?q=${encodeURIComponent(query.trim())}&limit=${SEARCH_LIMIT}`;
      try {
        const response = await get(url);
        if (!response.ok) return failure(`skills.sh answered ${response.status}`);
        const body = (await response.json()) as { skills?: unknown };
        const list = Array.isArray(body.skills) ? body.skills : [];
        const skills = list
          .map((raw) => marketSkill(raw, options.github))
          .filter((skill) => skill !== null);
        return { ok: true, value: skills };
      } catch (error) {
        return failure(reason(error));
      }
    },

    async board(board) {
      if (board !== "allTime" && board !== "trending" && board !== "hot") {
        return {
          ok: false,
          error: {
            kind: "badInput",
            field: "board",
            message: "board must be allTime, trending or hot",
          },
        };
      }
      const cached = boards.get(board);
      if (cached !== undefined && options.now() - cached.at < BOARD_TTL_MS) {
        return { ok: true, value: cached.skills };
      }
      try {
        const response = await get(`${options.site}${BOARD_PATHS[board]}`);
        if (!response.ok) return failure(`skills.sh answered ${response.status}`);
        const skills = boardSkills(await response.text(), options.github);
        if (skills.length === 0) return failure("skills.sh listed no skills on this board");
        boards.set(board, { at: options.now(), skills });
        return { ok: true, value: skills };
      } catch (error) {
        return failure(reason(error));
      }
    },

    async avatar(owner) {
      if (typeof owner !== "string" || !OWNER.test(owner)) return { ok: true, value: null };
      let found = avatars.get(owner);
      if (found === undefined) {
        found = fetchAvatar(owner);
        avatars.set(owner, found);
        // A miss is asked again next time, as the network may be back.
        void found.then((url) => {
          if (url === null) avatars.delete(owner);
        });
      }
      return { ok: true, value: await found };
    },
  };
}
