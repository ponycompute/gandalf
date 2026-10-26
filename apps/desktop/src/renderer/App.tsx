import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Plan, SkillName, Snapshot } from "@gandalf/skills";
import type { AppError, Result } from "../shared/ipc";
import { Agents } from "./agents/Agents";
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
import { emptyInstall, Install, type InstallState } from "./install/Install";
import { invoke } from "./invoke";
import { lastScreen, saveScreen } from "./lastScreen";
import { focusRow, SkillMatrix, matrixAgents, type Toggle } from "./library/SkillMatrix";
import { SCREEN_ORDER, SCREENS, type Screen } from "./screens";
import { SKILL_DETAIL_TITLE, SkillDetail } from "./skill/SkillDetail";
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
  /** The library row Skill detail shows. */
  readonly selected: SkillName | null;
  readonly onSelect: (skill: SkillName | null) => void;
  /** The Install form as last left, so it survives a visit to another screen. */
  readonly install: InstallState;
  readonly onInstall: (update: (state: InstallState) => InstallState) => void;
}

function LibraryPane({
  snapshot,
  flow,
  names,
  windowFocused,
  dispatch,
  selected,
  onSelect,
}: PaneProps) {
  if (snapshot.skills.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-5 pb-toolbar-height text-center">
        <p className="text-large-title">The library is empty.</p>
        <p className="text-label-secondary">
          Install a skill from a folder or a git repository on the Install screen.
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
      <SkillMatrix
        snapshot={snapshot}
        windowFocused={windowFocused}
        selected={selected}
        onSelect={onSelect}
        onToggle={toggle}
      />
    </>
  );
}

function InstallPane({ install, onInstall, ...props }: PaneProps) {
  return <Install {...props} state={install} onState={onInstall} />;
}

const PANES = {
  library: LibraryPane,
  agents: Agents,
  discover: Discover,
  install: InstallPane,
} as const satisfies Record<Screen, (props: PaneProps) => ReactNode>;

/** The skill an install plan puts in the library, or tracks when the library has it already. */
function installedSkill(plan: Plan): SkillName | null {
  if (plan.intent.kind !== "install") return null;
  for (const step of plan.steps) {
    if (step.kind === "libraryAdd") return step.skill;
    if (step.kind !== "commitState") continue;
    const track = step.changes.find((change) => change.kind === "track");
    if (track !== undefined) return track.skill;
  }
  return null;
}

/** Where key focus goes once the screen shows what a write or a close left behind. */
type FocusRequest =
  | { readonly kind: "inspector" }
  | { readonly kind: "row"; readonly skill: SkillName }
  | { readonly kind: "sidebar" };

/** Focuses what `request` names, false when it is not on screen yet. */
function focusOn(request: FocusRequest): boolean {
  if (request.kind === "row") return focusRow(request.skill);
  const target =
    request.kind === "inspector"
      ? document.getElementById(SKILL_DETAIL_TITLE)
      : document.querySelector<HTMLElement>('nav[aria-label="Sections"] [aria-current="page"]');
  target?.focus();
  return target !== null;
}

/** The row after `skill` in the library, or the one before it when it is the last, or null. */
function neighbour(skills: readonly { readonly name: SkillName }[], skill: SkillName) {
  const at = skills.findIndex((view) => view.name === skill);
  if (at === -1) return null;
  return (skills[at + 1] ?? skills[at - 1])?.name ?? null;
}

/**
 * The library row Skill detail shows, and where focus goes after it changes. After an install
 * applies, the app goes to the library with the new skill selected, and focus goes into its detail,
 * since the button that started it is gone. After a remove applies, the selection clears with the
 * skill, and focus goes to the row that took its place. Closing the detail returns focus to its row.
 */
function useSelection(
  flow: Flow,
  load: Load,
  skills: readonly { readonly name: SkillName }[],
  setScreen: (screen: Screen) => void,
) {
  const [selected, setSelected] = useState<SkillName | null>(null);
  const [focus, setFocus] = useState<FocusRequest | null>(null);
  useEffect(() => {
    if (flow.kind !== "applied") return;
    const { intent } = flow.plan;
    if (intent.kind === "remove") {
      const next = neighbour(skills, intent.skill);
      setSelected((current) => (current === intent.skill ? null : current));
      setFocus(next === null ? { kind: "sidebar" } : { kind: "row", skill: next });
      return;
    }
    const installed = installedSkill(flow.plan);
    if (installed === null) return;
    setScreen("library");
    setSelected(installed);
    setFocus({ kind: "inspector" });
    // `skills` is read as it was when the apply landed; a snapshot arriving after must not run this.
  }, [flow, setScreen]);
  // Runs after the sheet has closed and given focus back, so this has the last word. A new skill's
  // detail shows only once the snapshot after the apply has it, so a request whose target is not
  // there yet waits for one more snapshot, then gives up.
  const waiting = useRef<Load | null>(null);
  useEffect(() => {
    if (focus === null) return;
    if (!focusOn(focus) && (waiting.current === null || waiting.current === load)) {
      waiting.current = load;
      return;
    }
    waiting.current = null;
    setFocus(null);
  }, [focus, load]);
  const close = () => {
    if (selected !== null) setFocus({ kind: "row", skill: selected });
    setSelected(null);
  };
  return { selected, setSelected, close };
}

/**
 * An install's plan always answers on the Install screen: when it lands while another screen
 * shows, the app goes back there, so a failure shows on its field and a preview opens over the
 * form it came from, never over a screen with nothing to do with it.
 */
function useInstallAnswer(flow: Flow, setScreen: (screen: Screen) => void): void {
  useEffect(() => {
    const intent =
      flow.kind === "previewing" ? flow.plan.intent : flow.kind === "failed" ? flow.intent : null;
    if (intent?.kind === "install" && !(flow.kind === "previewing" && flow.stale)) {
      setScreen("install");
    }
  }, [flow, setScreen]);
}

/**
 * Escape cancels a plan in progress wherever focus is, once nothing nearer took the key: the
 * inspector closes first, and a field or control that handles Escape keeps it.
 */
function useEscapeCancelsPlanning(flow: Flow, dispatch: (event: FlowEvent) => void): void {
  const planning = flow.kind === "planning";
  useEffect(() => {
    if (!planning) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      dispatch({ kind: "cancel" });
    };
    // Bubbling, after React's handlers on the root, which mark the key taken with preventDefault.
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [planning, dispatch]);
}

export function App() {
  const [screen, setScreen] = useState<Screen>(() => lastScreen(window.localStorage, SCREEN_ORDER));
  useEffect(() => saveScreen(window.localStorage, screen), [screen]);
  const { load, latest, refresh } = useSnapshot();
  const [flow, dispatch] = useWriteFlow(refresh);
  const { selected, setSelected, close } = useSelection(
    flow,
    load,
    load.kind === "ready" ? load.snapshot.skills : (latest?.skills ?? []),
    setScreen,
  );
  useInstallAnswer(flow, setScreen);
  useEscapeCancelsPlanning(flow, dispatch);
  const [install, setInstall] = useState<InstallState | null>(null);
  const sync = useSyncReadiness(load.kind === "ready" ? load.snapshot : null);
  const names = useMemo(
    () => (latest === null ? null : namesOf(latest, window.gandalf.home, window.gandalf.realHome)),
    [latest],
  );
  // A sheet takes key focus from the window under it, so its selections show inactive.
  const windowFocused = useWindowFocused() && sheetOf(flow) === null;
  const Pane = PANES[screen];
  const syncState = syncEnablement(sync);
  const detail =
    screen === "library" && load.kind === "ready"
      ? load.snapshot.skills.find((skill) => skill.name === selected)
      : undefined;
  return (
    <>
      <Window
        inspector={
          detail === undefined || names === null ? null : (
            <SkillDetail
              skill={detail}
              flow={flow}
              names={names}
              dispatch={dispatch}
              onClose={close}
            />
          )
        }
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
            selected={selected}
            onSelect={setSelected}
            install={install ?? emptyInstall(names.installed)}
            onInstall={(update) =>
              setInstall((current) => update(current ?? emptyInstall(names.installed)))
            }
          />
        ) : null}
      </Window>
      {names === null || latest === null ? null : (
        <SyncSheet flow={flow} snapshot={latest} names={names} dispatch={dispatch} />
      )}
    </>
  );
}
