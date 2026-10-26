import { Alert02Icon, ArrowDown01Icon, ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useId, useMemo, useState } from "react";
import type { Intent, ModeSetting, Snapshot } from "@gandalf/skills";
import { AppliedSummary } from "../changes/AppliedSummary";
import type { Flow, FlowEvent } from "../changes/writeFlow";
import { AgentLogo } from "../design/AgentLogo";
import { Button } from "../design/Button";
import { PathText } from "../design/PathText";
import { SegmentedControl } from "../design/SegmentedControl";
import { invoke } from "../invoke";
import { SettingsGroup, SettingsPage } from "../settings/SettingsGroup";
import { agentReadError, gandalfDir, tilde, type Names } from "../vocabulary";
import {
  agentRows,
  configure,
  hasCustomFolder,
  insideGandalf,
  MODE_HINT,
  MODE_SEGMENTS,
  readersLine,
  skillsOn,
  type AgentRow,
  type ReadFolder,
} from "./model";

interface AgentsProps {
  readonly snapshot: Snapshot;
  readonly flow: Flow;
  readonly names: Names;
  readonly dispatch: (event: FlowEvent) => void;
}

function Folder({ folder, names }: { readonly folder: ReadFolder; readonly names: Names }) {
  const readers = readersLine(folder, names);
  return (
    <span className="flex min-w-0 flex-col">
      <PathText wrap path={folder.path} />
      {readers === null ? null : (
        <span className="text-callout text-label-secondary">{readers}</span>
      )}
    </span>
  );
}

interface RowProps {
  readonly row: AgentRow;
  readonly skills: number;
  readonly names: Names;
  readonly plan: (intent: Intent) => void;
}

/**
 * An installed agent: one line with its folder and how many skills it has, which opens to the
 * folder, the mode and what else it reads. A folder it cannot read opens on its own, to say why.
 */
function InstalledRow({ row, skills, names, plan }: RowProps) {
  const { agent } = row;
  const [open, setOpen] = useState(agent.readError !== null);
  const [folderError, setFolderError] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);
  const custom = hasCustomFolder(agent);
  const details = useId();

  const changeFolder = async () => {
    if (choosing) return;
    setChoosing(true);
    setFolderError(null);
    const result = await invoke(() => window.gandalf.chooseFolder());
    setChoosing(false);
    if (!result.ok) {
      const reason = "message" in result.error ? `: ${result.error.message}` : "";
      setFolderError(`gandalf could not show the folder panel${reason}. Try again.`);
      return;
    }
    if (result.value === null) return;
    // Compared as shown, so a /var or /private/var spelling of HOME both come out as ~. The core
    // guards a symlink into ~/.gandalf too: the folder then shows its read error.
    const chosen = tilde(result.value, names);
    const gandalf = tilde(gandalfDir(names), names);
    if (insideGandalf(chosen, gandalf)) {
      setFolderError(
        `${chosen} is inside ${gandalf}, where gandalf keeps the library. Choose a folder outside it.`,
      );
      return;
    }
    plan(configure(agent, { skillsDir: result.value }));
  };

  return (
    <li data-agent={agent.id} aria-label={agent.displayName}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={details}
        onClick={() => setOpen((current) => !current)}
        className="flex w-full items-center gap-3 px-3.5 py-2.5 text-left focus-visible:-outline-offset-2"
      >
        <AgentLogo agent={agent.id} size={24} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="font-semibold">{agent.displayName}</span>
          <PathText wrap path={row.skillsFolder.path} />
        </span>
        {custom ? (
          <span className="rounded-sm bg-accent/15 px-1.5 text-subheadline text-accent">
            Custom
          </span>
        ) : null}
        {agent.readError === null ? (
          <span className="text-callout whitespace-nowrap text-label-secondary">
            {skills} {skills === 1 ? "skill" : "skills"}
          </span>
        ) : (
          <HugeiconsIcon
            icon={Alert02Icon}
            size={14}
            className="text-status-conflict"
            aria-hidden
          />
        )}
        <HugeiconsIcon
          icon={open ? ArrowDown01Icon : ArrowRight01Icon}
          aria-hidden
          size={14}
          className="text-label-secondary"
        />
      </button>
      <div id={details} hidden={!open} className="flex flex-col gap-2 pr-3.5 pb-3.5 pl-[50px]">
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-3 gap-y-2 text-callout">
          <dt className="text-label-secondary">Skills folder</dt>
          <dd className="flex min-w-0 flex-col gap-1.5">
            <Folder folder={row.skillsFolder} names={names} />
            <span className="flex flex-wrap items-center gap-2">
              <Button
                size="small"
                aria-label={`Change Folder for ${agent.displayName}`}
                aria-busy={choosing ? true : undefined}
                onClick={() => void changeFolder()}
              >
                Change Folder…
              </Button>
              {agent.overridden ? (
                <Button
                  size="small"
                  aria-label={`Reset ${agent.displayName}`}
                  onClick={() => plan(configure(agent, "reset"))}
                >
                  Reset
                </Button>
              ) : null}
            </span>
          </dd>
          {custom ? (
            <>
              <dt className="text-label-secondary">Default folder</dt>
              <dd className="min-w-0">
                <PathText wrap path={agent.builtInSkillsDir} />
              </dd>
            </>
          ) : null}
          <dt className="text-label-secondary">Put skills by</dt>
          <dd className="flex min-w-0 flex-col gap-1">
            <span>
              <SegmentedControl<ModeSetting>
                label={`How gandalf puts skills in ${agent.displayName}'s folder`}
                segments={MODE_SEGMENTS}
                value={agent.mode}
                onChange={(mode) => {
                  if (mode !== agent.mode) plan(configure(agent, { mode }));
                }}
              />
            </span>
            {/* Auto is every agent's default, so only a chosen mode says what it does. */}
            {agent.mode === "auto" ? null : (
              <span className="text-label-secondary">{MODE_HINT[agent.mode]}</span>
            )}
          </dd>
          {row.scanFolders.length === 0 ? null : (
            <>
              <dt className="text-label-secondary">Also reads</dt>
              <dd className="flex min-w-0 flex-col gap-1">
                {row.scanFolders.map((folder) => (
                  <Folder key={folder.path} folder={folder} names={names} />
                ))}
              </dd>
            </>
          )}
        </dl>
        {agent.readError === null ? null : (
          <p className="text-callout text-status-conflict select-text">
            {agentReadError(agent.readError, names)}
          </p>
        )}
        {folderError === null ? null : (
          <p role="alert" className="text-callout text-status-conflict select-text">
            {folderError}
          </p>
        )}
      </div>
    </li>
  );
}

/** An agent gandalf found no sign of: nothing to change until it is installed. */
function AbsentRow({ row, names }: { readonly row: AgentRow; readonly names: Names }) {
  const { agent } = row;
  return (
    <li
      data-agent={agent.id}
      aria-label={agent.displayName}
      title={tilde(row.skillsFolder.path, names)}
      className="flex items-center gap-3 px-3.5 py-2"
    >
      <AgentLogo agent={agent.id} size={20} className="opacity-45" />
      <span className="min-w-0 flex-1 text-label-secondary">{agent.displayName}</span>
      <span className="text-callout text-label-disabled">Not installed</span>
    </li>
  );
}

/**
 * Settings' Agents section: the installed agents, each opening to where its skills go and how,
 * then every agent gandalf knows but did not find. A change plans configureAgent through the sync
 * sheet, so the links that move show before anything is written.
 */
export function Agents({ snapshot, flow, names, dispatch }: AgentsProps) {
  const rows = useMemo(() => agentRows(snapshot), [snapshot]);
  const plan = (intent: Intent) => dispatch({ kind: "plan", intent });
  const installed = rows.filter((row) => row.actionable);
  const absent = rows.filter((row) => !row.actionable);
  return (
    <>
      <div role="status" className="sticky left-0">
        {flow.kind === "applied" ? <AppliedSummary results={flow.results} names={names} /> : null}
      </div>
      <SettingsPage>
        <SettingsGroup title={`Installed · ${installed.length}`} label="Agents">
          {installed.map((row) => (
            <InstalledRow
              key={row.agent.id}
              row={row}
              skills={skillsOn(snapshot, row.agent.id)}
              names={names}
              plan={plan}
            />
          ))}
        </SettingsGroup>
        {absent.length === 0 ? null : (
          <SettingsGroup title={`Not installed · ${absent.length}`} label="Not installed">
            {absent.map((row) => (
              <AbsentRow key={row.agent.id} row={row} names={names} />
            ))}
          </SettingsGroup>
        )}
        <p className="px-1 text-callout text-label-secondary">
          gandalf puts library skills into each agent's skills folder. A changed folder takes effect
          in the same step, after you review it.
        </p>
      </SettingsPage>
    </>
  );
}
