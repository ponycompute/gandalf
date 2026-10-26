import { useMemo, useState } from "react";
import type { Intent, ModeSetting, Snapshot } from "@gandalf/skills";
import { AppliedSummary } from "../changes/AppliedSummary";
import type { Flow, FlowEvent } from "../changes/writeFlow";
import { AgentLogo } from "../design/AgentLogo";
import { Button } from "../design/Button";
import { PathText } from "../design/PathText";
import { SegmentedControl } from "../design/SegmentedControl";
import { invoke } from "../invoke";
import { agentReadError, gandalfDir, tilde, type Names } from "../vocabulary";
import {
  agentRows,
  configure,
  hasCustomFolder,
  insideGandalf,
  MODE_HINT,
  MODE_SEGMENTS,
  readersLine,
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

const ROW =
  "grid grid-cols-[minmax(152px,192px)_minmax(0,1fr)] gap-x-4 gap-y-2 border-t border-separator px-5 py-3";

interface RowProps {
  readonly row: AgentRow;
  readonly names: Names;
  readonly plan: (intent: Intent) => void;
}

function AgentRowView({ row, names, plan }: RowProps) {
  const { agent } = row;
  const [folderError, setFolderError] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);
  const custom = hasCustomFolder(agent);

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
    <li className={ROW} data-agent={agent.id} aria-label={agent.displayName}>
      <div className="flex min-w-0 items-start gap-2">
        <AgentLogo agent={agent.id} size={24} className="mt-0.5" />
        <div className="flex min-w-0 flex-col">
          <span className="font-semibold select-text">{agent.displayName}</span>
          <span className="text-callout text-label-secondary">
            {agent.installed ? "Installed" : "Not installed"}
          </span>
        </div>
      </div>
      <div className="flex min-w-0 flex-col gap-2">
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-callout">
          <dt className="text-label-secondary">Skills folder</dt>
          <dd className="flex min-w-0 flex-col">
            <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
              <Folder folder={row.skillsFolder} names={names} />
              {custom ? <span className="text-label-secondary">Custom</span> : null}
            </span>
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
        {row.actionable ? (
          <div className="flex flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
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
              <SegmentedControl<ModeSetting>
                label={`How gandalf puts skills in ${agent.displayName}'s folder`}
                segments={MODE_SEGMENTS}
                value={agent.mode}
                onChange={(mode) => {
                  if (mode !== agent.mode) plan(configure(agent, { mode }));
                }}
              />
            </div>
            {/* Auto is every agent's default, so only a chosen mode says what it does. */}
            {agent.mode === "auto" ? null : (
              <span className="text-callout text-label-secondary">{MODE_HINT[agent.mode]}</span>
            )}
          </div>
        ) : null}
      </div>
    </li>
  );
}

/**
 * Every agent gandalf knows, in registry order: where its skills go, what else it reads, and how
 * gandalf puts skills there. A change plans configureAgent through the sync sheet, so the links
 * that move show before anything is written. An agent that is not installed only shows its folders.
 */
export function Agents({ snapshot, flow, names, dispatch }: AgentsProps) {
  const rows = useMemo(() => agentRows(snapshot), [snapshot]);
  const plan = (intent: Intent) => dispatch({ kind: "plan", intent });
  return (
    <div className="pb-5">
      <div role="status" className="sticky left-0">
        {flow.kind === "applied" ? <AppliedSummary results={flow.results} names={names} /> : null}
      </div>
      <ul aria-label="Agents">
        {rows.map((row) => (
          <AgentRowView key={row.agent.id} row={row} names={names} plan={plan} />
        ))}
      </ul>
    </div>
  );
}
