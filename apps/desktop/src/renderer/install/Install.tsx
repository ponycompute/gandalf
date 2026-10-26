import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { AgentId, Snapshot } from "@gandalf/skills";
import type { Flow, FlowEvent } from "../changes/writeFlow";
import { AgentLogo } from "../design/AgentLogo";
import { Button } from "../design/Button";
import { Checkbox } from "../design/Checkbox";
import { SegmentedControl } from "../design/SegmentedControl";
import { Spinner } from "../design/Spinner";
import { FieldHelp, TextField } from "../design/TextField";
import { invoke } from "../invoke";
import { tilde, tildeAll, type Names } from "../vocabulary";
import {
  emptyDraft,
  formProblem,
  installIntent,
  type FieldError,
  type FieldName,
  type InstallDraft,
  type SourceKind,
} from "./form";

const SOURCES = [
  { value: "folder", label: "Local Folder" },
  { value: "git", label: "Git Repository" },
] as const satisfies readonly { readonly value: SourceKind; readonly label: string }[];

interface RowProps {
  readonly label: string;
  /** The id of the field the label names; omit for a group that names itself. */
  readonly htmlFor?: string;
  readonly children: ReactNode;
  readonly help?: ReactNode;
}

const LABEL = "self-start pt-1 text-right";

/** A label to the left in a 96px column, the control, and its help under it. */
function Row({ label, htmlFor, children, help }: RowProps) {
  return (
    <>
      {htmlFor === undefined ? (
        <span aria-hidden="true" className={LABEL}>
          {label}
        </span>
      ) : (
        <label htmlFor={htmlFor} className={LABEL}>
          {label}
        </label>
      )}
      <div className="flex min-w-0 flex-col gap-1">
        {children}
        {help}
      </div>
    </>
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
}

export function emptyInstall(installed: readonly AgentId[]): InstallState {
  return { draft: emptyDraft(installed), invalid: null, panelError: null, focused: null };
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
  const { draft, invalid, panelError } = state;
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

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (planning !== null) return;
    const built = installIntent(draft, names.installed, names.home, hidden);
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

  return (
    <form noValidate onSubmit={submit} aria-label="Install a skill" className="max-w-[640px] p-5">
      <div className="grid grid-cols-[96px_minmax(0,1fr)] items-center gap-x-3 gap-y-2">
        <Row label="Source">
          <span>
            <SegmentedControl
              label="Source"
              segments={SOURCES}
              value={draft.source}
              onChange={(source) => edit({ source })}
            />
          </span>
        </Row>
        {draft.source === "folder" ? (
          <Row
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
                    The folder panel did not open{panelError === "" ? "" : ` (${panelError})`}. Type
                    the folder&apos;s path instead.
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
          </Row>
        ) : (
          <>
            <Row
              label="Repository"
              htmlFor={`${ids}-url`}
              help={help("url", "gandalf fetches it into its cache, then copies the skill.")}
            >
              <TextField
                mono
                {...field("url")}
                placeholder="https://github.com/acme/skills.git"
                value={draft.url}
                onChange={(event) => edit({ url: event.target.value })}
              />
            </Row>
            <Row
              label="Branch or tag"
              htmlFor={`${ids}-ref`}
              help={help("ref", "Leave it empty for the default branch.")}
            >
              <TextField
                mono
                {...field("ref")}
                placeholder="main"
                value={draft.ref}
                onChange={(event) => edit({ ref: event.target.value })}
              />
            </Row>
            <Row
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
            </Row>
          </>
        )}
        <Row
          label="Link into"
          help={help(
            "agents",
            names.installed.length === 0
              ? "gandalf found no agents. The skill goes into the library, and agents you install later get it."
              : hidden
                ? "Agents whose folder gandalf cannot read are not listed and do not get it."
                : "With every agent checked, agents you install later get it too.",
          )}
        >
          <fieldset
            id={`${ids}-agents`}
            tabIndex={-1}
            aria-label="Link into"
            aria-describedby={`${ids}-agents-help`}
            className="flex flex-col gap-1 pt-1"
          >
            {names.installed.map((agent) => (
              <label key={agent} className="flex items-center gap-2">
                <Checkbox
                  checked={draft.agents.includes(agent)}
                  onChange={(event) => toggleAgent(agent, event.target.checked)}
                />
                <AgentLogo agent={agent} size={16} />
                {names.agent(agent)}
              </label>
            ))}
          </fieldset>
        </Row>
      </div>
      <div className="flex justify-end gap-2 pt-4">
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
            ? "Install"
            : planning.source.kind === "git"
              ? "Fetching…"
              : "Checking…"}
        </Button>
      </div>
    </form>
  );
}
