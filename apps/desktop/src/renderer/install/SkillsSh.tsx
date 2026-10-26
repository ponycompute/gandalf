import { Search01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";
import type { Snapshot } from "@gandalf/skills";
import type { Board, MarketSkill, Result } from "../../shared/ipc";
import type { Flow, FlowEvent } from "../changes/writeFlow";
import { Button } from "../design/Button";
import { OwnerAvatar } from "../design/OwnerAvatar";
import { SegmentedControl } from "../design/SegmentedControl";
import { Spinner } from "../design/Spinner";
import { TextField } from "../design/TextField";
import { invoke } from "../invoke";
import {
  installsSkill,
  marketStanding,
  rowProblem,
  type InstallIntent,
  type MarketStanding,
} from "./form";

const BOARDS = [
  { value: "allTime", label: "All Time" },
  { value: "trending", label: "Trending (24h)" },
  { value: "hot", label: "Hot" },
] as const satisfies readonly { readonly value: Board; readonly label: string }[];

const BOARD_TITLE = {
  allTime: "Most installed on skills.sh",
  trending: "Trending on skills.sh",
  hot: "Hot on skills.sh",
} as const satisfies Record<Board, string>;

/** How long typing pauses before skills.sh is asked. */
const DEBOUNCE_MS = 300;

type Listing =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly skills: readonly MarketSkill[] }
  | { readonly kind: "failed"; readonly message: string };

/** The board, or the results for the query, asked again when either changes or Try Again is clicked. */
function useListing(query: string, board: Board): { listing: Listing; retry: () => void } {
  const [listing, setListing] = useState<Listing>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const trimmed = query.trim();
  useEffect(() => {
    let current = true;
    setListing({ kind: "loading" });
    const ask = (): Promise<Result<readonly MarketSkill[]>> =>
      trimmed === ""
        ? invoke(() => window.gandalf.skillsShBoard(board))
        : invoke(() => window.gandalf.searchSkillsSh(trimmed));
    const timer = setTimeout(
      () => {
        void ask().then((result) => {
          if (!current) return;
          setListing(
            result.ok
              ? { kind: "ready", skills: result.value }
              : { kind: "failed", message: "message" in result.error ? result.error.message : "" },
          );
        });
      },
      trimmed === "" ? 0 : DEBOUNCE_MS,
    );
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [trimmed, board, attempt]);
  return { listing, retry: () => setAttempt((count) => count + 1) };
}

function installs(count: number, board: Board | null): string {
  const shown = count >= 1000 ? `${(count / 1000).toFixed(count >= 10_000 ? 0 : 1)}K` : `${count}`;
  return `${shown} installs${board === "trending" ? " today" : ""}`;
}

const STANDING_TEXT = {
  inLibrary: "In Library",
  nameTaken: "Name Taken",
  notOnGitHub: "Not on GitHub",
} as const satisfies Record<Exclude<MarketStanding, "new">, string>;

const STANDING_HINT = {
  inLibrary: "This skill is in your library already.",
  nameTaken: "A skill by this name from another source is in your library.",
  notOnGitHub: "This skill is not in a GitHub repository, so gandalf cannot fetch it.",
} as const satisfies Record<Exclude<MarketStanding, "new">, string>;

interface SkillsShProps {
  readonly snapshot: Snapshot;
  readonly flow: Flow;
  readonly dispatch: (event: FlowEvent) => void;
  readonly query: string;
  readonly board: Board;
  readonly onBoard: (board: Board) => void;
  /** The install of a skill with the agents chosen, or null after the form said why it cannot. */
  readonly intentFor: (skill: MarketSkill) => InstallIntent | null;
}

/**
 * skills.sh in the Install screen: a board while the search is empty, the results otherwise, and an
 * Install on each row that plans the install into the sync sheet. A failure is said on its row.
 */
export function SkillsSh({
  snapshot,
  flow,
  dispatch,
  query,
  board,
  onBoard,
  intentFor,
}: SkillsShProps) {
  const { listing, retry } = useListing(query, board);
  const searching = query.trim() !== "";
  const planning = flow.kind === "planning" && flow.intent.kind === "install" ? flow.intent : null;
  const problem = rowProblem(flow);

  const install = (skill: MarketSkill) => {
    if (planning !== null) return;
    const intent = intentFor(skill);
    if (intent !== null) dispatch({ kind: "plan", intent });
  };

  const header =
    listing.kind === "ready" && searching
      ? `Results for “${query.trim()}” · ${listing.skills.length}`
      : searching
        ? `Results for “${query.trim()}”`
        : BOARD_TITLE[board];

  return (
    <section aria-label="skills.sh" className="flex flex-col gap-2">
      <div className="flex min-h-6 items-center gap-2 px-1">
        <h2 className="min-w-0 flex-1 text-subheadline tracking-[0.04em] text-label-secondary uppercase">
          {header}
        </h2>
        {searching ? null : (
          <SegmentedControl label="Board" segments={BOARDS} value={board} onChange={onBoard} />
        )}
      </div>
      {listing.kind === "loading" ? (
        <div
          role="status"
          aria-label="Loading skills.sh"
          className="flex flex-col overflow-hidden rounded-[10px] border border-separator bg-content"
        >
          {[0, 1, 2, 3, 4].map((row) => (
            <div
              key={row}
              className="flex items-center gap-3 border-separator px-3.5 py-2.5 [&+&]:border-t"
            >
              <span className="size-7 rounded-md bg-separator motion-safe:animate-pulse" />
              <span className="flex flex-1 flex-col gap-1.5">
                <span className="h-3 w-32 rounded bg-separator motion-safe:animate-pulse" />
                <span className="h-2.5 w-48 rounded bg-separator motion-safe:animate-pulse" />
              </span>
            </div>
          ))}
        </div>
      ) : listing.kind === "failed" ? (
        <Notice
          title="skills.sh could not be reached"
          text={`Check your connection, then try again.${listing.message === "" ? "" : ` (${listing.message})`}`}
          onRetry={retry}
        />
      ) : listing.skills.length === 0 ? (
        <Notice
          title={searching ? `No skills match “${query.trim()}”` : "This board is empty"}
          text={searching ? "Try fewer or other words." : "Pick another board."}
        />
      ) : (
        <ul
          aria-label={header}
          className="overflow-hidden rounded-[10px] border border-separator bg-content [&>li+li]:border-t [&>li+li]:border-separator"
        >
          {listing.skills.map((skill, index) => {
            const standing = marketStanding(skill, snapshot);
            const running = planning !== null && installsSkill(planning, skill);
            const failed =
              problem !== null &&
              problem.url === skill.repository &&
              problem.skill === skill.skillId
                ? problem
                : null;
            return (
              <li
                key={skill.id}
                aria-label={skill.name}
                className="flex items-center gap-3 px-3.5 py-2"
              >
                {searching ? null : (
                  <span className="w-6 flex-none text-right text-callout text-label-secondary tabular-nums">
                    {index + 1}
                  </span>
                )}
                <OwnerAvatar owner={skill.owner} fallback={skill.source} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-semibold">{skill.name}</span>
                  <span className="truncate text-callout text-label-secondary">
                    {skill.source} · {installs(skill.installs, searching ? null : board)}
                  </span>
                  {failed === null ? null : (
                    <span role="alert" className="text-callout text-status-conflict select-text">
                      {failed.message}
                      {failed.detail === null ? null : (
                        <span className="block font-mono text-path whitespace-pre-wrap text-label-secondary">
                          {failed.detail}
                        </span>
                      )}
                    </span>
                  )}
                </span>
                {running ? (
                  <span className="flex flex-none items-center gap-2">
                    <Button size="small" onClick={() => dispatch({ kind: "cancel" })}>
                      Cancel
                    </Button>
                    <Button
                      size="small"
                      variant="primary"
                      aria-disabled
                      aria-busy
                      className="inline-flex items-center gap-1.5"
                    >
                      <Spinner />
                      Installing…
                    </Button>
                  </span>
                ) : standing !== "new" ? (
                  <span
                    title={STANDING_HINT[standing]}
                    className="flex flex-none items-center gap-1 text-callout text-label-secondary"
                  >
                    {standing === "inLibrary" ? (
                      <HugeiconsIcon
                        icon={Tick02Icon}
                        size={12}
                        className="text-accent"
                        aria-hidden
                      />
                    ) : null}
                    {STANDING_TEXT[standing]}
                  </span>
                ) : (
                  <Button
                    size="small"
                    variant={failed === null ? "default" : "primary"}
                    aria-label={`${failed === null ? "Install" : "Try installing"} ${skill.name}`}
                    aria-disabled={planning === null ? undefined : true}
                    onClick={() => install(skill)}
                    className="flex-none"
                  >
                    {failed === null ? "Install" : "Try Again"}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <p className="px-1 text-callout text-label-secondary">
        Skills on skills.sh come from public GitHub repositories. gandalf shows what changes before
        it installs.
      </p>
    </section>
  );
}

/** The search field, which sits in the Source group under the segments. */
export function SkillsShSearch({
  query,
  onQuery,
}: {
  readonly query: string;
  readonly onQuery: (query: string) => void;
}) {
  return (
    <span className="relative flex min-w-0 flex-1">
      <HugeiconsIcon
        icon={Search01Icon}
        size={14}
        aria-hidden
        className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-label-secondary"
      />
      <TextField
        aria-label="Search skills.sh"
        placeholder="Search skills.sh"
        className="flex-1 pl-7"
        value={query}
        onChange={(event) => onQuery(event.target.value)}
      />
    </span>
  );
}

function Notice({
  title,
  text,
  onRetry,
}: {
  readonly title: string;
  readonly text: string;
  readonly onRetry?: () => void;
}) {
  return (
    <div
      role="status"
      className="flex flex-col items-center gap-1 rounded-[10px] border border-separator bg-content px-6 py-8 text-center"
    >
      <span className="font-semibold">{title}</span>
      <span className="text-callout text-label-secondary select-text">{text}</span>
      {onRetry === undefined ? null : (
        <Button size="small" className="mt-2" onClick={onRetry}>
          Try Again
        </Button>
      )}
    </div>
  );
}
