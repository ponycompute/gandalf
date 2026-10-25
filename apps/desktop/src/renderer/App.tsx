import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Snapshot } from "@gandalf/skills";
import type { AppError, Result } from "../shared/ipc";
import { AppliedSummary } from "./changes/AppliedSummary";
import { SyncSheet, sheetOf } from "./changes/SyncSheet";
import { SYNC_ALL, syncEnablement, useSyncReadiness } from "./changes/syncReadiness";
import { useWriteFlow } from "./changes/useWriteFlow";
import type { Flow, FlowEvent } from "./changes/writeFlow";
import { Button } from "./design/Button";
import { SourceList } from "./design/SourceList";
import { Capsule, Toolbar } from "./design/Toolbar";
import { Window } from "./design/Window";
import { Discover } from "./discover/Discover";
import { ErrorBanner } from "./ErrorBanner";
import { invoke } from "./invoke";
import { SkillMatrix, matrixAgents, type Toggle } from "./library/SkillMatrix";
import { SCREENS, type Screen } from "./screens";
import { namesOf, type Names } from "./vocabulary";

export type Load =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly snapshot: Snapshot }
  | { readonly kind: "failed"; readonly error: AppError };

function loadOf(result: Result<Snapshot>): Load {
  return result.ok
    ? { kind: "ready", snapshot: result.value }
    : { kind: "failed", error: result.error };
}

interface Snapshots {
  readonly load: Load;
  /** The last snapshot that loaded, kept through a failed refresh so an open sheet can name things. */
  readonly latest: Snapshot | null;
  readonly refresh: () => void;
}

/**
 * Shows the newest snapshot. Each read is numbered when it starts and a push when it arrives, so a
 * read that started before a later one, or before a push, never replaces it.
 */
function useSnapshot(): Snapshots {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [latest, setLatest] = useState<Snapshot | null>(null);
  const counter = useRef({ next: 0, shown: -1 });
  const show = useCallback((order: number, result: Result<Snapshot>) => {
    if (order < counter.current.shown) return;
    counter.current.shown = order;
    setLoad(loadOf(result));
    if (result.ok) setLatest(result.value);
  }, []);
  const refresh = useCallback(() => {
    const order = counter.current.next++;
    void invoke(() => window.gandalf.snapshot()).then((result) => show(order, result));
  }, [show]);
  useEffect(() => {
    const unsubscribe = window.gandalf.onSnapshot((result) => show(counter.current.next++, result));
    refresh();
    return unsubscribe;
  }, [show, refresh]);
  return { load, latest, refresh };
}

function useWindowFocused(): boolean {
  const [focused, setFocused] = useState(() => document.hasFocus());
  useEffect(() => {
    const focus = () => setFocused(true);
    const blur = () => setFocused(false);
    window.addEventListener("focus", focus);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("focus", focus);
      window.removeEventListener("blur", blur);
    };
  }, []);
  return focused;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export function countLine(snapshot: Snapshot): string {
  const agents = matrixAgents(snapshot);
  return `${plural(snapshot.skills.length, "skill")} in ${plural(agents.length, "agent")}`;
}

interface PaneProps {
  readonly snapshot: Snapshot;
  readonly flow: Flow;
  readonly names: Names;
  readonly windowFocused: boolean;
  readonly dispatch: (event: FlowEvent) => void;
}

function LibraryPane({ snapshot, flow, names, windowFocused, dispatch }: PaneProps) {
  if (snapshot.skills.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-5 pb-toolbar-height text-center">
        <p className="text-large-title">The library is empty.</p>
        <p className="text-label-secondary">
          Install a skill from Terminal with gandalf skills install and a folder or git URL.
        </p>
      </div>
    );
  }
  const toggle = ({ skill, agent, enabled }: Toggle) =>
    dispatch({ kind: "plan", intent: { kind: "setEnabled", skill, enabled, agents: [agent] } });
  return (
    <>
      <div role="status" className="sticky left-0">
        {flow.kind === "applied" ? <AppliedSummary results={flow.results} names={names} /> : null}
      </div>
      <SkillMatrix snapshot={snapshot} windowFocused={windowFocused} onToggle={toggle} />
    </>
  );
}

const PANES = {
  library: LibraryPane,
  agents: () => null,
  discover: Discover,
  install: () => null,
} as const satisfies Record<Screen, (props: PaneProps) => ReactNode>;

export function App() {
  const [screen, setScreen] = useState<Screen>("library");
  const { load, latest, refresh } = useSnapshot();
  const [flow, dispatch] = useWriteFlow(refresh);
  const sync = useSyncReadiness(load.kind === "ready" ? load.snapshot : null);
  const names = useMemo(
    () => (latest === null ? null : namesOf(latest, window.gandalf.home)),
    [latest],
  );
  // A sheet takes key focus from the window under it, so its selections show inactive.
  const windowFocused = useWindowFocused() && sheetOf(flow) === null;
  const Pane = PANES[screen];
  const syncState = syncEnablement(sync);
  return (
    <>
      <Window
        sidebar={<SourceList current={screen} windowFocused={windowFocused} onSelect={setScreen} />}
        toolbar={
          <Toolbar
            title={SCREENS[screen].title}
            subtitle={
              load.kind === "ready" ? (
                <>
                  <span>{countLine(load.snapshot)}</span>
                  {syncState.reason === null ? null : <span> · {syncState.reason}</span>}
                </>
              ) : null
            }
          >
            <Capsule>
              <Button
                variant="primary"
                size="capsule"
                disabled={!syncState.enabled}
                onClick={() => dispatch({ kind: "plan", intent: SYNC_ALL })}
              >
                Sync
              </Button>
            </Capsule>
          </Toolbar>
        }
      >
        {load.kind === "failed" ? (
          <div className="p-5">
            <ErrorBanner error={load.error} />
          </div>
        ) : null}
        {load.kind === "ready" && names !== null ? (
          <Pane
            snapshot={load.snapshot}
            flow={flow}
            names={names}
            windowFocused={windowFocused}
            dispatch={dispatch}
          />
        ) : null}
      </Window>
      {names === null || latest === null ? null : (
        <SyncSheet flow={flow} snapshot={latest} names={names} dispatch={dispatch} />
      )}
    </>
  );
}
