import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { SkillSource, SkillView } from "@gandalf/skills";
import type { Flow, FlowEvent } from "../changes/writeFlow";
import { Button } from "../design/Button";
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

interface SkillDetailProps {
  readonly skill: SkillView;
  readonly flow: Flow;
  readonly names: Names;
  readonly dispatch: (event: FlowEvent) => void;
  readonly onClose: () => void;
}

/** The id of the inspector's heading, which takes focus when the inspector opens after an install. */
export const SKILL_DETAIL_TITLE = "skill-detail-title";

/**
 * The inspector for the skill selected in the library: what it is, where it came from, its folder,
 * and its SKILL.md, which scroll together inside the panel. Update and Remove plan through the sync sheet;
 * Reveal in Finder asks main, which shows only a library skill folder. Escape closes it, even while
 * an Update is fetching; Escape again then cancels that. Only the name and the buttons sit on
 * glass; the text is on `content` below them, as the README keeps paragraphs and lists off glass.
 */
export function SkillDetail({ skill, flow, names, dispatch, onClose }: SkillDetailProps) {
  const read = useSkillMd(skill);
  const [revealError, setRevealError] = useState<string | null>(null);
  const updateButton = useRef<HTMLButtonElement>(null);
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
    // Cancel goes away with the plan, so the button it stood beside takes focus.
    updateButton.current?.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    onClose();
  };

  return (
    <aside
      aria-labelledby={SKILL_DETAIL_TITLE}
      onKeyDown={onKeyDown}
      className="gd-glass flex h-full w-[clamp(240px,32vw,360px)] min-w-0 flex-col overflow-hidden rounded-lg"
    >
      <div className="flex flex-col gap-2 px-4 pt-4 pb-3">
        <div className="flex items-start gap-2">
          <h2
            id={SKILL_DETAIL_TITLE}
            tabIndex={-1}
            className="min-w-0 flex-1 text-title-2 break-words select-text"
          >
            {skill.name}
          </h2>
          <Button size="small" variant="borderless" onClick={onClose}>
            Close
          </Button>
        </div>
        <div className="flex flex-wrap gap-2">
          {skill.source?.kind === "git" ? (
            <>
              <Button
                ref={updateButton}
                size="small"
                aria-disabled={updating ? true : undefined}
                aria-busy={updating ? true : undefined}
                className="inline-flex items-center gap-1.5"
                onClick={() =>
                  dispatch({
                    kind: "plan",
                    intent: { kind: "update", skills: [skill.name], pins: [] },
                  })
                }
              >
                {updating ? <Spinner /> : null}
                {updating ? "Checking…" : "Update"}
              </Button>
              {updating ? (
                <Button size="small" onClick={cancel}>
                  Cancel
                </Button>
              ) : null}
            </>
          ) : null}
          <Button
            size="small"
            variant="destructive"
            onClick={() =>
              dispatch({ kind: "plan", intent: { kind: "remove", skill: skill.name } })
            }
          >
            Remove
          </Button>
          <Button size="small" disabled={missing} onClick={() => void reveal()}>
            Reveal in Finder
          </Button>
        </div>
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
