import { Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { AgentId, Snapshot } from "@gandalf/skills";
import type { MarketSkill } from "../../shared/ipc";
import type { Flow, FlowEvent } from "../changes/writeFlow";
import { AgentLogo } from "../design/AgentLogo";
import { Button } from "../design/Button";
import { Checkbox } from "../design/Checkbox";
import { SegmentedControl } from "../design/SegmentedControl";
import { Spinner } from "../design/Spinner";
import { FieldHelp, TextField } from "../design/TextField";
import { invoke } from "../invoke";
import { SettingRow, SettingsGroup, SettingsPage } from "../settings/SettingsGroup";
import { gitHubRepository, tilde, tildeAll, type Names } from "../vocabulary";
import { RepoPicker } from "./RepoPicker";
import { SkillsSh, SkillsShSearch } from "./SkillsSh";
import {
  emptyDraft,
  formProblem,
  installable,
  installIntent,
  pickedIntent,
  sourceSpec,
  skillsShIntent,
  type FieldError,
  type FieldName,
  type InstallDraft,
  type RepoListing,
  type SourceKind,
} from "./form";

const SOURCES = [
  { value: "skillsSh", label: "skills.sh" },
  { value: "folder", label: "Local Folder" },
  { value: "git", label: "Git Repository" },
] as const satisfies readonly { readonly value: SourceKind; readonly label: string }[];

const SOURCE_HINT = "Browse skills.sh, or install from a folder or a git repository.";

/** What the toolbar says beside Install: the source the screen shows. */
export function installSubtitle(state: InstallState, names: Names): string {
  const { draft, repo } = state;
  if (draft.source === "skillsSh") return "Browse skills.sh";
  if (draft.source === "git" && repo.kind === "ready") {
    return `From ${gitHubRepository(repo.url) ?? tilde(repo.url, names)}`;
  }
  return "Add a skill to the library";
}

interface FieldRowProps {
  readonly label: string;
  /** The id of the field the label names. */
  readonly htmlFor: string;
  readonly children: ReactNode;
  readonly help?: ReactNode;
}

/** A field in a group: its name, the control the width of the row, and its help under it. */
function FieldRow({ label, htmlFor, children, help }: FieldRowProps) {
  return (
    <li className="flex flex-col gap-1.5 px-3.5 py-2.5">
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {help}
    </li>
  );
}

/** An agent to link into, as a chip: tinted with a check while it is chosen. */
function AgentChip({
  agent,
  name,
  checked,
  onChange,
}: {
  readonly agent: AgentId;
  readonly name: string;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
}) {
  return (
    <label
      className={`relative flex h-6 items-center gap-1 rounded-full border px-2 text-callout has-focus-visible:outline-2 has-focus-visible:outline-offset-1 has-focus-visible:outline-focus-ring ${checked ? "border-accent/45 bg-accent/12" : "border-separator text-label-secondary"}`}
    >
      <Checkbox
        checked={checked}
        aria-label={name}
        onChange={(event) => onChange(event.target.checked)}
        className="absolute inset-0 z-[1] m-0 size-full cursor-default appearance-none rounded-full border-0 bg-transparent opacity-0"
      />
      <AgentLogo agent={agent} size={14} className={checked ? "" : "opacity-50"} />
      <span className="whitespace-nowrap">{name}</span>
      {checked ? (
        <HugeiconsIcon icon={Tick02Icon} size={12} className="text-accent" aria-hidden />
      ) : null}
    </label>
  );
}

/** The agents a new skill links into, as chips, with the help or the error under them. */
export function AgentsGroup({
  id,
  names,
  chosen,
  onToggle,
  help,
}: {
  /** The fieldset's id, which takes focus when no agent is chosen. */
  readonly id: string;
  readonly names: Names;
  readonly chosen: readonly AgentId[];
  readonly onToggle: (agent: AgentId, on: boolean) => void;
  readonly help: ReactNode;
}) {
  return (
    <SettingsGroup title="Link into" label="Agents to link into">
      <li className="flex flex-col gap-2 px-3.5 py-2.5">
        <fieldset
          id={id}
          tabIndex={-1}
          aria-label="Link into"
          aria-describedby={`${id}-help`}
          className="flex flex-wrap gap-1.5"
        >
          {names.installed.map((agent) => (
            <AgentChip
              key={agent}
              agent={agent}
              name={names.agent(agent)}
              checked={chosen.includes(agent)}
              onChange={(on) => onToggle(agent, on)}
            />
          ))}
        </fieldset>
        {help}
      </li>
    </SettingsGroup>
  );
}

/**
 * The form as the user left it, kept by App so a visit to another screen loses nothing: the draft,
 * the field the form refused before planning, why the folder panel did not open, and the failed
 * plan whose field has taken focus already.
 */
export interface InstallState {
  readonly draft: InstallDraft;
  readonly invalid: FieldError | null;
  readonly panelError: string | null;
  readonly focused: Flow | null;
  /** The skills found in the repository Git Repository names, once Find Skills was clicked. */
  readonly repo: RepoListing;
}

export function emptyInstall(installed: readonly AgentId[]): InstallState {
  return {
    draft: emptyDraft(installed),
    invalid: null,
    panelError: null,
    focused: null,
    repo: { kind: "none" },
  };
}

interface InstallProps {
  readonly snapshot: Snapshot;
  readonly flow: Flow;
  readonly names: Names;
  readonly dispatch: (event: FlowEvent) => void;
  readonly state: InstallState;
  readonly onState: (update: (state: InstallState) => InstallState) => void;
}

/**
 * Installs a skill from a folder or a git repository into the library and the agents checked. The
 * plan opens in the sync sheet. A source gandalf cannot use is said on its field instead, which
 * takes focus, and the form stays as typed, so fixing it and clicking Install again is all it
 * takes. While the plan runs, Cancel (or Escape, which App handles) drops it.
 */
export function Install({ snapshot, flow, names, dispatch, state, onState }: InstallProps) {
  const ids = useId();
  const submitButton = useRef<HTMLButtonElement>(null);
  /** True while the folder panel is open, so a second click does not queue another. */
  const [choosing, setChoosing] = useState(false);
  const choosingNow = useRef(false);
  const { draft, invalid, panelError, repo } = state;
  /** Counts lookups, so an answer to one the user has moved on from is dropped. */
  const lookup = useRef(0);
  const problem = formProblem(flow);
  const shown: FieldError | null = invalid ?? problem;
  const planning = flow.kind === "planning" && flow.intent.kind === "install" ? flow.intent : null;
  // An installed agent the form cannot show, because its folder cannot be read.
  const hidden = snapshot.agents.some((agent) => agent.installed && agent.readError !== null);
  const focusField = (name: FieldName) => document.getElementById(`${ids}-${name}`)?.focus();

  // A failure from planning lands on its field once, also when it landed while another screen
  // showed, but not again on each return to the form.
  const focused = state.focused;
  useEffect(() => {
    const field = formProblem(flow)?.field;
    if (field === undefined || focused === flow) return;
    document.getElementById(`${ids}-${field}`)?.focus();
    onState((current) => ({ ...current, focused: flow }));
  }, [flow, focused, ids, onState]);

  const edit = (fields: Partial<InstallDraft>) => {
    onState((current) => ({ ...current, draft: { ...current.draft, ...fields }, invalid: null }));
    // The failure the form shows is about the old value; editing clears it.
    if (problem !== null) dispatch({ kind: "cancel" });
  };
  const errorOf = (field: FieldName) => (shown?.field === field ? shown.message : null);
  const field = (name: FieldName) => ({
    id: `${ids}-${name}`,
    "aria-invalid": errorOf(name) === null ? undefined : true,
    "aria-describedby": `${ids}-${name}-help`,
  });
  const help = (name: FieldName, text: string | null) => (
    <>
      <FieldHelp id={`${ids}-${name}-help`} error={errorOf(name)} help={text} />
      {problem?.field === name && problem.detail !== null ? (
        <span className="font-mono text-path whitespace-pre-wrap text-label-secondary select-text">
          {tildeAll(problem.detail, names)}
        </span>
      ) : null}
    </>
  );

  /** Editing the repository or its ref drops the skills found for the old one. */
  const editRepository = (fields: Pick<Partial<InstallDraft>, "url" | "ref">) => {
    lookup.current += 1;
    onState((current) => ({ ...current, repo: { kind: "none" } }));
    edit(fields);
  };

  const findSkills = async () => {
    if (repo.kind === "loading") return;
    const spec = sourceSpec({ ...draft, source: "git", subpath: "" }, names.home);
    if (!spec.ok) {
      onState((current) => ({ ...current, invalid: spec }));
      focusField(spec.field);
      return;
    }
    if (spec.value.kind !== "git") return;
    const { url, ref } = spec.value;
    const asked = ++lookup.current;
    onState((current) => ({ ...current, invalid: null, repo: { kind: "loading", url, ref } }));
    const result = await invoke(() => window.gandalf.repoSkills({ url, ref }));
    if (asked !== lookup.current) return;
    let next: RepoListing;
    if (!result.ok) {
      const message = "message" in result.error ? result.error.message : result.error.kind;
      next = {
        kind: "failed",
        url,
        ref,
        message: "gandalf could not fetch this repository.",
        detail: message,
      };
    } else if (!result.value.ok) {
      const { error } = result.value;
      next = {
        kind: "failed",
        url,
        ref,
        message: "gandalf could not fetch this repository. Check the URL and the branch or tag.",
        detail: error.kind === "badSource" ? error.reason : error.kind,
      };
    } else {
      const ready = {
        kind: "ready",
        url,
        ref,
        commit: result.value.commit,
        skills: result.value.skills,
        chosen: [],
      } as const;
      next = { ...ready, chosen: installable(ready, snapshot) };
    }
    onState((current) => ({ ...current, repo: next }));
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    // Return in the skills.sh search submits nothing: each row has its own Install.
    if (planning !== null || draft.source === "skillsSh" || repo.kind === "loading") return;
    const built =
      draft.source === "git" && repo.kind === "ready"
        ? pickedIntent(repo, draft, names.installed, hidden)
        : installIntent(draft, names.installed, names.home, hidden);
    if (!built.ok) {
      onState((current) => ({ ...current, invalid: built }));
      focusField(built.field);
      return;
    }
    dispatch({ kind: "plan", intent: built.value });
  };

  const cancel = () => {
    dispatch({ kind: "cancel" });
    // Cancel goes away with the plan, so the button it stood beside takes focus.
    submitButton.current?.focus();
  };

  const chooseFolder = async () => {
    if (choosingNow.current) return;
    choosingNow.current = true;
    setChoosing(true);
    onState((current) => ({ ...current, panelError: null }));
    const result = await invoke(() => window.gandalf.chooseFolder());
    choosingNow.current = false;
    setChoosing(false);
    if (!result.ok) {
      const panel = "message" in result.error ? result.error.message : "";
      onState((current) => ({ ...current, panelError: panel }));
    } else if (result.value !== null) {
      const shown = tilde(result.value, names);
      edit({ folder: shown, chosen: { shown, path: result.value } });
    }
  };

  const toggleAgent = (agent: AgentId, on: boolean) =>
    edit({
      agents: on ? [...draft.agents, agent] : draft.agents.filter((other) => other !== agent),
    });

  const agentsHelp =
    names.installed.length === 0
      ? "gandalf found no agents. The skill goes into the library, and agents you install later get it."
      : hidden
        ? "Agents whose folder gandalf cannot read are not listed and do not get it."
        : draft.source === "skillsSh"
          ? "Each skill you install from skills.sh is linked into these agents."
          : `gandalf links the ${draft.source === "git" && repo.kind === "ready" ? "chosen skills" : "skill"} into each agent you pick. You can change this later in the Library.`;

  const pickedCount =
    repo.kind === "ready"
      ? installable(repo, snapshot).filter((name) => repo.chosen.includes(name)).length
      : 0;

  const agentsGroup = (
    <AgentsGroup
      id={`${ids}-agents`}
      names={names}
      chosen={draft.agents}
      onToggle={toggleAgent}
      help={help("agents", agentsHelp)}
    />
  );

  /** A skills.sh row's install, or null after Link into took focus to say no agent is chosen. */
  const intentFor = (skill: MarketSkill) => {
    const built = skillsShIntent(skill, draft, names.installed, hidden);
    if (built.ok) return built.value;
    onState((current) => ({ ...current, invalid: built }));
    focusField(built.field);
    return null;
  };

  return (
    <SettingsPage>
      <form
        noValidate
        onSubmit={submit}
        aria-label="Install a skill"
        className="flex flex-col gap-4"
      >
        <SettingsGroup title="Source" label="Where the skill comes from">
          <SettingRow label="Source" hint={SOURCE_HINT}>
            <SegmentedControl
              label="Source"
              segments={SOURCES}
              value={draft.source}
              onChange={(source) => edit({ source })}
            />
          </SettingRow>
          {draft.source === "skillsSh" ? (
            <li className="flex px-3.5 py-2.5">
              <SkillsShSearch
                query={draft.query}
                onQuery={(query) =>
                  onState((current) => ({ ...current, draft: { ...current.draft, query } }))
                }
              />
            </li>
          ) : null}
        </SettingsGroup>
        {draft.source === "skillsSh" ? (
          <>
            {agentsGroup}
            <SkillsSh
              snapshot={snapshot}
              flow={flow}
              dispatch={dispatch}
              query={draft.query}
              board={draft.board}
              onBoard={(board) =>
                onState((current) => ({ ...current, draft: { ...current.draft, board } }))
              }
              intentFor={intentFor}
            />
          </>
        ) : draft.source === "folder" ? (
          <SettingsGroup title="Local folder" label="Local folder fields">
            <FieldRow
              label="Folder"
              htmlFor={`${ids}-folder`}
              help={
                <>
                  {help(
                    "folder",
                    "gandalf copies this folder into the library. The folder itself stays as it is.",
                  )}
                  {panelError === null ? null : (
                    <span role="alert" className="text-callout text-status-conflict select-text">
                      The folder panel did not open{panelError === "" ? "" : ` (${panelError})`}.
                      Type the folder&apos;s path instead.
                    </span>
                  )}
                </>
              }
            >
              <span className="flex min-w-0 gap-2">
                <TextField
                  mono
                  {...field("folder")}
                  className="flex-1"
                  placeholder="~/skills/pdf-tools"
                  value={draft.folder}
                  onChange={(event) => edit({ folder: event.target.value })}
                />
                <Button
                  aria-disabled={choosing ? true : undefined}
                  onClick={() => void chooseFolder()}
                >
                  Choose…
                </Button>
              </span>
            </FieldRow>
          </SettingsGroup>
        ) : (
          <SettingsGroup title="Git repository" label="Git repository fields">
            <FieldRow
              label="Repository"
              htmlFor={`${ids}-url`}
              help={help("url", "gandalf fetches it into its cache, then copies the skill.")}
            >
              <span className="flex min-w-0 gap-2">
                <TextField
                  mono
                  {...field("url")}
                  className="flex-1"
                  placeholder="https://github.com/acme/skills.git"
                  value={draft.url}
                  onChange={(event) => editRepository({ url: event.target.value })}
                />
                <Button
                  aria-disabled={repo.kind === "loading" ? true : undefined}
                  aria-busy={repo.kind === "loading" ? true : undefined}
                  className="inline-flex items-center gap-2"
                  onClick={() => void findSkills()}
                >
                  {repo.kind === "loading" ? <Spinner /> : null}
                  {repo.kind === "loading"
                    ? "Looking…"
                    : repo.kind === "ready"
                      ? "Look Again"
                      : "Find Skills"}
                </Button>
              </span>
              {repo.kind === "failed" ? (
                <span
                  role="alert"
                  className="flex flex-col text-callout text-status-conflict select-text"
                >
                  {repo.message}
                  {repo.detail === null ? null : (
                    <span className="font-mono text-path whitespace-pre-wrap text-label-secondary">
                      {tildeAll(repo.detail, names)}
                    </span>
                  )}
                </span>
              ) : null}
            </FieldRow>
            <FieldRow
              label="Branch or tag"
              htmlFor={`${ids}-ref`}
              help={help("ref", "Leave it empty for the default branch.")}
            >
              <TextField
                mono
                {...field("ref")}
                placeholder="main"
                value={draft.ref}
                onChange={(event) => editRepository({ ref: event.target.value })}
              />
            </FieldRow>
            {repo.kind === "ready" ? null : (
              <FieldRow
                label="Folder"
                htmlFor={`${ids}-subpath`}
                help={help(
                  "subpath",
                  "Leave it empty when SKILL.md is at the top of the repository.",
                )}
              >
                <TextField
                  mono
                  {...field("subpath")}
                  placeholder="skills/pdf-tools"
                  value={draft.subpath}
                  onChange={(event) => edit({ subpath: event.target.value })}
                />
              </FieldRow>
            )}
          </SettingsGroup>
        )}
        {draft.source === "git" && repo.kind === "ready" ? (
          <RepoPicker
            listing={repo}
            snapshot={snapshot}
            id={`${ids}-skills`}
            onChosen={(chosen) => {
              onState((current) =>
                current.repo.kind === "ready"
                  ? { ...current, invalid: null, repo: { ...current.repo, chosen } }
                  : current,
              );
            }}
            help={help("skills", null)}
          />
        ) : null}
        {draft.source === "skillsSh" ? null : (
          <>
            {agentsGroup}
            <div className="flex justify-end gap-2">
              {planning === null ? null : <Button onClick={cancel}>Cancel</Button>}
              <Button
                ref={submitButton}
                type="submit"
                variant="primary"
                aria-disabled={planning === null ? undefined : true}
                aria-busy={planning === null ? undefined : true}
                className="inline-flex items-center gap-2"
              >
                {planning === null ? null : <Spinner />}
                {/* Named for the plan running, not the segment shown, which may have changed since. */}
                {planning === null
                  ? draft.source === "git" && repo.kind === "ready"
                    ? `Install ${pickedCount} ${pickedCount === 1 ? "Skill" : "Skills"}`
                    : "Install"
                  : planning.source.kind === "git"
                    ? "Fetching…"
                    : "Checking…"}
              </Button>
            </div>
          </>
        )}
      </form>
    </SettingsPage>
  );
}
