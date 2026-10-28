import {
  Alert02Icon,
  ArrowReloadHorizontalIcon,
  Cancel01Icon,
  Delete02Icon,
  Folder01Icon,
  MoreHorizontalIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { AgentView, Entry, SkillSource, SkillView } from "@gandalf/skills";
import type { Flow, FlowEvent } from "../changes/writeFlow";
import { AgentLogo } from "../design/AgentLogo";
import { Button } from "../design/Button";
import { Checkbox } from "../design/Checkbox";
import { Menu, type MenuItem } from "../design/Menu";
import { modeOf, type Modes } from "../library/modes";
import { FIX, notesOf, problemsOf, type Fix } from "../library/problems";
import { StatusGlyph } from "../library/StatusGlyph";
import { PathText } from "../design/PathText";
import { Spinner } from "../design/Spinner";
import { invoke } from "../invoke";
import { conflictReason, tilde, type Names } from "../vocabulary";

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

/** A chip's look: on, off, or the ink of the problem it has there. */
const CHIP = {
  on: "border-accent/45 bg-accent/12",
  off: "border-separator text-label-secondary",
  sync: "border-status-change text-label",
  review: "border-status-conflict text-label",
} as const;

const PROBLEM_INK: Readonly<Record<Fix, string>> = {
  sync: "text-status-change",
  review: "text-status-conflict",
};

/** The checkbox a chip or mark is, laid clear over it so a click anywhere on it lands there. */
function ChipCheckbox({
  label,
  wordId,
  checked,
  onToggle,
}: {
  readonly label: string;
  readonly wordId: string;
  readonly checked: boolean;
  readonly onToggle: () => void;
}) {
  return (
    <Checkbox
      checked={checked}
      aria-label={label}
      aria-describedby={wordId}
      onChange={onToggle}
      className="absolute inset-0 z-[1] m-0 size-full cursor-default appearance-none rounded-full border-0 bg-transparent opacity-0"
    />
  );
}

const FOCUS =
  "has-focus-visible:outline-2 has-focus-visible:outline-offset-1 has-focus-visible:outline-focus-ring";

/**
 * The agents the skill can be on for. An agent that has it, or has a problem with it, gets a chip:
 * tinted with a check when it is on, edged in the problem's ink with a warning when something is
 * wrong there. The rest are a row of marks to turn it on with, so a dozen agents never push SKILL.md
 * out of view. Each one is a checkbox, and plans setEnabled through the sync sheet.
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
  const toggle = (agent: AgentView, enabled: boolean) => () =>
    dispatch({
      kind: "plan",
      intent: { kind: "setEnabled", skill: skill.name, enabled: !enabled, agents: [agent.id] },
    });
  return (
    <section aria-label="Agents" className="flex flex-col gap-2 px-4 pb-3">
      <h3 className="flex items-baseline justify-between gap-2 text-subheadline text-label-secondary">
        <span>Agents</span>
        <span className="font-normal">
          On in {skill.cells.filter((cell) => cell.enabled).length} of {agents.length}
        </span>
      </h3>
      {shown.length === 0 ? null : (
        <ul className="flex flex-wrap gap-1.5">
          {shown.map(({ agent, cell, wordId }) => {
            const fix = FIX[cell.verdict];
            const look = fix ?? (cell.enabled ? "on" : "off");
            return (
              <li key={agent.id} data-cell={agent.id}>
                <label
                  className={`relative flex h-6 items-center gap-1 rounded-full border px-2 text-callout ${CHIP[look]} ${FOCUS}`}
                >
                  <ChipCheckbox
                    label={`${skill.name} for ${agent.displayName}`}
                    wordId={wordId}
                    checked={cell.enabled}
                    onToggle={toggle(agent, cell.enabled)}
                  />
                  <AgentLogo
                    agent={agent.id}
                    size={14}
                    className={cell.enabled ? "" : "opacity-50"}
                  />
                  <span className="whitespace-nowrap">{agent.displayName}</span>
                  {fix === undefined ? (
                    cell.enabled ? (
                      <HugeiconsIcon
                        icon={Tick02Icon}
                        size={12}
                        className="text-accent"
                        aria-hidden
                      />
                    ) : null
                  ) : (
                    <HugeiconsIcon
                      icon={Alert02Icon}
                      size={12}
                      className={PROBLEM_INK[fix]}
                      aria-hidden
                    />
                  )}
                  <span className="sr-only">
                    <StatusGlyph
                      verdict={cell.verdict}
                      mode={modeOf(modes, skill.name, agent.id)}
                      wordId={wordId}
                    />
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
      {off.length === 0 ? null : (
        <div className="flex flex-col gap-1.5">
          <span className="text-callout text-label-secondary">Turn on for</span>
          <ul className="flex flex-wrap gap-1">
            {off.map(({ agent, cell, wordId }) => (
              <li key={agent.id} data-cell={agent.id}>
                <label
                  title={agent.displayName}
                  className={`relative grid size-6 place-items-center rounded-full border border-separator opacity-60 hover:opacity-100 has-focus-visible:opacity-100 ${FOCUS}`}
                >
                  <ChipCheckbox
                    label={`${skill.name} for ${agent.displayName}`}
                    wordId={wordId}
                    checked={false}
                    onToggle={toggle(agent, cell.enabled)}
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

const NOTE = {
  sync: "bg-change-tint text-status-change",
  review: "bg-conflict-tint text-status-conflict",
} as const;

/** "Repair", or "Repair Both" and "Repair All" when one Sync fixes it in more than one agent. */
function repairLabel(agents: number): string {
  if (agents === 2) return "Repair Both";
  return agents > 2 ? "Repair All" : "Repair";
}

/**
 * What is wrong with the skill, a line per fix: Repair syncs it, and Replace… trades the skill
 * folders you placed in its slots for the library's. What Replace leaves, such as a link you made,
 * says why gandalf leaves it.
 */
function ProblemNotes({
  skill,
  conflicts,
  names,
  dispatch,
}: {
  readonly skill: SkillView;
  readonly conflicts: readonly Entry[];
  readonly names: Names;
  readonly dispatch: (event: FlowEvent) => void;
}) {
  const problems = problemsOf(skill);
  const notes = notesOf(problems, names);
  if (notes.length === 0) return null;
  const syncs = problems.filter((problem) => problem.fix === "sync").length;
  const replaceable = conflicts.some((entry) => entry.observed.kind === "skillDir");
  const left = [
    ...new Set(
      conflicts
        .filter((entry) => entry.observed.kind !== "skillDir")
        .map((entry) => conflictReason(entry.observed, names)),
    ),
  ];
  return (
    <section aria-label="Problems" className="flex flex-col gap-1.5 px-4 pb-3">
      {notes.map((note) => (
        <p
          key={note.fix}
          className={`flex items-center gap-2 rounded-md px-2.5 py-1.5 text-callout ${NOTE[note.fix]}`}
        >
          <HugeiconsIcon icon={Alert02Icon} size={14} className="flex-none" aria-hidden />
          <span className="min-w-0 flex-1 text-label select-text">{note.text}</span>
          {note.fix === "review" && !replaceable ? null : (
            <button
              type="button"
              onClick={() =>
                dispatch({
                  kind: "plan",
                  intent:
                    note.fix === "sync"
                      ? { kind: "sync", skills: [skill.name] }
                      : { kind: "replace", skill: skill.name },
                })
              }
              className="flex-none rounded-sm px-1 font-semibold hover:underline"
            >
              {note.fix === "sync" ? repairLabel(syncs) : "Replace…"}
            </button>
          )}
        </p>
      ))}
      {replaceable ? (
        <p className="text-label-secondary">
          gandalf never writes over a folder it did not put there. Replace moves yours to the Trash
          and links the library&apos;s {skill.name} in its place.
        </p>
      ) : null}
      {left.map((reason) => (
        <p key={reason} className="text-label-secondary">
          {reason}
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
  /** What sits in the skill's slots that gandalf did not put there. */
  readonly conflicts: readonly Entry[];
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
  conflicts,
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
    // A skill installed from git or a folder has a source to check; one adopted or enabled straight
    // from the library has none.
    ...(skill.source?.kind === "git" ||
    (skill.source?.kind === "local" && skill.source.path !== null)
      ? [
          {
            label: "Check for Updates",
            icon: <HugeiconsIcon icon={ArrowReloadHorizontalIcon} size={16} />,
            disabled: updating,
            onSelect: () =>
              dispatch({
                kind: "plan",
                intent: { kind: "update", skills: [skill.name], pins: [] },
              }),
          },
        ]
      : []),
    {
      label: "Reveal in Finder",
      icon: <HugeiconsIcon icon={Folder01Icon} size={16} />,
      disabled: missing,
      onSelect: () => void reveal(),
    },
    {
      label: "Remove from Library…",
      icon: <HugeiconsIcon icon={Delete02Icon} size={16} />,
      destructive: true,
      separated: true,
      onSelect: () => dispatch({ kind: "plan", intent: { kind: "remove", skill: skill.name } }),
    },
  ];

  return (
    <aside
      aria-labelledby={SKILL_DETAIL_TITLE}
      onKeyDown={onKeyDown}
      className="gd-glass-flush flex h-full w-[clamp(240px,32vw,360px)] min-w-0 flex-col overflow-hidden"
    >
      <div className="flex flex-col gap-2 px-4 pt-4 pb-2">
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
            face={{ icon: <HugeiconsIcon icon={MoreHorizontalIcon} size={16} aria-hidden /> }}
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
       * One scroller for everything under the name, SKILL.md with it, so in a short window the
       * facts never squeeze SKILL.md shut. Its scrolling stops at its edges. What the skill is and
       * which agents have it sit on the glass; SKILL.md, the one long text, is on content.
       */}
      <div
        role="region"
        tabIndex={0}
        aria-label={`About ${skill.name}`}
        className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain text-callout focus-visible:-outline-offset-2"
      >
        <div className="flex flex-col gap-2 px-4 pb-3">
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
        <ProblemNotes skill={skill} conflicts={conflicts} names={names} dispatch={dispatch} />
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
    <section aria-label="SKILL.md" className="flex-1 border-t border-separator bg-content">
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
