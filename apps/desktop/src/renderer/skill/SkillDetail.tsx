import { Cancel01Icon, MoreHorizontalIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { AgentView, SkillSource, SkillView } from "@gandalf/skills";
import type { Flow, FlowEvent } from "../changes/writeFlow";
import { AgentLogo } from "../design/AgentLogo";
import { Button } from "../design/Button";
import { Checkbox } from "../design/Checkbox";
import { Menu, type MenuItem } from "../design/Menu";
import { modeOf, type Modes } from "../library/modes";
import { notesOf, problemsOf } from "../library/problems";
import { StatusGlyph } from "../library/StatusGlyph";
import { PathText } from "../design/PathText";
import { Spinner } from "../design/Spinner";
import { invoke } from "../invoke";
import { tilde, type Names } from "../vocabulary";

/** SKILL.md as read for one folder and content hash, so an edit on disk reads it again. */
type Read =
  | { readonly key: string; readonly kind: "read"; readonly text: string }
  | { readonly key: string; readonly kind: "refused"; readonly reason: string };

const ADDED = new Intl.DateTimeFormat("en-US", { dateStyle: "medium" });

/** The refusal's reason without its field, "is larger than 1 MB", to follow "it". */
function reasonOf(message: string): string {
  return message.replace(/^path: /, "");
}

function useSkillMd(skill: SkillView): Read | null {
  const key = `${skill.dir}\n${skill.hash ?? ""}`;
  const [read, setRead] = useState<Read | null>(null);
  useEffect(() => {
    let current = true;
    void invoke(() => window.gandalf.readSkillFile(`${skill.dir}/SKILL.md`)).then((result) => {
      if (!current) return;
      setRead(
        result.ok
          ? { key, kind: "read", text: result.value }
          : {
              key,
              kind: "refused",
              reason: "message" in result.error ? reasonOf(result.error.message) : "",
            },
      );
    });
    return () => {
      current = false;
    };
  }, [key, skill.dir]);
  // A read made for another folder or version never shows under this one.
  return read?.key === key ? read : null;
}

function Fact({ term, children }: { readonly term: string; readonly children: ReactNode }) {
  return (
    <>
      <dt className="text-label-secondary">{term}</dt>
      <dd className="flex min-w-0 flex-col">{children}</dd>
    </>
  );
}

function Mono({ children, title }: { readonly children: ReactNode; readonly title?: string }) {
  return (
    <span title={title} className="font-mono text-path [overflow-wrap:anywhere] select-text">
      {children}
    </span>
  );
}

/** Where the skill came from, with the commit a git skill is pinned at. */
function SourceFacts({
  source,
  names,
}: {
  readonly source: SkillSource | null;
  readonly names: Names;
}) {
  if (source === null) {
    return (
      <Fact term="Source">
        <span>Not recorded. Sync leaves it alone until you turn it on for an agent.</span>
      </Fact>
    );
  }
  switch (source.kind) {
    case "local":
      return (
        <Fact term="Source">
          {source.path === null ? (
            <span>A folder placed in the library by hand</span>
          ) : (
            <PathText wrap path={source.path} />
          )}
        </Fact>
      );
    case "adopted":
      return (
        <Fact term="Source">
          <span>
            Adopted from{" "}
            {source.from === null ? "a skills folder agents share" : names.agent(source.from)}
          </span>
        </Fact>
      );
    case "git":
      return (
        <>
          <Fact term="Source">
            {/* A repository on this Mac is a path, written with ~ as PathText writes them. */}
            {source.url.startsWith("/") ? (
              <PathText wrap path={source.url} />
            ) : (
              <Mono>{tilde(source.url, names)}</Mono>
            )}
          </Fact>
          {source.ref === null ? null : (
            <Fact term="Branch or tag">
              <Mono>{source.ref}</Mono>
            </Fact>
          )}
          {source.subpath === null ? null : (
            <Fact term="Folder">
              <Mono>{source.subpath}</Mono>
            </Fact>
          )}
          <Fact term="Commit">
            <Mono title={source.commit}>{source.commit.slice(0, 12)}</Mono>
          </Fact>
        </>
      );
  }
}

/**
 * The agents the skill can be on for. An agent that has it, or has a problem with it, gets a chip
 * with its name and status; the rest are a row of marks to turn it on with, so a dozen agents never
 * push SKILL.md out of view. Each one plans setEnabled through the sync sheet.
 */
function AgentChips({
  skill,
  agents,
  modes,
  dispatch,
}: {
  readonly skill: SkillView;
  readonly agents: readonly AgentView[];
  readonly modes: Modes;
  readonly dispatch: (event: FlowEvent) => void;
}) {
  const ids = useId();
  const cells = agents.flatMap((agent, index) => {
    const cell = skill.cells.find((candidate) => candidate.agent === agent.id);
    return cell === undefined ? [] : [{ agent, cell, wordId: `${ids}-${index}` }];
  });
  const shown = cells.filter(({ cell }) => cell.enabled || cell.verdict !== "off");
  const off = cells.filter(({ cell }) => !cell.enabled && cell.verdict === "off");
  const toggle = (agent: AgentView, enabled: boolean) =>
    dispatch({
      kind: "plan",
      intent: { kind: "setEnabled", skill: skill.name, enabled: !enabled, agents: [agent.id] },
    });
  return (
    <section
      aria-label="Agents"
      className="flex flex-col gap-2 border-t border-separator px-4 py-3"
    >
      <h3 className="flex items-baseline justify-between gap-2">
        <span className="font-semibold text-label-secondary">Agents</span>
        <span className="text-label-secondary">
          On in {skill.cells.filter((cell) => cell.enabled).length} of {agents.length}
        </span>
      </h3>
      {shown.length === 0 ? null : (
        <ul className="flex flex-wrap gap-1.5">
          {shown.map(({ agent, cell, wordId }) => (
            <li key={agent.id} data-cell={agent.id}>
              <label
                className={`flex h-7 items-center gap-1.5 rounded-full border px-2 ${cell.enabled ? "border-accent/40 bg-accent/10" : "border-separator"}`}
              >
                <Checkbox
                  checked={cell.enabled}
                  aria-label={`${skill.name} for ${agent.displayName}`}
                  aria-describedby={wordId}
                  onChange={() => toggle(agent, cell.enabled)}
                />
                <AgentLogo agent={agent.id} size={14} />
                <span className="whitespace-nowrap">{agent.displayName}</span>
                <StatusGlyph
                  verdict={cell.verdict}
                  mode={modeOf(modes, skill.name, agent.id)}
                  wordId={wordId}
                />
              </label>
            </li>
          ))}
        </ul>
      )}
      {off.length === 0 ? null : (
        <div className="flex flex-col gap-1.5">
          <span className="text-label-secondary">Turn on for</span>
          <ul className="flex flex-wrap gap-1">
            {off.map(({ agent, cell, wordId }) => (
              <li key={agent.id} data-cell={agent.id}>
                <label
                  title={agent.displayName}
                  className="relative grid size-7 place-items-center rounded-full border border-separator opacity-60 hover:opacity-100 has-focus-visible:opacity-100 has-focus-visible:outline-2 has-focus-visible:outline-offset-1 has-focus-visible:outline-focus-ring"
                >
                  {/* The whole mark is the checkbox: clear over it, so a click lands on it. */}
                  <Checkbox
                    checked={false}
                    aria-label={`${skill.name} for ${agent.displayName}`}
                    aria-describedby={wordId}
                    onChange={() => toggle(agent, cell.enabled)}
                    className="absolute inset-0 z-[1] m-0 size-full cursor-default appearance-none rounded-full border-0 bg-transparent opacity-0"
                  />
                  <AgentLogo agent={agent.id} size={14} />
                  <span className="sr-only">
                    <StatusGlyph verdict={cell.verdict} wordId={wordId} />
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/** What is wrong with the skill, a line per fix: Repair syncs it, Review goes to Discover. */
function ProblemNotes({
  skill,
  names,
  dispatch,
  onReview,
}: {
  readonly skill: SkillView;
  readonly names: Names;
  readonly dispatch: (event: FlowEvent) => void;
  readonly onReview: () => void;
}) {
  const notes = notesOf(problemsOf(skill), names);
  if (notes.length === 0) return null;
  return (
    <section
      aria-label="Problems"
      className="flex flex-col gap-2 border-t border-separator px-4 py-3"
    >
      {notes.map((note) => (
        <p
          key={note.fix}
          className={`flex items-center gap-2 rounded-md px-2.5 py-2 ${note.fix === "sync" ? "bg-change-tint" : "bg-conflict-tint"}`}
        >
          <span
            className={`min-w-0 flex-1 select-text ${note.fix === "sync" ? "text-status-change" : "text-status-conflict"}`}
          >
            {note.text}
          </span>
          {note.fix === "sync" ? (
            <Button
              size="small"
              onClick={() =>
                dispatch({ kind: "plan", intent: { kind: "sync", skills: [skill.name] } })
              }
            >
              Repair
            </Button>
          ) : (
            <Button size="small" onClick={onReview}>
              Review
            </Button>
          )}
        </p>
      ))}
    </section>
  );
}

interface SkillDetailProps {
  readonly skill: SkillView;
  /** The agents it can be turned on for. */
  readonly agents: readonly AgentView[];
  readonly modes: Modes;
  readonly flow: Flow;
  readonly names: Names;
  readonly dispatch: (event: FlowEvent) => void;
  readonly onClose: () => void;
  /** Goes to Discover, where a conflict or a folder gandalf does not manage is settled. */
  readonly onReview: () => void;
}

/** The id of the inspector's heading, which takes focus when the inspector opens after an install. */
export const SKILL_DETAIL_TITLE = "skill-detail-title";

/**
 * The inspector for the skill selected in the library: what it is, where it came from, which agents
 * have it, what is wrong with it, and its SKILL.md, which scroll together inside the panel. Its ···
 * menu holds Check for Updates and Remove, which plan through the sync sheet, and Reveal in Finder,
 * which asks main, as main shows only a library skill folder. Escape closes it, even while an
 * update is being checked; Escape again then cancels that. Only the name and the buttons sit on
 * glass; the text is on `content` below them, as the README keeps paragraphs and lists off glass.
 */
export function SkillDetail({
  skill,
  agents,
  modes,
  flow,
  names,
  dispatch,
  onClose,
  onReview,
}: SkillDetailProps) {
  const read = useSkillMd(skill);
  const [revealError, setRevealError] = useState<string | null>(null);
  const moreButton = useRef<HTMLButtonElement>(null);
  const updating =
    flow.kind === "planning" &&
    flow.intent.kind === "update" &&
    flow.intent.skills !== "all" &&
    flow.intent.skills.includes(skill.name);
  const missing = skill.hash === null;

  const reveal = async () => {
    setRevealError(null);
    const result = await invoke(() => window.gandalf.revealSkill(skill.dir));
    if (!result.ok) setRevealError("message" in result.error ? reasonOf(result.error.message) : "");
  };
  const cancel = () => {
    dispatch({ kind: "cancel" });
    // Cancel goes away with the plan, so the menu it was started from takes focus.
    moreButton.current?.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    // The menu takes its own Escape first.
    if (event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault();
    onClose();
  };

  const actions: MenuItem[] = [
    ...(skill.source?.kind === "git"
      ? [
          {
            label: "Check for Updates",
            disabled: updating,
            onSelect: () =>
              dispatch({
                kind: "plan",
                intent: { kind: "update", skills: [skill.name], pins: [] },
              }),
          },
        ]
      : []),
    { label: "Reveal in Finder", disabled: missing, onSelect: () => void reveal() },
    {
      label: "Remove from Library…",
      destructive: true,
      separated: true,
      onSelect: () => dispatch({ kind: "plan", intent: { kind: "remove", skill: skill.name } }),
    },
  ];

  return (
    <aside
      aria-labelledby={SKILL_DETAIL_TITLE}
      onKeyDown={onKeyDown}
      className="gd-glass flex h-full w-[clamp(240px,32vw,360px)] min-w-0 flex-col overflow-hidden rounded-lg"
    >
      <div className="flex flex-col gap-2 px-4 pt-4 pb-3">
        <div className="flex items-start gap-1">
          <h2
            id={SKILL_DETAIL_TITLE}
            tabIndex={-1}
            className="min-w-0 flex-1 text-title-2 break-words select-text"
          >
            {skill.name}
          </h2>
          <Menu
            ref={moreButton}
            label={`More actions for ${skill.name}`}
            icon={<HugeiconsIcon icon={MoreHorizontalIcon} size={16} aria-hidden />}
            items={actions}
          />
          <button
            type="button"
            aria-label="Close"
            title="Close"
            onClick={onClose}
            className="grid size-6 place-items-center rounded-md text-label-secondary hover:bg-glass-selection"
          >
            <HugeiconsIcon icon={Cancel01Icon} size={14} aria-hidden />
          </button>
        </div>
        {updating ? (
          <p aria-busy="true" className="flex items-center gap-2 text-callout text-label-secondary">
            <Spinner />
            <span className="flex-1">Checking for updates…</span>
            <Button size="small" onClick={cancel}>
              Cancel
            </Button>
          </p>
        ) : null}
      </div>
      {/*
       * One scroller for everything under the glass, SKILL.md with it, so in a short window the
       * facts never squeeze SKILL.md shut. Its scrolling stops at its edges.
       */}
      <div
        role="region"
        tabIndex={0}
        aria-label={`About ${skill.name}`}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain focus-visible:-outline-offset-2 border-t border-separator bg-content text-callout"
      >
        <div className="flex flex-col gap-2 px-4 py-3">
          {skill.description === null ? null : (
            <p className="text-body select-text">{skill.description}</p>
          )}
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
            <SourceFacts source={skill.source} names={names} />
            <Fact term="Library">
              <PathText wrap path={skill.dir} />
            </Fact>
            {skill.installedAt === null ? null : (
              <Fact term="Added">
                <span>{ADDED.format(new Date(skill.installedAt))}</span>
              </Fact>
            )}
          </dl>
          {revealError === null ? null : (
            <p role="alert" className="text-status-conflict select-text">
              gandalf did not show this folder in Finder
              {revealError === "" ? "" : `: it ${revealError}`}. Select the skill again to see where
              it is now.
            </p>
          )}
        </div>
        <AgentChips skill={skill} agents={agents} modes={modes} dispatch={dispatch} />
        <ProblemNotes skill={skill} names={names} dispatch={dispatch} onReview={onReview} />
        <SkillMd read={read} missing={missing} name={skill.name} />
      </div>
    </aside>
  );
}

function SkillMd({
  read,
  missing,
  name,
}: {
  readonly read: Read | null;
  readonly missing: boolean;
  readonly name: string;
}) {
  let body: ReactNode;
  if (missing) {
    body = `The library folder for ${name} is missing. Reinstall ${name} or remove it from gandalf.`;
  } else if (read === null) {
    body = "Reading SKILL.md…";
  } else if (read.kind === "refused") {
    body = `gandalf cannot show this SKILL.md${read.reason === "" ? "" : `: it ${read.reason}`}. Click Reveal in Finder to find its folder, and open it from there.`;
  }
  return (
    <section aria-label="SKILL.md" className="border-t border-separator">
      {/* The file's own name, in its own case: not a column header. */}
      <h3 className="px-4 pt-3 pb-1 font-semibold text-label-secondary">SKILL.md</h3>
      {body === undefined && read?.kind === "read" ? (
        <pre className="px-4 pb-4 font-mono text-code break-words whitespace-pre-wrap text-label select-text">
          {read.text}
        </pre>
      ) : (
        <p className="px-4 pb-4 text-label-secondary">{body}</p>
      )}
    </section>
  );
}
